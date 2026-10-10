import {
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  createSign,
} from "node:crypto";
import {
  getConfiguredKalshiSubaccount,
  verifyKalshiTradingKeyRestriction,
  verifyKalshiTradingKeyTradePermission,
} from "./kalshiAccountClient";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  forwardTestEngineTable,
  microLiveConfigTable,
  microLivePairBoundaryTable,
  microLiveFillTable,
  microLiveFeeVerificationTable,
  microLiveOrderTable,
  microLiveRunArchiveTable,
  microLiveSettlementTable,
} from "@workspace/db/schema";
import { db as dbInstance } from "@workspace/db";
import { reconstructMicroLivePositions } from "./microLivePosition";
import {
  feeEvidenceMatchesApproval,
  standingFeePolicyApprovalIsValid,
} from "./microLiveEntryFees";

const API_PREFIX = "/trade-api/v2";
const PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 15_000;

export type KalshiMutationGuardContext = {
  /**
   * Legacy caller-supplied status only. These fields are intentionally not
   * proof of authorization for POST or DELETE; a plain object is forgeable.
   */
  databaseEnabled: boolean;
  killSwitch: "OFF" | "ON";
  leaseHeld: boolean;
  reconciled: boolean;
};

export type KalshiLimitOrderRequest = {
  ticker: string;
  clientOrderId: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  priceDollars: string;
};

export type KalshiReduceOnlyExitRequest = Omit<KalshiLimitOrderRequest, "action"> & {
  /** Owned outcome, not the V2 book side. The price is in this outcome's dollars. */
  action: "sell";
};

export type KalshiOrder = {
  orderId: string;
  clientOrderId: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit";
  status: string;
  remainingCount: string;
  /** Authoritative exchange fill total when returned by the order endpoint. */
  filledCount: string | null;
  outcomeSide?: string | null;
  bookSide?: string | null;
};

export type KalshiFill = {
  fillId: string;
  tradeId: string | null;
  orderId: string | null;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: string;
  priceDollars: string;
  createdAt: string;
};

export type KalshiFillsPage = {
  fills: KalshiFill[];
  cursor: string | null;
};

export class KalshiTradingApiError extends Error {
  constructor(
    readonly type:
      | "NOT_CONFIGURED"
      | "INVALID_CREDENTIALS"
      | "NETWORK_ERROR"
      | "HTTP_ERROR"
      | "INVALID_JSON"
      | "INVALID_RESPONSE"
      | "MUTATION_GUARD_REJECTED",
    readonly status?: number,
  ) {
    super(status === undefined
      ? `Kalshi trading request failed (${type})`
      : `Kalshi trading request failed (${type}, HTTP ${status})`);
    this.name = "KalshiTradingApiError";
  }
}

type JsonObject = Record<string, unknown>;
type Credentials = { keyId: string; privateKey: string };
type SignedMethod = "GET" | "POST" | "DELETE";

export type KalshiTradingClientOptions = {
  /** Required by design: callers must explicitly provide the transport. */
  fetchImpl: typeof fetch;
  /** Injected only by isolated tests; real requests verify against key metadata. */
  verifySubaccount?: () => Promise<boolean>;
  /**
   * Verifies the dedicated MICRO_LIVE `(N, 2)` binding from persisted account
   * identity, restricted-key metadata, a fresh account snapshot and market
   * metadata. Production wiring is deliberately opt-in and fails closed.
   */
  verifyDedicatedShardTwoPair?: (
    request: KalshiShardTwoPairVerificationRequest,
  ) => Promise<KalshiShardTwoPairEvidence | null>;
};

export type KalshiShardTwoPairVerificationRequest = {
  subaccountNumber: number;
  exchangeIndex: 2;
  apiKeyId: string;
  marketTicker: string;
  runId: string;
  action: "buy" | "sell";
  authorizationMode: "final_post" | "recovery_get";
  requiredEvidenceDigest?: string;
  now: number;
};

export type KalshiShardTwoPairEvidence = {
  checkedAt: number;
  apiKeyId: string;
  restrictedKeySubaccount: number;
  persistedIdentity: {
    runId: string;
    subaccountNumber: number;
    exchangeIndex: number;
    apiKeyId: string;
  };
  fundingAnchor: {
    runId: string;
    subaccountNumber: number;
    exchangeIndex: number;
    transferId: string;
    transferredAt: number;
    amountMicros: string;
    initialBalanceMicros: string;
    evidenceDigest: string;
  };
  accountEvidence: {
    runId: string;
    subaccountNumber: number;
    exchangeIndex: number;
    capturedAt: number;
    complete: boolean;
    evidenceDigest: string;
  };
  marketEvidence: {
    ticker: string;
    exchangeIndex: number;
    capturedAt: number;
  };
  collateralProof: {
    status: "verified";
    proofKind: "collateral_reconciliation_only";
    authorization: "none";
    mode:
      | {
          kind: "final_post";
          action: "entry" | "exit";
          phase: "ENTRY_OPEN" | "EXIT_ONLY";
        }
      | { kind: "recovery_get" };
    runId: string;
    checkedAt: number;
    evidenceDigest: string;
    boundaryEvidenceDigest: string;
    configStateDigest: string;
    availableCashMicros: string;
    inventoryBalanceMicros: string;
    activityCashDeltaMicros: string;
    expectedAvailableCashMicros: string;
    restingEntryReserveMicros: string;
    filledBuyExposureMicros: string;
    reconciledFeeMicros: string;
  };
};
declare const kalshiSubmissionCapabilityBrand: unique symbol;
export type KalshiSubmissionCapability = {
  readonly [kalshiSubmissionCapabilityBrand]: true;
};

declare const kalshiCancellationCapabilityBrand: unique symbol;
export type KalshiCancellationCapability = {
  readonly [kalshiCancellationCapabilityBrand]: true;
};

export type KalshiSubmissionTransaction =
  Parameters<Parameters<typeof dbInstance.transaction>[0]>[0];

export type KalshiCancellationTransaction = KalshiSubmissionTransaction;

export type KalshiCancellationIdentity = {
  exchangeOrderId: string;
  localOrderId: string;
  clientOrderId: string;
  runId: string;
};

export type KalshiCancellationWitness = {
  runId: string;
  reconciled: boolean;
  reconciledAt: number;
  leaseOwner: string;
  leaseObservedAt: number;
  leaseExpiresAt: number;
  cancellationClaimedAt: number;
  pairRecoveryProof?: {
    checkedAt: number;
    evidenceDigest: string;
    configStateDigest: string;
    boundaryStateDigest: string;
    ledgerStateDigest: string;
  };
  isStillReconciled: () => boolean;
};

/** Isolated restart simulation only; unavailable outside NODE_ENV=test. */
export function resetKalshiCancellationAuthorizationStateForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Micro-live cancellation test reset is disabled outside tests");
  }
  issuedCancellationCapabilities = new WeakMap();
  issuedCancellationClaims = new Set();
}

type SubmissionWitness = {
  orderId: string;
  reconciled: boolean;
  reconciledAt: number;
  leaseOwner: string;
  leaseObservedAt: number;
  leaseExpiresAt: number;
  isStillReconciled: () => boolean;
};

type PrimaryCashPreflightIdentity = {
  orderId: string;
  runId: string;
  marketTicker: string;
  baselineDigest: string;
  baselineMicros: string;
  baselineAt: number;
};

const issuedCapabilities = new WeakMap<object, {
  canonicalInput: string;
  runId: string;
  subaccountNumber: number;
  consumed: boolean;
  validateWhileTransactionActive: () => Promise<boolean>;
}>();
let issuedCancellationCapabilities = new WeakMap<object, {
  identity: KalshiCancellationIdentity;
  runId: string;
  subaccountNumber: number;
  marketTicker: string;
  side: "yes" | "no";
  remainingContracts: number;
  pairRecoveryEvidenceDigest: string | null;
  consumed: boolean;
  validateCommittedState: () => Promise<boolean>;
}>();
let issuedCancellationClaims = new Set<string>();
let readinessTestOverride: ((now: number) => boolean) | null = null;
let cashPreflightTestOverride:
  ((identity: PrimaryCashPreflightIdentity, now: number) => boolean) | null = null;

/** Test-only process readiness simulation; unavailable outside NODE_ENV=test. */
export function setKalshiReadinessForTest(
  provider: ((now: number) => boolean) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Micro-live readiness test override is disabled outside tests");
  }
  readinessTestOverride = provider;
}

/** Test-only cash-preflight simulation; production/dev always reads microLive state. */
export function setKalshiCashPreflightForTest(
  provider: ((identity: PrimaryCashPreflightIdentity, now: number) => boolean) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Micro-live cash preflight test override is disabled outside tests");
  }
  cashPreflightTestOverride = provider;
}

async function processLocalReadinessIsCurrent(now: number): Promise<boolean> {
  if (process.env.NODE_ENV === "test" && readinessTestOverride) {
    return readinessTestOverride(now);
  }
  try {
    const microLive = await import("./microLive");
    return microLive.isMicroLiveReadinessCurrent(now);
  } catch {
    return false;
  }
}

async function processLocalCashPreflightIsCurrent(
  identity: PrimaryCashPreflightIdentity,
  now: number,
): Promise<boolean> {
  if (process.env.NODE_ENV === "test" && cashPreflightTestOverride) {
    return cashPreflightTestOverride(identity, now);
  }
  try {
    const microLive = await import("./microLive");
    return microLive.isMicroLiveCashPreflightCurrent(identity, now);
  } catch {
    return false;
  }
}

function submissionRuntimeAllowed(): boolean {
  return process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test" && readinessTestOverride !== null;
}

function canonicalOrderInput(input: KalshiLimitOrderRequest): string {
  return JSON.stringify([
    input.ticker, input.clientOrderId, input.side, input.action,
    input.count, input.priceDollars,
  ]);
}

function authorizationSnapshot(
  config: typeof microLiveConfigTable.$inferSelect,
  order: typeof microLiveOrderTable.$inferSelect,
  engine: typeof forwardTestEngineTable.$inferSelect,
  fee: typeof microLiveFeeVerificationTable.$inferSelect,
): string {
  return JSON.stringify([
    config.manualKillSwitch, config.microLiveProductionEnabled, config.liveExecutionEnabled,
    config.microLiveAccountingUnresolved, config.microLiveAccountMode,
    config.microLiveSelectedSubaccount, config.microLiveRunId, config.microLiveRunCapMicros,
    config.microLiveRunPhase, config.microLiveEntryAttempted, config.microLiveExitAttempted,
    config.microLiveRunApprovalId, config.microLiveRunApprovalDigest,
    config.microLiveReservedMicros, config.microLiveFeeApprovalApproved,
    config.microLivePrimaryCashBaselineMicros,
    config.microLivePrimaryCashBaselineRunId,
    config.microLivePrimaryCashBaselineAt?.getTime() ?? null,
    config.microLivePrimaryCashBaselineEvidenceDigest,
    config.microLiveFeeApprovalInvalidated, config.microLiveFeeApprovalId,
    config.microLiveFeeApprovalDigest, config.microLiveFeeArtifactStatus,
    order.id, order.status, order.action, order.clientOrderId, order.marketTicker,
    order.crossingKey, order.side, order.exitPositionId, order.microLiveRunId,
    order.requestedContracts, order.requestedLimitPrice, order.requestedStakeCents,
    order.reservedEntryFeeMicros, order.reservedExitFeeMicros,
    order.feeEvidenceFingerprint, order.feeEvidenceVerifiedAt?.getTime() ?? null,
    engine.enabled, engine.strategyVersion, engine.leaseOwner,
    engine.leaseExpiresAt?.getTime() ?? null,
    fee.status, fee.feeEvidenceFingerprint, fee.checkedAt?.getTime() ?? null,
  ]);
}

function primaryCashBaselineIsValid(
  config: typeof microLiveConfigTable.$inferSelect,
  runId: string,
  now: number,
): boolean {
  const cashMicros = config.microLivePrimaryCashBaselineMicros;
  const baselineRunId = config.microLivePrimaryCashBaselineRunId;
  const capturedAt = config.microLivePrimaryCashBaselineAt?.getTime();
  const digest = config.microLivePrimaryCashBaselineEvidenceDigest;
  return typeof cashMicros === "string" && /^(0|[1-9]\d*)$/.test(cashMicros) &&
    Number.isSafeInteger(Number(cashMicros)) &&
    baselineRunId === runId &&
    Number.isFinite(capturedAt) && capturedAt! > 0 && capturedAt! <= now &&
    config.microLiveRunArmedAt !== null &&
    typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest);
}

/**
 * Mint a one-use authorization only from the caller's final transaction.
 * The critical config/order/fee/lease values are independently read under
 * locks here; the witness is limited to process-local reconciliation evidence.
 */
export async function authorizeKalshiSubmission(
  tx: KalshiSubmissionTransaction,
  input: KalshiLimitOrderRequest,
  witness: SubmissionWitness,
  now = Date.now(),
): Promise<KalshiSubmissionCapability | null> {
  try {
    if (!submissionRuntimeAllowed() ||
        process.env.MICRO_LIVE_PRODUCTION_ENABLED !== "true" ||
        process.env.LIVE_EXECUTION_ENABLED !== "true" ||
        witness?.reconciled !== true ||
        !Number.isSafeInteger(witness.reconciledAt) ||
        now - witness.reconciledAt < 0 || now - witness.reconciledAt > 30_000 ||
        !Number.isSafeInteger(witness.leaseObservedAt) ||
        now - witness.leaseObservedAt < 0 || now - witness.leaseObservedAt > 15_000 ||
        !Number.isSafeInteger(witness.leaseExpiresAt) ||
        witness.leaseExpiresAt <= now ||
        typeof witness.isStillReconciled !== "function" ||
        !witness.isStillReconciled() ||
        typeof witness.leaseOwner !== "string" || !witness.leaseOwner.trim() ||
        !witness.orderId || input.action !== "buy" && input.action !== "sell") return null;
    if (!await processLocalReadinessIsCurrent(now)) return null;

    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1) as
      (typeof microLiveConfigTable.$inferSelect)[];
    const [order] = await tx.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, witness.orderId)).for("update").limit(1) as
      (typeof microLiveOrderTable.$inferSelect)[];
    const [engine] = await tx.select().from(forwardTestEngineTable)
      .where(eq(forwardTestEngineTable.id, "v1.3-paper")).for("update").limit(1) as
      (typeof forwardTestEngineTable.$inferSelect)[];
    const settlements = await tx.select({ positionId: microLiveSettlementTable.positionId })
      .from(microLiveSettlementTable).limit(1) as Array<{ positionId: string }>;

    const envMode = process.env.MICRO_LIVE_ACCOUNT_MODE?.trim() || "exclusive";
    const selectedAccount = selectedSubaccount();
    const accountModeValid = envMode === "primary_nonexclusive"
      ? selectedAccount === 0 && config?.microLiveAccountMode === "primary_nonexclusive" &&
        config.microLiveSelectedSubaccount === 0
      : envMode === "exclusive" && selectedAccount > 0 &&
        config?.microLiveAccountMode === "exclusive" &&
        config.microLiveSelectedSubaccount === selectedAccount;
    const runId = order?.microLiveRunId;
    const primary = config?.microLiveAccountMode === "primary_nonexclusive";
    const entry = order?.action === "buy";
    const approvedAt = config?.microLiveFeeApprovalApprovedAt?.getTime() ?? 0;
    const approval = config && config.microLiveFeeApprovalId &&
      config.microLiveFeeApprovalDigest && config.microLiveFeePolicyVersion &&
      config.microLiveFeeMaximumExposureMicros !== null &&
      config.microLiveFeeApprovedRunCapMicros !== null &&
      config.microLiveFeeApprovedBy ? {
        id: config.microLiveFeeApprovalId,
        digest: config.microLiveFeeApprovalDigest,
        approvedAt,
        policyVersion: config.microLiveFeePolicyVersion,
        maximumExposureMicros: config.microLiveFeeMaximumExposureMicros,
        approvedRunCapMicros: config.microLiveFeeApprovedRunCapMicros,
        approvedBy: config.microLiveFeeApprovedBy,
      } : null;
    const persistedApprovalValid = Boolean(config?.microLiveFeeApprovalApproved &&
      !config.microLiveFeeApprovalInvalidated &&
      config.microLiveFeeArtifactStatus === "verified" &&
      config.microLiveFeePolicyVersion === "micro-live-standing-fee-policy-v1" &&
      config.microLiveFeeApprovalSourceUrl === "https://kalshi.com/docs/kalshi-fee-schedule.pdf" &&
      config.microLiveFeeFormulaVersion === "standard-quadratic-0.07-v1" &&
      standingFeePolicyApprovalIsValid(approval, config?.microLiveRunCapMicros));
    if (!config || !order || !engine || settlements.length ||
        config.manualKillSwitch || !config.microLiveProductionEnabled ||
        !config.liveExecutionEnabled || config.microLiveAccountingUnresolved ||
        !accountModeValid || !persistedApprovalValid ||
        config.microLiveFeeApprovalId !== approval!.id ||
        config.microLiveFeeApprovalDigest !== approval!.digest ||
        engine.enabled !== true || engine.strategyVersion !== "V1.3" ||
        !engine.leaseOwner || engine.leaseOwner !== witness.leaseOwner ||
        !engine.leaseExpiresAt || engine.leaseExpiresAt.getTime() !== witness.leaseExpiresAt ||
        engine.leaseExpiresAt.getTime() <= now ||
        !runId || !config.microLiveRunId || runId !== config.microLiveRunId ||
        order.status !== "pending" || order.clientOrderId !== input.clientOrderId ||
        order.marketTicker !== input.ticker ||
        (order.side === "UP" ? "yes" : order.side === "DOWN" ? "no" : null) !== input.side ||
        order.action !== input.action || order.requestedContracts !== input.count ||
        Math.abs(order.requestedLimitPrice - Number(input.priceDollars)) > 0.0000001 ||
        order.feeEvidenceVerifiedAt === null || !order.feeEvidenceFingerprint ||
        !Number.isSafeInteger(order.reservedEntryFeeMicros) ||
        !Number.isSafeInteger(order.reservedExitFeeMicros) ||
        !feeEvidenceMatchesApproval(order.feeEvidenceFingerprint, approval!) ||
        now - order.feeEvidenceVerifiedAt.getTime() < 0 ||
        now - order.feeEvidenceVerifiedAt.getTime() > 15_000) return null;

    const primaryCashIdentity = {
      orderId: order.id,
      runId,
      marketTicker: order.marketTicker,
      baselineDigest: config.microLivePrimaryCashBaselineEvidenceDigest ?? "",
      baselineMicros: config.microLivePrimaryCashBaselineMicros ?? "",
      baselineAt: config.microLivePrimaryCashBaselineAt?.getTime() ?? 0,
    };
    if (primary && (!primaryCashBaselineIsValid(config, runId, now) ||
        !await processLocalCashPreflightIsCurrent(primaryCashIdentity, now))) return null;

    if (primary) {
      if (entry ? config.microLiveRunPhase !== "ENTRY_OPEN"
          : !["ENTRY_OPEN", "EXIT_ONLY"].includes(config.microLiveRunPhase)) return null;
      if (entry
        ? !config.microLiveEntryAttempted || config.microLiveExitAttempted
        : !config.microLiveEntryAttempted || !config.microLiveExitAttempted) return null;
      if (!config.microLiveRunArmedAt ||
          entry && config.microLiveRunDeadline !== null &&
            config.microLiveRunDeadline.getTime() <= now ||
          config.microLiveRunApprovalId !== approval!.id ||
          config.microLiveRunApprovalDigest !== approval!.digest) return null;
      const archives = await tx.select({
        priorRunId: microLiveRunArchiveTable.priorRunId,
        successorRunId: microLiveRunArchiveTable.successorRunId,
      }).from(microLiveRunArchiveTable) as unknown as
        Array<{ priorRunId: string; successorRunId: string }>;
      if (archives.some((archive) => archive.priorRunId === runId)) return null;
      const successors = archives.filter((archive) => archive.successorRunId === runId);
      if (successors.length > 1 ||
          (successors.length === 1
            ? config.microLiveRunCapMicros !== 5_000_000
            : config.microLiveRunCapMicros !== 1_000_000)) return null;
    }

    const approvalCap = Math.min(config.microLiveRunCapMicros,
      approval!.maximumExposureMicros, approval!.approvedRunCapMicros);
    const entryFee = order.reservedEntryFeeMicros!;
    const exitFee = order.reservedExitFeeMicros!;
    const orderGross = order.requestedStakeCents * 10_000;
    if (!Number.isSafeInteger(orderGross) ||
        orderGross + entryFee + exitFee > approvalCap ||
        entry && (order.requestedStakeCents > config.maxSingleOrderRiskCents ||
          order.requestedStakeCents > config.maxLiveBankrollCents ||
          order.requestedStakeCents > config.maxCumulativeReservedCents))
      return null;
    const currentOrders = await tx.select().from(microLiveOrderTable) as unknown as
      Array<typeof microLiveOrderTable.$inferSelect>;
    const currentFills = await tx.select().from(microLiveFillTable) as unknown as
      Array<typeof microLiveFillTable.$inferSelect>;
    const ledger = reconstructMicroLivePositions({
      orders: currentOrders,
      fills: currentFills,
    });
    if (ledger.anomalies.length) return null;
    const matchingClaims = currentOrders.filter((candidate) =>
      candidate.id === order.id && candidate.clientOrderId === input.clientOrderId &&
      candidate.action === order.action && candidate.microLiveRunId === runId);
    if (matchingClaims.length !== 1 ||
        currentOrders.filter((candidate) =>
          candidate.clientOrderId === input.clientOrderId).length !== 1 ||
        !entry && currentOrders.filter((candidate) =>
          candidate.action === "sell" && candidate.microLiveRunId === runId).length !== 1)
      return null;
    if (primary && entry) {
      const runExposureMicros = currentOrders
        .filter((candidate) => candidate.action === "buy" &&
          candidate.microLiveRunId === runId && candidate.status !== "rejected")
        .reduce((total, candidate) => total +
          candidate.requestedStakeCents * 10_000 +
          (candidate.reservedEntryFeeMicros ?? Number.NaN) +
          (candidate.reservedExitFeeMicros ?? Number.NaN), 0);
      if (!Number.isSafeInteger(runExposureMicros) ||
          runExposureMicros !== config.microLiveReservedMicros ||
          runExposureMicros > approvalCap) return null;
    }
    if (!entry) {
      const position = ledger.positions.find((candidate) =>
        candidate.positionId === order.exitPositionId);
      if (!position || position.marketTicker !== order.marketTicker ||
          position.side !== order.side || position.closed ||
          position.contractsBought - position.contractsSold < order.requestedContracts ||
          position.outstandingSellContracts !== order.requestedContracts) return null;
    }
    if (!entry) {
      const [sourceBuy] = await tx.select().from(microLiveOrderTable)
        .where(and(
          eq(microLiveOrderTable.action, "buy"),
          eq(microLiveOrderTable.marketTicker, order.marketTicker),
          eq(microLiveOrderTable.crossingKey, order.crossingKey),
          eq(microLiveOrderTable.microLiveRunId, order.microLiveRunId ?? ""),
        )).limit(1) as
        (typeof microLiveOrderTable.$inferSelect)[];
      if (!sourceBuy || sourceBuy.status === "rejected" ||
          sourceBuy.marketTicker !== order.marketTicker ||
          sourceBuy.microLiveRunId !== order.microLiveRunId ||
          (sourceBuy.positionId ?? `position:${sourceBuy.marketTicker}:${sourceBuy.crossingKey}`) !==
            order.exitPositionId ||
          sourceBuy.reservedEntryFeeMicros === null ||
          sourceBuy.reservedExitFeeMicros === null ||
          exitFee > sourceBuy.reservedExitFeeMicros ||
          sourceBuy.requestedStakeCents * 10_000 +
            sourceBuy.reservedEntryFeeMicros + exitFee > approvalCap)
        return null;
    }
    const [verifiedFee] = await tx.select().from(microLiveFeeVerificationTable)
      .where(and(
        eq(microLiveFeeVerificationTable.approvalId, approval!.id),
        eq(microLiveFeeVerificationTable.approvalDigest, approval!.digest),
        eq(microLiveFeeVerificationTable.policyVersion, approval!.policyVersion),
        eq(microLiveFeeVerificationTable.sourceUrl, config.microLiveFeeApprovalSourceUrl!),
        eq(microLiveFeeVerificationTable.formulaVersion, config.microLiveFeeFormulaVersion!),
      )).for("update").limit(1) as
      (typeof microLiveFeeVerificationTable.$inferSelect)[];
    if (!verifiedFee || verifiedFee.status !== "verified" ||
        verifiedFee.feeEvidenceFingerprint !== order.feeEvidenceFingerprint ||
        !verifiedFee.checkedAt ||
        verifiedFee.checkedAt.getTime() !== order.feeEvidenceVerifiedAt.getTime() ||
        now - verifiedFee.checkedAt.getTime() < 0 ||
        now - verifiedFee.checkedAt.getTime() > 15_000) return null;

    const authorizedSnapshot = authorizationSnapshot(config, order, engine, verifiedFee);
    const validateWhileTransactionActive = async (): Promise<boolean> => {
      try {
        const validationNow = Date.now();
        if (!submissionRuntimeAllowed() ||
            process.env.MICRO_LIVE_PRODUCTION_ENABLED !== "true" ||
            process.env.LIVE_EXECUTION_ENABLED !== "true" ||
            !witness.isStillReconciled() ||
            !await processLocalReadinessIsCurrent(validationNow) ||
            validationNow - witness.reconciledAt < 0 ||
            validationNow - witness.reconciledAt > 30_000 ||
            validationNow - witness.leaseObservedAt < 0 ||
            validationNow - witness.leaseObservedAt > 15_000 ||
            witness.leaseExpiresAt <= validationNow) return false;
        const [latestConfig] = await tx.select().from(microLiveConfigTable)
          .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1) as
          (typeof microLiveConfigTable.$inferSelect)[];
        const [latestOrder] = await tx.select().from(microLiveOrderTable)
          .where(eq(microLiveOrderTable.id, witness.orderId)).for("update").limit(1) as
          (typeof microLiveOrderTable.$inferSelect)[];
        const [latestEngine] = await tx.select().from(forwardTestEngineTable)
          .where(eq(forwardTestEngineTable.id, "v1.3-paper")).for("update").limit(1) as
          (typeof forwardTestEngineTable.$inferSelect)[];
        const [latestFee] = await tx.select().from(microLiveFeeVerificationTable)
          .where(eq(microLiveFeeVerificationTable.approvalId, approval!.id))
          .for("update").limit(1) as
          (typeof microLiveFeeVerificationTable.$inferSelect)[];
        const latestSettlements = await tx.select({
          positionId: microLiveSettlementTable.positionId,
        }).from(microLiveSettlementTable).limit(1);
        return Boolean(latestConfig && latestOrder && latestEngine && latestFee &&
          !latestSettlements.length &&
          authorizationSnapshot(latestConfig, latestOrder, latestEngine, latestFee) ===
            authorizedSnapshot &&
          (!primary || primaryCashBaselineIsValid(latestConfig, runId!, validationNow) &&
            await processLocalCashPreflightIsCurrent({
              orderId: latestOrder.id,
              runId: latestOrder.microLiveRunId ?? "",
              marketTicker: latestOrder.marketTicker,
              baselineDigest: latestConfig.microLivePrimaryCashBaselineEvidenceDigest ?? "",
              baselineMicros: latestConfig.microLivePrimaryCashBaselineMicros ?? "",
              baselineAt: latestConfig.microLivePrimaryCashBaselineAt?.getTime() ?? 0,
            }, validationNow)) &&
          latestEngine.leaseOwner === witness.leaseOwner &&
          latestEngine.leaseExpiresAt &&
          latestEngine.leaseExpiresAt.getTime() > Date.now() &&
          latestEngine.leaseExpiresAt.getTime() === witness.leaseExpiresAt);
      } catch {
        return false;
      }
    };
    const capability = Object.freeze({});
    issuedCapabilities.set(capability, {
      canonicalInput: canonicalOrderInput(input),
      runId,
      subaccountNumber: selectedAccount,
      consumed: false,
      validateWhileTransactionActive,
    });
    return capability as KalshiSubmissionCapability;
  } catch {
    return null;
  }
}

function cancellationRuntimeAllowed(): boolean {
  return process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test" && readinessTestOverride !== null;
}

function cancellationWitnessIsFresh(witness: KalshiCancellationWitness, now: number): boolean {
  return witness?.reconciled === true &&
    Number.isSafeInteger(witness.reconciledAt) &&
    now - witness.reconciledAt >= 0 && now - witness.reconciledAt <= 30_000 &&
    Number.isSafeInteger(witness.leaseObservedAt) &&
    now - witness.leaseObservedAt >= 0 && now - witness.leaseObservedAt <= 15_000 &&
    Number.isSafeInteger(witness.leaseExpiresAt) && witness.leaseExpiresAt > now &&
    Number.isSafeInteger(witness.cancellationClaimedAt) &&
    now - witness.cancellationClaimedAt >= 0 &&
    now - witness.cancellationClaimedAt <= 30_000 &&
    typeof witness.leaseOwner === "string" && !!witness.leaseOwner.trim() &&
    typeof witness.isStillReconciled === "function" && witness.isStillReconciled();
}

function digestCancellationState(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cancellationLedgerDigest(
  orders: (typeof microLiveOrderTable.$inferSelect)[],
  fills: (typeof microLiveFillTable.$inferSelect)[],
  settlements: (typeof microLiveSettlementTable.$inferSelect)[],
  localOrderId: string,
): string {
  return digestCancellationState({
    orders: orders.map((order) => order.id === localOrderId
      ? { ...order, cancellationAuthorizedAt: null } : order)
      .sort((a, b) => a.id.localeCompare(b.id)),
    fills: [...fills].sort((a, b) => a.exchangeFillId.localeCompare(b.exchangeFillId)),
    settlements: [...settlements].sort((a, b) =>
      a.positionId.localeCompare(b.positionId)),
  });
}

function cancellationPersistedStateIsValid(
  config: typeof microLiveConfigTable.$inferSelect,
  order: typeof microLiveOrderTable.$inferSelect,
  engine: typeof forwardTestEngineTable.$inferSelect,
  identity: KalshiCancellationIdentity,
  witness: KalshiCancellationWitness,
  now: number,
  expectedAuthorizedAt: number | null = null,
): boolean {
  let subaccount: number;
  try {
    subaccount = selectedSubaccount();
  } catch {
    return false;
  }
  const envMode = process.env.MICRO_LIVE_ACCOUNT_MODE?.trim() || "exclusive";
  const accountBindingValid = envMode === "primary_nonexclusive"
    ? subaccount === 0 && config.microLiveAccountMode === "primary_nonexclusive" &&
      config.microLiveSelectedSubaccount === 0
    : envMode === "exclusive" && subaccount > 0 &&
      config.microLiveAccountMode === "exclusive" &&
      config.microLiveSelectedSubaccount === subaccount;
  const claimedAt = order.cancellationAttemptedAt?.getTime();
  const authorizedAt = order.cancellationAuthorizedAt?.getTime() ?? null;
  const pairRecovery = witness.pairRecoveryProof;
  const dedicatedPair = config.microLiveSelectedExchangeIndex === 2;
  const pairRecoveryValid = !dedicatedPair || Boolean(
    config.microLiveRunPhase === "FROZEN" &&
    !!config.microLiveRunFreezeReason &&
    config.microLiveExitAttempted &&
    pairRecovery &&
    Number.isSafeInteger(pairRecovery.checkedAt) &&
    now - pairRecovery.checkedAt >= 0 && now - pairRecovery.checkedAt <= 5_000 &&
    /^[0-9a-f]{64}$/.test(pairRecovery.evidenceDigest) &&
    /^[0-9a-f]{64}$/.test(pairRecovery.configStateDigest) &&
    /^[0-9a-f]{64}$/.test(pairRecovery.boundaryStateDigest) &&
    /^[0-9a-f]{64}$/.test(pairRecovery.ledgerStateDigest));
  const frozen = config.manualKillSwitch &&
    !config.microLiveProductionEnabled && !config.liveExecutionEnabled;
  return cancellationRuntimeAllowed() &&
    cancellationWitnessIsFresh(witness, now) &&
    accountBindingValid &&
    frozen &&
    pairRecoveryValid &&
    (config.microLiveAccountMode !== "primary_nonexclusive" ||
      config.microLiveRunPhase === "FROZEN" && !!config.microLiveRunFreezeReason) &&
    config.microLiveRunId === identity.runId &&
    order.microLiveRunId === identity.runId &&
    order.id === identity.localOrderId &&
    order.exchangeOrderId === identity.exchangeOrderId &&
    order.clientOrderId === identity.clientOrderId &&
    order.action === "sell" && order.intent === "exit" &&
    order.triggerType === "EXIT" &&
    !!order.marketTicker.trim() && !!order.exitPositionId?.trim() &&
    (order.side === "UP" || order.side === "DOWN") &&
    ["pending", "partial", "unknown"].includes(order.status) &&
    order.remainingContracts > 0 &&
    Number.isSafeInteger(claimedAt) &&
    claimedAt === witness.cancellationClaimedAt &&
    now - claimedAt! >= 0 && now - claimedAt! <= 30_000 &&
    authorizedAt === expectedAuthorizedAt &&
    engine.enabled === true && engine.strategyVersion === "V1.3" &&
    engine.leaseOwner === witness.leaseOwner &&
    engine.leaseExpiresAt?.getTime() === witness.leaseExpiresAt &&
    engine.leaseExpiresAt.getTime() > now;
}

/**
 * Mint a one-use DELETE authorization from the caller's final locked
 * transaction. The durable cancellationAttemptedAt claim must already exist
 * and cancellationAuthorizedAt must still be null;
 * all persisted identities, frozen gates, account binding, and lease are
 * independently re-read and locked here. POST authorization remains separate.
 */
export async function authorizeKalshiCancellation(
  tx: KalshiCancellationTransaction,
  identity: KalshiCancellationIdentity,
  witness: KalshiCancellationWitness,
  now = Date.now(),
): Promise<KalshiCancellationCapability | null> {
  try {
    if (!cancellationRuntimeAllowed() ||
        !Number.isSafeInteger(now) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(identity.exchangeOrderId) ||
        !identity.localOrderId.trim() || !identity.clientOrderId.trim() ||
        !identity.runId.trim() || !cancellationWitnessIsFresh(witness, now) ||
        witness.runId !== identity.runId) return null;

    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1) as
      (typeof microLiveConfigTable.$inferSelect)[];
    let pairStateValid = true;
    if (config?.microLiveSelectedExchangeIndex === 2) {
      const [boundary] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(
          microLivePairBoundaryTable.subaccountNumber,
          config.microLiveSelectedSubaccount!,
        )).for("update").limit(1) as
        (typeof microLivePairBoundaryTable.$inferSelect)[];
      await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
        ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
      const [orders, fills, settlements] = await Promise.all([
        tx.select().from(microLiveOrderTable),
        tx.select().from(microLiveFillTable),
        tx.select().from(microLiveSettlementTable),
      ]);
      const pairProof = witness.pairRecoveryProof;
      pairStateValid = Boolean(boundary && pairProof &&
        boundary.state === "initialized" && !boundary.ambiguityFrozenAt &&
        boundary.initializedRunId === identity.runId &&
        digestCancellationState(config) === pairProof.configStateDigest &&
        digestCancellationState(boundary) === pairProof.boundaryStateDigest &&
        cancellationLedgerDigest(orders, fills, settlements, identity.localOrderId) ===
          pairProof.ledgerStateDigest);
    }
    const [order] = await tx.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, identity.localOrderId)).for("update").limit(1) as
      (typeof microLiveOrderTable.$inferSelect)[];
    const [engine] = await tx.select().from(forwardTestEngineTable)
      .where(eq(forwardTestEngineTable.id, "v1.3-paper")).for("update").limit(1) as
      (typeof forwardTestEngineTable.$inferSelect)[];
    if (!config || !order || !engine || !pairStateValid ||
        !cancellationPersistedStateIsValid(config, order, engine, identity, witness, now))
      return null;

    const claimKey = JSON.stringify([
      identity.localOrderId, identity.exchangeOrderId, identity.clientOrderId,
      identity.runId,
    ]);
    if (issuedCancellationClaims.has(claimKey)) return null;
    const [claimed] = await tx.update(microLiveOrderTable).set({
      cancellationAuthorizedAt: new Date(now),
    }).where(and(
      eq(microLiveOrderTable.id, identity.localOrderId),
      eq(microLiveOrderTable.exchangeOrderId, identity.exchangeOrderId),
      eq(microLiveOrderTable.clientOrderId, identity.clientOrderId),
      eq(microLiveOrderTable.microLiveRunId, identity.runId),
      eq(microLiveOrderTable.cancellationAttemptedAt, order.cancellationAttemptedAt!),
      isNull(microLiveOrderTable.cancellationAuthorizedAt),
    )).returning({ id: microLiveOrderTable.id }) as Array<{ id: string }>;
    if (!claimed) return null;
    const authorizedOrder = {
      ...order,
      cancellationAuthorizedAt: new Date(now),
    };
    const snapshotFor = (
      snapshotConfig: typeof microLiveConfigTable.$inferSelect,
      snapshotOrder: typeof microLiveOrderTable.$inferSelect,
      snapshotEngine: typeof forwardTestEngineTable.$inferSelect,
    ) => JSON.stringify([
      snapshotConfig.manualKillSwitch, snapshotConfig.microLiveProductionEnabled,
      snapshotConfig.liveExecutionEnabled, snapshotConfig.microLiveAccountingUnresolved,
      snapshotConfig.microLiveAccountMode, snapshotConfig.microLiveSelectedSubaccount,
      snapshotConfig.microLiveRunId, snapshotConfig.microLiveRunPhase,
      snapshotConfig.microLiveRunFreezeReason,
      snapshotOrder.id, snapshotOrder.exchangeOrderId, snapshotOrder.clientOrderId,
      snapshotOrder.marketTicker, snapshotOrder.side, snapshotOrder.exitPositionId,
      snapshotOrder.microLiveRunId, snapshotOrder.action, snapshotOrder.intent,
      snapshotOrder.triggerType, snapshotOrder.status, snapshotOrder.remainingContracts,
      snapshotOrder.cancellationAttemptedAt?.getTime() ?? null,
      snapshotOrder.cancellationAuthorizedAt?.getTime() ?? null,
      snapshotEngine.enabled, snapshotEngine.strategyVersion, snapshotEngine.leaseOwner,
      snapshotEngine.leaseExpiresAt?.getTime() ?? null,
    ]);
    const snapshot = snapshotFor(config, authorizedOrder, engine);
    const validateCommittedState = async (): Promise<boolean> => {
      try {
        const validationNow = Date.now();
        if (!cancellationRuntimeAllowed() ||
            !cancellationWitnessIsFresh(witness, validationNow)) return false;
        const readState = async (readTx: KalshiCancellationTransaction) => {
          const [latestConfig] = await readTx.select().from(microLiveConfigTable)
            .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1) as
            (typeof microLiveConfigTable.$inferSelect)[];
          let pairStateValid = true;
          if (latestConfig?.microLiveSelectedExchangeIndex === 2) {
            const [latestBoundary] = await readTx.select().from(microLivePairBoundaryTable)
              .where(eq(
                microLivePairBoundaryTable.subaccountNumber,
                latestConfig.microLiveSelectedSubaccount!,
              )).for("update").limit(1) as
              (typeof microLivePairBoundaryTable.$inferSelect)[];
            await readTx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
              ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
            const [orders, fills, settlements] = await Promise.all([
              readTx.select().from(microLiveOrderTable),
              readTx.select().from(microLiveFillTable),
              readTx.select().from(microLiveSettlementTable),
            ]);
            const pairProof = witness.pairRecoveryProof;
            pairStateValid = Boolean(latestBoundary && pairProof &&
              latestBoundary.state === "initialized" && !latestBoundary.ambiguityFrozenAt &&
              latestBoundary.initializedRunId === identity.runId &&
              digestCancellationState(latestConfig) === pairProof.configStateDigest &&
              digestCancellationState(latestBoundary) === pairProof.boundaryStateDigest &&
              cancellationLedgerDigest(orders, fills, settlements, identity.localOrderId) ===
                pairProof.ledgerStateDigest);
          }
          const [latestOrder] = await readTx.select().from(microLiveOrderTable)
            .where(eq(microLiveOrderTable.id, identity.localOrderId)).for("update").limit(1) as
            (typeof microLiveOrderTable.$inferSelect)[];
          const [latestEngine] = await readTx.select().from(forwardTestEngineTable)
            .where(eq(forwardTestEngineTable.id, "v1.3-paper")).for("update").limit(1) as
            (typeof forwardTestEngineTable.$inferSelect)[];
          if (!latestConfig || !latestOrder || !latestEngine || !pairStateValid ||
              !cancellationPersistedStateIsValid(
                latestConfig, latestOrder, latestEngine, identity,
                witness, validationNow, now,
              )) return false;
          return snapshotFor(latestConfig, latestOrder, latestEngine) === snapshot;
        };
        // Production always re-reads committed state in a fresh transaction.
        // The old transaction object is used only by unit tests' isolated fake DB.
        return process.env.NODE_ENV === "test"
          ? await readState(tx)
          : await dbInstance.transaction(readState);
      } catch {
        return false;
      }
    };
    const capability = Object.freeze({});
    issuedCancellationClaims.add(claimKey);
    issuedCancellationCapabilities.set(capability, {
      identity: { ...identity },
      runId: identity.runId,
      subaccountNumber: config.microLiveSelectedSubaccount!,
      marketTicker: authorizedOrder.marketTicker,
      side: authorizedOrder.side === "UP" ? "yes" : "no",
      remainingContracts: authorizedOrder.remainingContracts,
      pairRecoveryEvidenceDigest: witness.pairRecoveryProof?.evidenceDigest ?? null,
      consumed: false,
      validateCommittedState,
    });
    return capability as KalshiCancellationCapability;
  } catch {
    return null;
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  return value as JsonObject;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  const result = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(result) || !Number.isFinite(Number(result))) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  return result;
}

function credentials(): Credentials {
  const keyId = process.env.KALSHI_API_KEY_ID?.trim();
  const secret = process.env.KALSHI_API_PRIVATE_KEY?.trim();
  if (!keyId || !secret) throw new KalshiTradingApiError("NOT_CONFIGURED");
  const privateKey = secret.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  return { keyId, privateKey };
}

function selectedSubaccount(): number {
  try {
    return getConfiguredKalshiSubaccount();
  } catch {
    throw new KalshiTradingApiError("NOT_CONFIGURED");
  }
}

type AccountMode = "exclusive" | "primary_nonexclusive";

function selectedAccountMode(subaccount: number): AccountMode | null {
  const configuredMode = process.env.MICRO_LIVE_ACCOUNT_MODE?.trim();
  if (configuredMode === "primary_nonexclusive") {
    return subaccount === 0 ? "primary_nonexclusive" : null;
  }
  if (configuredMode !== undefined && configuredMode !== "" &&
      configuredMode !== "exclusive") return null;
  return subaccount > 0 ? "exclusive" : null;
}

function timestampIsFresh(value: number, now: number, maxAgeMs: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= now &&
    now - value <= maxAgeMs;
}

async function requireDedicatedShardTwoPair(
  options: KalshiTradingClientOptions,
  input: {
    subaccountNumber: number;
    apiKeyId: string;
    marketTicker: string;
    runId: string;
    action: "buy" | "sell";
    authorizationMode?: "final_post" | "recovery_get";
    requiredEvidenceDigest?: string;
  },
  now = Date.now(),
): Promise<void> {
  const reject = (): never => {
    throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
  };
  if (!Number.isSafeInteger(input.subaccountNumber) ||
      input.subaccountNumber < 1 || input.subaccountNumber > 63 ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(input.marketTicker) ||
      !input.runId.trim()) reject();
  const verify = options.verifyDedicatedShardTwoPair;
  if (typeof verify !== "function") return reject();
  let evidence: KalshiShardTwoPairEvidence | null;
  try {
    evidence = await verify({
      subaccountNumber: input.subaccountNumber,
      exchangeIndex: 2,
      apiKeyId: input.apiKeyId,
      marketTicker: input.marketTicker,
      runId: input.runId,
      action: input.action,
      authorizationMode: input.authorizationMode ?? "final_post",
      requiredEvidenceDigest: input.requiredEvidenceDigest,
      now,
    });
  } catch {
    return reject();
  }
  if (!evidence || !timestampIsFresh(evidence.checkedAt, now, 5_000) ||
      evidence.apiKeyId !== input.apiKeyId ||
      evidence.restrictedKeySubaccount !== input.subaccountNumber ||
      evidence.persistedIdentity?.runId !== input.runId ||
      evidence.persistedIdentity?.subaccountNumber !== input.subaccountNumber ||
      evidence.persistedIdentity?.exchangeIndex !== 2 ||
      evidence.persistedIdentity?.apiKeyId !== input.apiKeyId ||
      evidence.fundingAnchor?.runId !== input.runId ||
      evidence.fundingAnchor?.subaccountNumber !== input.subaccountNumber ||
      evidence.fundingAnchor?.exchangeIndex !== 2 ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(evidence.fundingAnchor?.transferId ?? "") ||
      !Number.isSafeInteger(evidence.fundingAnchor?.transferredAt) ||
      evidence.fundingAnchor.transferredAt <= 0 ||
      evidence.fundingAnchor.transferredAt > now ||
      evidence.fundingAnchor.amountMicros !== "25000000" ||
      !/^(0|[1-9][0-9]*)$/.test(evidence.fundingAnchor.initialBalanceMicros) ||
      evidence.fundingAnchor.initialBalanceMicros !== "25000000" ||
      !/^[0-9a-f]{64}$/.test(evidence.fundingAnchor.evidenceDigest) ||
      evidence.accountEvidence?.runId !== input.runId ||
      evidence.accountEvidence?.subaccountNumber !== input.subaccountNumber ||
      evidence.accountEvidence?.exchangeIndex !== 2 ||
      evidence.accountEvidence?.complete !== true ||
      !timestampIsFresh(evidence.accountEvidence.capturedAt, now, 5_000) ||
      !/^[0-9a-f]{64}$/.test(evidence.accountEvidence.evidenceDigest) ||
      evidence.marketEvidence?.ticker !== input.marketTicker ||
      evidence.marketEvidence?.exchangeIndex !== 2 ||
      !timestampIsFresh(evidence.marketEvidence.capturedAt, now, 5_000) ||
      evidence.collateralProof?.status !== "verified" ||
      evidence.collateralProof.proofKind !== "collateral_reconciliation_only" ||
      evidence.collateralProof.authorization !== "none" ||
      evidence.collateralProof.runId !== input.runId ||
      !timestampIsFresh(evidence.collateralProof.checkedAt, now, 5_000) ||
      !/^[0-9a-f]{64}$/.test(evidence.collateralProof.evidenceDigest) ||
      !/^[0-9a-f]{64}$/.test(evidence.collateralProof.boundaryEvidenceDigest) ||
      !/^[0-9a-f]{64}$/.test(evidence.collateralProof.configStateDigest) ||
      !/^(0|[1-9]\d*)$/.test(evidence.collateralProof.availableCashMicros) ||
      !/^(0|[1-9]\d*)$/.test(evidence.collateralProof.inventoryBalanceMicros) ||
      !/^-?(0|[1-9]\d*)$/.test(evidence.collateralProof.activityCashDeltaMicros) ||
      !/^-?(0|[1-9]\d*)$/.test(evidence.collateralProof.expectedAvailableCashMicros) ||
      !/^(0|[1-9]\d*)$/.test(evidence.collateralProof.restingEntryReserveMicros) ||
      !/^(0|[1-9]\d*)$/.test(evidence.collateralProof.filledBuyExposureMicros) ||
      !/^(0|[1-9]\d*)$/.test(evidence.collateralProof.reconciledFeeMicros) ||
       evidence.collateralProof.mode?.kind !== (input.authorizationMode ?? "final_post") ||
       input.requiredEvidenceDigest !== undefined &&
         evidence.collateralProof.evidenceDigest !== input.requiredEvidenceDigest ||
       (input.authorizationMode ?? "final_post") === "final_post" &&
         (evidence.collateralProof.mode?.kind !== "final_post" ||
          evidence.collateralProof.mode.action !==
            (input.action === "buy" ? "entry" : "exit") ||
          !["ENTRY_OPEN", "EXIT_ONLY"].includes(evidence.collateralProof.mode.phase)) ||
       (input.authorizationMode === "recovery_get" &&
         (input.action !== "sell" || !input.requiredEvidenceDigest))) {
    reject();
  }
  return;
}

function orderResponseMatchesDedicatedPair(value: unknown, subaccountNumber: number): boolean {
  const order = value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
  const orderSubaccount = order?.subaccount_number ?? order?.subaccount;
  return order !== null && order.exchange_index === 2 &&
    orderSubaccount === subaccountNumber;
}

function baseUrl(): string {
  const environment = process.env.KALSHI_API_ENVIRONMENT ?? "demo";
  if (environment === "demo") return "https://external-api.demo.kalshi.co";
  if (environment === "production") return "https://external-api.kalshi.com";
  throw new KalshiTradingApiError("INVALID_CREDENTIALS");
}

function signature(
  creds: Credentials,
  method: SignedMethod,
  path: string,
  timestamp: string,
): string {
  try {
    const key = createPrivateKey(creds.privateKey);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
      throw new Error("Unsupported key type");
    }
    const signer = createSign("sha256");
    signer.update(`${timestamp}${method}${path}`);
    signer.end();
    return signer.sign({
      key,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64");
  } catch {
    throw new KalshiTradingApiError("INVALID_CREDENTIALS");
  }
}

function assertMutationEnabled(context: KalshiMutationGuardContext): void {
  if (process.env.MICRO_LIVE_PRODUCTION_ENABLED !== "true" ||
      process.env.LIVE_EXECUTION_ENABLED !== "true" ||
      !context ||
      context.databaseEnabled !== true ||
      context.killSwitch !== "OFF" ||
      context.leaseHeld !== true ||
      context.reconciled !== true) {
    throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
  }
}

async function consumeSubmissionCapability(
  input: KalshiLimitOrderRequest,
  capability: KalshiSubmissionCapability | undefined,
): Promise<{ runId: string; subaccountNumber: number }> {
  const record = capability && issuedCapabilities.get(capability);
  if (!record || record.consumed) {
    throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
  }
  record.consumed = true;
  issuedCapabilities.delete(capability!);
  if (record.canonicalInput !== canonicalOrderInput(input)) {
    throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
  }
  if (!await record.validateWhileTransactionActive()) {
    throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
  }
  return { runId: record.runId, subaccountNumber: record.subaccountNumber };
}

async function assertPostSubmissionAuthorized(
  input: KalshiLimitOrderRequest,
  capability: KalshiSubmissionCapability | undefined,
): Promise<{ runId: string; subaccountNumber: number }> {
  return consumeSubmissionCapability(input, capability);
}

async function consumeCancellationCapability(
  orderId: string,
  capability: KalshiCancellationCapability | undefined,
): Promise<{
  identity: KalshiCancellationIdentity;
  runId: string;
  subaccountNumber: number;
  marketTicker: string;
  side: "yes" | "no";
  remainingContracts: number;
  pairRecoveryEvidenceDigest: string | null;
  validateCommittedState: () => Promise<boolean>;
}> {
  const record = capability && issuedCancellationCapabilities.get(capability);
  if (!record || record.consumed || record.identity.exchangeOrderId !== orderId) {
    throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
  }
  // Claim synchronously before any awaited database validation or network GET.
  record.consumed = true;
  issuedCancellationCapabilities.delete(capability!);
  if (!await record.validateCommittedState()) {
    throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
  }
  return record;
}

function validatePrice(price: string): string {
  const match = /^(0|1)(?:\.(\d{1,4}))?$/.exec(price);
  if (!match) throw new KalshiTradingApiError("INVALID_RESPONSE");
  const value = Number(price);
  if (value <= 0 || value >= 1) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  return value.toFixed(4);
}

function normalizeOrder(
  value: unknown,
  expectedOrderId?: string,
  requireFilledCount = false,
): KalshiOrder {
  const order = object(value);
  if (order.subaccount != null &&
      order.subaccount !== selectedSubaccount()) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  const orderId = requiredString(order.order_id);
  const clientOrderId = requiredString(order.client_order_id);
  const ticker = requiredString(order.ticker);
  const side = requiredString(order.side);
  const action = requiredString(order.action);
  const type = requiredString(order.type);
  const status = requiredString(order.status);
  const remainingCount = decimal(order.remaining_count_fp ?? order.remaining_count);
  const rawFilledCount = order.fill_count_fp ?? order.fill_count;
  let filledCount: string | null = null;
  if (rawFilledCount !== undefined && rawFilledCount !== null) {
    filledCount = decimal(rawFilledCount);
    if (!Number.isSafeInteger(Number(filledCount)) || Number(filledCount) < 0) {
      throw new KalshiTradingApiError("INVALID_RESPONSE");
    }
  } else if (requireFilledCount) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  if ((side !== "yes" && side !== "no") ||
      (action !== "buy" && action !== "sell") ||
      type !== "limit" ||
      !["resting", "canceled", "executed"].includes(status) ||
      (expectedOrderId !== undefined && orderId !== expectedOrderId)) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  return {
    orderId,
    clientOrderId,
    ticker,
    side,
    action,
    type,
    status,
    remainingCount,
    filledCount,
    outcomeSide: order.outcome_side == null ? null : requiredString(order.outcome_side),
    bookSide: order.book_side == null ? null : requiredString(order.book_side),
  };
}

function normalizeFill(value: unknown): KalshiFill {
  const fill = object(value);
  if (fill.subaccount != null &&
      fill.subaccount !== selectedSubaccount()) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  const side = requiredString(fill.side);
  const action = requiredString(fill.action);
  const timestamp = requiredString(fill.created_time);
  const parsedTimestamp = Date.parse(timestamp);
  const rawPrice = side === "yes"
    ? fill.yes_price_dollars ?? fill.price_dollars
    : fill.no_price_dollars ?? fill.price_dollars;
  const priceDollars = validatePrice(decimal(rawPrice));
  if ((side !== "yes" && side !== "no") ||
      (action !== "buy" && action !== "sell") ||
      !Number.isFinite(parsedTimestamp)) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  const fillId = requiredString(fill.fill_id ?? fill.trade_id);
  const count = decimal(fill.count_fp ?? fill.count);
  if (Number(count) <= 0) throw new KalshiTradingApiError("INVALID_RESPONSE");
  return {
    fillId,
    tradeId: fill.trade_id == null ? null : requiredString(fill.trade_id),
    orderId: fill.order_id == null ? null : requiredString(fill.order_id),
    ticker: requiredString(fill.ticker ?? fill.market_ticker),
    side,
    action,
    count,
    priceDollars,
    createdAt: new Date(parsedTimestamp).toISOString(),
  };
}

function normalizeV2CreateOrderResponse(
  value: unknown,
  input: KalshiLimitOrderRequest,
): KalshiOrder {
  const response = object(value);
  const orderId = requiredString(response.order_id);
  const clientOrderId = requiredString(response.client_order_id);
  const filledCount = decimal(response.fill_count);
  const remainingCount = decimal(response.remaining_count);
  const filled = Number(filledCount);
  const remaining = Number(remainingCount);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(orderId) ||
      clientOrderId !== input.clientOrderId ||
      !Number.isSafeInteger(filled) || filled < 0 ||
      !Number.isSafeInteger(remaining) || remaining < 0 ||
      remaining !== 0 || filled > input.count ||
      !Number.isSafeInteger(response.ts_ms) || Number(response.ts_ms) <= 0) {
    throw new KalshiTradingApiError("INVALID_RESPONSE");
  }
  return {
    orderId,
    clientOrderId,
    ticker: input.ticker,
    side: input.side,
    action: "buy",
    type: "limit",
    status: filled === input.count ? "executed" : "canceled",
    remainingCount,
    filledCount,
    outcomeSide: input.side,
    bookSide: input.side === "yes" ? "bid" : "ask",
  };
}

export function createKalshiTradingClient(options: KalshiTradingClientOptions) {
  const fetchImpl = options.fetchImpl;

  async function request(
    method: SignedMethod,
    path: string,
    body?: JsonObject,
    beforeDelete?: () => Promise<boolean>,
    microLiveRunId?: string,
    dedicatedPairAuthorization?: {
      authorizationMode: "final_post" | "recovery_get";
      requiredEvidenceDigest?: string;
    },
  ): Promise<unknown> {
    const subaccount = selectedSubaccount();
    const accountMode = selectedAccountMode(subaccount);
    if (!accountMode) throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
    const expectedKeyId = process.env.KALSHI_API_KEY_ID?.trim();
    if (!expectedKeyId) throw new KalshiTradingApiError("NOT_CONFIGURED");
    try {
      const verifyScope = options.verifySubaccount ??
        (accountMode === "primary_nonexclusive"
          ? verifyKalshiTradingKeyTradePermission
          : verifyKalshiTradingKeyRestriction);
      if (!await verifyScope()) {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
    } catch {
      throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
    }
    const query = path.split("?")[1];
    const querySelector = query ? new URLSearchParams(query).get("subaccount") : null;
    if (selectedSubaccount() !== subaccount ||
        selectedAccountMode(subaccount) !== accountMode ||
        (querySelector !== null && querySelector !== String(subaccount)) ||
        (body?.subaccount !== undefined && body.subaccount !== subaccount)) {
      throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
    }
    if (method === "POST" || method === "DELETE") {
      const exchangeIndex = String(body?.exchange_index ??
        (query ? new URLSearchParams(query).get("exchange_index") : null));
      const requestedTicker = body?.ticker ??
        (query ? new URLSearchParams(query).get("market_ticker") : null);
      if (accountMode !== "exclusive" || subaccount <= 0 ||
          exchangeIndex !== "2" ||
          typeof requestedTicker !== "string" ||
          (body?.subaccount !== subaccount &&
            (querySelector === null || querySelector !== String(subaccount))) ||
          typeof microLiveRunId !== "string" || !microLiveRunId.trim()) {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
      await requireDedicatedShardTwoPair(options, {
        subaccountNumber: subaccount,
        apiKeyId: expectedKeyId,
        marketTicker: requestedTicker,
        runId: microLiveRunId,
        action: method === "DELETE" ? "sell" :
          body?.action === "sell" ? "sell" : "buy",
        ...(method === "DELETE" ? dedicatedPairAuthorization ?? {} : {}),
      });
    }
    if (method === "DELETE" && (!beforeDelete || !await beforeDelete())) {
      throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
    }
    if (selectedSubaccount() !== subaccount ||
        selectedAccountMode(subaccount) !== accountMode ||
        (querySelector !== null && querySelector !== String(subaccount)) ||
        (body?.subaccount !== undefined && body.subaccount !== subaccount) ||
        process.env.KALSHI_API_KEY_ID?.trim() !== expectedKeyId) {
      throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
    }
    const creds = credentials();
    if (creds.keyId !== expectedKeyId) {
      throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
    }
    const timestamp = Date.now().toString();
    // Kalshi signs the pathname, never its query string (e.g. shard routing).
    const signed = signature(creds, method, path.split("?")[0]!, timestamp);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "KALSHI-ACCESS-KEY": creds.keyId,
      "KALSHI-ACCESS-SIGNATURE": signed,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    };
    if (body) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl()}${path}`, {
        method,
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new KalshiTradingApiError("NETWORK_ERROR");
    }
    if (!response.ok) throw new KalshiTradingApiError("HTTP_ERROR", response.status);
    try {
      return await response.json() as unknown;
    } catch {
      throw new KalshiTradingApiError("INVALID_JSON");
    }
  }

  return {
    async createLimitOrder(
      input: KalshiLimitOrderRequest,
      context: KalshiMutationGuardContext,
      capability?: KalshiSubmissionCapability,
    ): Promise<KalshiOrder> {
      void context;
      const authorization = await assertPostSubmissionAuthorized(input, capability);
      if (!input || typeof input.ticker !== "string" ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(input.ticker) ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientOrderId) ||
          (input.side !== "yes" && input.side !== "no") ||
          input.action !== "buy" ||
          !Number.isSafeInteger(input.count) || input.count <= 0) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      const priceDollars = validatePrice(input.priceDollars);
      const yesBookPrice = input.side === "yes"
        ? priceDollars
        : ((10_000 - Math.round(Number(priceDollars) * 10_000)) / 10_000).toFixed(4);
      const response = await request("POST", `${API_PREFIX}/portfolio/events/orders`, {
        ticker: input.ticker,
        client_order_id: input.clientOrderId,
        side: input.side === "yes" ? "bid" : "ask",
        count: input.count.toFixed(2),
        price: validatePrice(yesBookPrice),
        // Gap entries are intentionally IOC: fill only what is executable now
        // and never leave stale remainder resting after the repricing edge moves.
        time_in_force: "immediate_or_cancel",
        self_trade_prevention_type: "taker_at_cross",
        post_only: false,
        cancel_order_on_pause: true,
        subaccount: authorization.subaccountNumber,
        exchange_index: 2,
      }, undefined, authorization.runId);
      return normalizeV2CreateOrderResponse(response, input);
    },

    async createReduceOnlyExit(
      input: KalshiReduceOnlyExitRequest,
      context: KalshiMutationGuardContext,
      capability?: KalshiSubmissionCapability,
    ): Promise<KalshiOrder> {
      void context;
      const authorization = await assertPostSubmissionAuthorized(input, capability);
      if (!input || input.action !== "sell" ||
          typeof input.ticker !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(input.ticker) ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientOrderId) ||
          (input.side !== "yes" && input.side !== "no") ||
          !Number.isSafeInteger(input.count) || input.count <= 0) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      const ownedPrice = validatePrice(input.priceDollars);
      // V2 event orders always quote YES dollars: sell YES = ask at YES bid;
      // sell NO = bid at YES ask, the complement of the NO bid.
      const yesPrice = input.side === "yes"
        ? ownedPrice
        : ((10_000 - Math.round(Number(ownedPrice) * 10_000)) / 10_000).toFixed(4);
      const response = object(await request("POST", `${API_PREFIX}/portfolio/events/orders`, {
        ticker: input.ticker,
        client_order_id: input.clientOrderId,
        side: input.side === "yes" ? "ask" : "bid",
        count: input.count.toFixed(2),
        price: validatePrice(yesPrice),
        // Reduce-only is documented as a placement-time cap. IOC prevents an
        // unfilled exit from resting after an independent inventory change.
        time_in_force: "immediate_or_cancel",
        self_trade_prevention_type: "taker_at_cross",
        post_only: false,
        cancel_order_on_pause: true,
        reduce_only: true,
        subaccount: authorization.subaccountNumber,
        exchange_index: 2,
      }, undefined, authorization.runId));
      const orderId = requiredString(response.order_id);
      const clientOrderId = requiredString(response.client_order_id);
      const filledCount = decimal(response.fill_count);
      const remainingCount = decimal(response.remaining_count);
      const filled = Number(filledCount);
      const remaining = Number(remainingCount);
      if (clientOrderId !== input.clientOrderId ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(orderId) ||
          !Number.isSafeInteger(filled) || !Number.isSafeInteger(remaining) ||
          filled + remaining > input.count ||
          !Number.isSafeInteger(response.ts_ms) || Number(response.ts_ms) <= 0) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      return {
        orderId, clientOrderId, ticker: input.ticker, side: input.side,
        action: "sell", type: "limit",
        // For an IOC, zero remaining means no order rests; the unfilled
        // quantity was canceled, not filled. GET evidence proves the fills.
        status: remaining ? "resting" : filled === input.count ? "executed" : "canceled",
        remainingCount, filledCount,
        outcomeSide: input.side === "yes" ? "no" : "yes",
        bookSide: input.side === "yes" ? "ask" : "bid",
      };
    },

    async cancelReduceOnlyExit(
      orderId: string,
      ticker: string,
      expectedRemaining: string,
      context: KalshiMutationGuardContext,
      capability?: KalshiCancellationCapability,
    ): Promise<{ orderId: string; remainingCount: string }> {
      if (typeof orderId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(orderId)) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      void context;
      const authorization = await consumeCancellationCapability(orderId, capability);
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(orderId) ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(ticker) ||
          ticker !== authorization.marketTicker) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      const expected = Number(decimal(expectedRemaining));
      if (!Number.isSafeInteger(expected) || expected <= 0 ||
          expected > authorization.remainingContracts) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      const subaccountNumber = authorization.subaccountNumber;
      const apiKeyId = process.env.KALSHI_API_KEY_ID?.trim();
      if (!apiKeyId) throw new KalshiTradingApiError("NOT_CONFIGURED");
      await requireDedicatedShardTwoPair(options, {
        subaccountNumber, apiKeyId, marketTicker: ticker, runId: authorization.runId,
        action: "sell",
        authorizationMode: authorization.pairRecoveryEvidenceDigest
          ? "recovery_get" : "final_post",
        requiredEvidenceDigest: authorization.pairRecoveryEvidenceDigest ?? undefined,
      });
      const currentPayload = object(await request(
        "GET",
        `${API_PREFIX}/portfolio/orders/${encodeURIComponent(orderId)}`,
      ));
      if (!orderResponseMatchesDedicatedPair(currentPayload.order, subaccountNumber)) {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
      const currentOrder = normalizeOrder(currentPayload.order, orderId, true);
      const currentRemaining = Number(currentOrder.remainingCount);
      if (currentOrder.clientOrderId !== authorization.identity.clientOrderId ||
          currentOrder.ticker !== authorization.marketTicker ||
          currentOrder.side !== authorization.side ||
          currentOrder.action !== "sell" || currentOrder.status !== "resting" ||
          !Number.isSafeInteger(currentRemaining) || currentRemaining <= 0 ||
          currentRemaining > expected) {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
      if (!await authorization.validateCommittedState()) {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
      const response = object(await request("DELETE",
        `${API_PREFIX}/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(ticker)}&subaccount=${subaccountNumber}&exchange_index=2`,
        undefined,
        authorization.validateCommittedState,
        authorization.runId,
        authorization.pairRecoveryEvidenceDigest
          ? {
              authorizationMode: "recovery_get",
              requiredEvidenceDigest: authorization.pairRecoveryEvidenceDigest,
            }
          : undefined,
      ));
      const reduced = Number(decimal(response.reduced_by));
      if (requiredString(response.order_id) !== orderId ||
          !Number.isSafeInteger(reduced) || reduced > expected) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      // A fill can race DELETE, so reduced_by can be less than the earlier
      // remaining count. The caller MUST re-read status, fills and position.
      return { orderId, remainingCount: "0" };
    },

    async getOrder(orderId: string): Promise<KalshiOrder> {
      if (typeof orderId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(orderId)) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      const payload = object(await request(
        "GET",
        `${API_PREFIX}/portfolio/orders/${encodeURIComponent(orderId)}`,
      ));
      return normalizeOrder(payload.order, orderId, true);
    },

    async getFills(): Promise<KalshiFillsPage> {
      const payload = object(await request(
        "GET",
        `${API_PREFIX}/portfolio/fills?limit=${PAGE_LIMIT}&subaccount=${selectedSubaccount()}`,
      ));
      if (!Array.isArray(payload.fills) || payload.fills.length > PAGE_LIMIT) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      const cursor = payload.cursor;
      if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      return {
        fills: payload.fills.map(normalizeFill),
        cursor: typeof cursor === "string" && cursor ? cursor : null,
      };
    },

    async cancelOrder(
      orderId: string,
      context: KalshiMutationGuardContext,
      capability?: KalshiCancellationCapability,
    ): Promise<{ orderId: string; remainingCount: string }> {
      if (typeof orderId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(orderId)) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      void context;
      const authorization = await consumeCancellationCapability(orderId, capability);
      const subaccountNumber = authorization.subaccountNumber;
      const apiKeyId = process.env.KALSHI_API_KEY_ID?.trim();
      if (!apiKeyId) throw new KalshiTradingApiError("NOT_CONFIGURED");
      await requireDedicatedShardTwoPair(options, {
        subaccountNumber,
        apiKeyId,
        marketTicker: authorization.marketTicker,
        runId: authorization.runId,
        action: "sell",
      });
      // Validate the order's shard identity from authenticated read evidence
      // before the explicitly shard-targeted V2 cancellation.
      const currentPayload = object(await request(
        "GET",
        `${API_PREFIX}/portfolio/orders/${encodeURIComponent(orderId)}`,
      ));
      if (!orderResponseMatchesDedicatedPair(currentPayload.order, subaccountNumber)) {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
      const currentOrder = normalizeOrder(currentPayload.order, orderId, true);
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(currentOrder.ticker) ||
          currentOrder.clientOrderId !== authorization.identity.clientOrderId ||
          currentOrder.ticker !== authorization.marketTicker ||
          currentOrder.side !== authorization.side ||
          currentOrder.action !== "sell") {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
      const expected = Number(currentOrder.remainingCount);
      if (!Number.isSafeInteger(expected) || expected < 0 ||
          expected > authorization.remainingContracts) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      if (expected === 0) return { orderId, remainingCount: "0" };
      if (!await authorization.validateCommittedState()) {
        throw new KalshiTradingApiError("MUTATION_GUARD_REJECTED");
      }
      const payload = object(await request(
        "DELETE",
        `${API_PREFIX}/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(currentOrder.ticker)}&subaccount=${subaccountNumber}&exchange_index=2`,
        undefined,
        authorization.validateCommittedState,
        authorization.runId,
      ));
      const responseOrderId = requiredString(payload.order_id);
      const reducedBy = Number(decimal(payload.reduced_by));
      if (responseOrderId !== orderId || !Number.isSafeInteger(reducedBy) ||
          reducedBy < 0 || reducedBy > expected ||
          (payload.client_order_id != null &&
            requiredString(payload.client_order_id) !== currentOrder.clientOrderId)) {
        throw new KalshiTradingApiError("INVALID_RESPONSE");
      }
      return { orderId, remainingCount: "0" };
    },
  };
}