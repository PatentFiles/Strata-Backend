import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db, liveExecutionConfigTable, microLiveConfigTable, microLiveFillTable, microLiveOrderTable,
  microLivePairBoundaryTable, microLivePairFundingAttemptTable, microLiveSettlementTable,
  type MicroLivePairFundingAttempt,
} from "@workspace/db";
import type {
  KalshiDedicatedPairEvidence, KalshiDedicatedPairFundingAnchor,
  KalshiPairEvidenceRecord, KalshiProspectiveCleanPairSnapshot,
} from "./kalshiAccountClient";
import {
  captureCleanPairSnapshot, getConfiguredKalshiSubaccount,
  readKalshiDedicatedPairEvidence, verifyKalshiRestrictedTradingKeyForSubaccount,
} from "./kalshiAccountClient";
import {
  readPairTransferHistory, readPrimaryIndex2Balance,
  type PrimaryBalanceEvidence,
} from "./kalshiPairFundingClient";
import { getVerifiedCreationAttemptForPair } from "./microLiveSubaccountCreation";
import {
  databasePairKeyAttemptStore, PAIR_SUBACCOUNT,
} from "./microLivePairKeyProvisioningAttempt";
import {
  feeEvidenceMatchesApproval, readCurrentEntryFeeTerms,
  standingFeePolicyApprovalIsValid,
  type StandingFeePolicyApproval,
} from "./microLiveEntryFees";
import { approvedFeeSession } from "./microLiveFeeApproval";
import {
  getFeeVerificationState, lockFeeVerificationForPost,
} from "./microLiveFeeVerification";
import {
  reconcilePairCollateralLedger,
  type PairCollateralSnapshot,
} from "./microLivePairCollateral";

const DEDICATED_EXCHANGE_INDEX = 2 as const;
const HISTORY_PROVENANCE_REASON = "pre_funding_zero_snapshot_provenance_unverified";
const HISTORY_SNAPSHOT_SHAPE_REASON = "pre_funding_zero_snapshot_unverified";

type BoundaryResult = {
  status: "captured" | "funded" | "initialized" | "blocked";
  reason: string;
  runId?: string;
  evidenceDigest?: string;
};

export type MicroLivePairCollateralMode =
  | { kind: "preentry" }
  | {
      kind: "final_post";
      action: "entry" | "exit";
      phase: "ENTRY_OPEN" | "EXIT_ONLY";
    }
  | { kind: "recovery_get" };

export type MicroLivePairCollateralProof = PairCollateralSnapshot & {
  /** A proof is bound to its requested config phase; it is never POST authorization. */
  mode: MicroLivePairCollateralMode;
  proofKind: "collateral_reconciliation_only";
  authorization: "none";
  runId?: string;
  boundaryEvidenceDigest?: string;
  configStateDigest?: string;
};

export type PairBoundaryDependencies = {
  now?: () => Date;
  captureSnapshot?: (
    subaccountNumber: number, ticker: string, options?: { creationBoundary?: boolean },
  ) =>
    Promise<KalshiProspectiveCleanPairSnapshot>;
  readEvidence?: (
    subaccountNumber: number, ticker: string, anchor?: KalshiDedicatedPairFundingAnchor,
    source?: "shared" | "index2",
  ) => Promise<KalshiDedicatedPairEvidence>;
  readFeeTerms?: typeof readCurrentEntryFeeTerms;
  readFeeApproval?: typeof approvedFeeSession;
  verifyKeyBinding?: typeof verifyKalshiRestrictedTradingKeyForSubaccount;
};

function isolatedFixture(): boolean {
  return process.env.NODE_ENV === "development" &&
    /^micro_live_test_[a-f0-9]{24}$/.test(
      process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "",
    );
}

export function configuredKey(source: "shared" | "index2" = "shared"): { apiKeyId: string; fingerprint: string } | null {
  const apiKeyId = process.env[source === "index2"
    ? "KALSHI_INDEX2_API_KEY_ID" : "KALSHI_API_KEY_ID"]?.trim();
  const privateKey = process.env[source === "index2"
    ? "KALSHI_INDEX2_PRIVATE_KEY" : "KALSHI_API_PRIVATE_KEY"]?.trim();
  if (!apiKeyId || !privateKey) return null;
  const normalizedPrivateKey = privateKey.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  return {
    apiKeyId,
    fingerprint: createHash("sha256")
      .update(`${apiKeyId}\u001f${normalizedPrivateKey}`)
      .digest("hex"),
  };
}

export function isFundingBoundaryEligible(
  boundary: {
    state: string;
    subaccountNumber: number;
    exchangeIndex: number;
    restrictedApiKeyId: string | null;
    restrictedKeyFingerprint: string | null;
    keyBoundAt: Date | null;
    keyBindingEvidenceDigest: string | null;
  },
  expected: { subaccountNumber: number; apiKeyId: string; fingerprint: string },
): boolean {
  return boundary.state === "KEY_BOUND_VERIFIED" &&
    boundary.subaccountNumber === expected.subaccountNumber &&
    boundary.exchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    boundary.restrictedApiKeyId === expected.apiKeyId &&
    boundary.restrictedKeyFingerprint === expected.fingerprint &&
    boundary.keyBoundAt instanceof Date &&
    Number.isFinite(boundary.keyBoundAt.getTime()) &&
    typeof boundary.keyBindingEvidenceDigest === "string" &&
    /^[0-9a-f]{64}$/.test(boundary.keyBindingEvidenceDigest);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validTicker(ticker: string): boolean {
  return /^KXBTC15M-[A-Za-z0-9-]+$/.test(ticker);
}

function parseMicros(dollars: string | null | undefined): string | null {
  if (typeof dollars !== "string") return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(dollars);
  if (!match) return null;
  const value = BigInt(match[2]!) * 1_000_000n +
    BigInt((match[3] ?? "").padEnd(6, "0"));
  return (match[1] === "-" ? -value : value).toString();
}

function blocked(reason: string): BoundaryResult {
  return { status: "blocked", reason };
}

type PairCollateralConfig = typeof microLiveConfigTable.$inferSelect;

function pairCollateralModeMatches(
  config: PairCollateralConfig,
  mode: MicroLivePairCollateralMode,
): boolean {
  const environmentMicroLiveEnabled =
    process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true";
  const environmentExecutionEnabled = process.env.LIVE_EXECUTION_ENABLED === "true";
  if (mode.kind === "preentry") {
    return config.microLiveRunPhase === "UNARMED" &&
      config.manualKillSwitch &&
      !config.microLiveProductionEnabled && !config.liveExecutionEnabled &&
      !config.microLiveAccountingUnresolved;
  }
  if (mode.kind === "recovery_get") {
    return config.microLiveRunPhase === "FROZEN" &&
      config.manualKillSwitch &&
      !config.microLiveProductionEnabled && !config.liveExecutionEnabled;
  }
  const actionPhaseMatches = mode.action === "entry"
    ? mode.phase === "ENTRY_OPEN"
    : mode.phase === "ENTRY_OPEN" || mode.phase === "EXIT_ONLY";
  return actionPhaseMatches &&
    config.microLiveRunPhase === mode.phase &&
    !config.manualKillSwitch &&
    config.microLiveProductionEnabled && config.liveExecutionEnabled &&
    environmentMicroLiveEnabled && environmentExecutionEnabled &&
    !config.microLiveAccountingUnresolved &&
    Boolean(config.microLiveRunApprovalId?.trim()) &&
    Boolean(config.microLiveRunApprovalDigest?.trim());
}

function persistedCleanBoundaryIsTrusted(
  row: typeof microLivePairBoundaryTable.$inferSelect,
): boolean {
  return Number.isSafeInteger(row.subaccountNumber) &&
    row.subaccountNumber >= 1 && row.subaccountNumber <= 63 &&
    row.exchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    (row.restrictedApiKeyId === null || Boolean(row.restrictedApiKeyId.trim())) &&
    (row.restrictedKeyFingerprint === null ||
      /^[0-9a-f]{64}$/.test(row.restrictedKeyFingerprint)) &&
    row.cleanBalanceMicros === "0" &&
    row.cleanBalanceSemantics === "available_cash" &&
    row.cleanSnapshotAuthenticated === true &&
    row.cleanOrderCount === 0 && row.cleanFillCount === 0 &&
    row.cleanPositionCount === 0 && row.cleanSettlementCount === 0 &&
    Number.isFinite(row.cleanBoundaryAt.getTime()) &&
    /^[0-9a-f]{64}$/.test(row.cleanBoundaryEvidenceDigest);
}

function transactionFailure(reason: string, error: unknown): BoundaryResult {
  if (!isolatedFixture()) return blocked(reason);
  let candidate = error;
  let code = "unknown";
  let constraint = "unknown";
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth++) {
    const record = candidate as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof record.code === "string" && /^[0-9A-Z]{5}$/.test(record.code)) {
      code = record.code;
    }
    if (typeof record.constraint === "string" &&
        /^[A-Za-z0-9_]{1,128}$/.test(record.constraint)) {
      constraint = record.constraint;
    }
    if (code !== "unknown" || record.cause === undefined) break;
    candidate = record.cause;
  }
  return blocked(`${reason}:${code}:${constraint}`);
}

export function fundingAnchorFromRow(
  row: typeof microLivePairBoundaryTable.$inferSelect,
): KalshiDedicatedPairFundingAnchor | null {
  if (!persistedCleanBoundaryIsTrusted(row) ||
      !row.fundingTransferId || !row.fundingTransferredAt ||
      row.fundingAmountCents !== 2500 ||
      row.postFundingBalanceMicros !== "25000000" ||
      row.postFundingBalanceSemantics !== "available_cash" ||
      row.postFundingSnapshotAuthenticated !== true ||
      !row.postFundingSnapshotAt || !row.postFundingEvidenceDigest ||
      !/^[0-9a-f]{64}$/.test(row.cleanBoundaryEvidenceDigest)) return null;
  return {
    transferId: row.fundingTransferId,
    transferredAt: row.fundingTransferredAt.toISOString(),
    amountCents: 2500,
    baselineCashMicros: "25000000",
    baselineAt: row.postFundingSnapshotAt.toISOString(),
    preFundingZeroSnapshot: {
      availableCashMicros: "0",
      capturedAt: row.cleanBoundaryAt.toISOString(),
      evidenceDigest: row.cleanBoundaryEvidenceDigest,
      authenticated: true,
      balanceSemantics: "available_cash",
    },
    postFundingSnapshot: {
      availableCashMicros: "25000000",
      capturedAt: row.postFundingSnapshotAt.toISOString(),
      evidenceDigest: row.postFundingEvidenceDigest,
      authenticated: true,
      balanceSemantics: "available_cash",
    },
  };
}

function postBoundary(
  record: KalshiPairEvidenceRecord,
  boundaryAt: Date,
): boolean {
  if (!record.occurredAt) return true;
  return Date.parse(record.occurredAt) >= boundaryAt.getTime();
}

function isShardTwoTransfer(record: KalshiPairEvidenceRecord): boolean {
  return record.feed === "cross_exchange_transfer" &&
    (record.sourceExchangeIndex === DEDICATED_EXCHANGE_INDEX ||
      record.destinationExchangeIndex === DEDICATED_EXCHANGE_INDEX);
}

export function transferIsExactFunding(
  record: KalshiPairEvidenceRecord,
  subaccountNumber: number,
): boolean {
  const details = record.details;
  const status = details.status?.toLowerCase();
  const statusProvenComplete = status === undefined ||
    ["complete", "completed", "succeeded"].includes(status);
  return record.feed === "subaccount_transfer" &&
    record.classification === "pair" &&
    details.from_subaccount === "0" &&
    details.to_subaccount === String(subaccountNumber) &&
    details.exchange_index === String(DEDICATED_EXCHANGE_INDEX) &&
    details.amount_cents === "2500" &&
    statusProvenComplete &&
    Boolean(record.occurredAt);
}

export function historyReasons(
  evidence: KalshiDedicatedPairEvidence,
  trustedPersistedBoundary: boolean,
  acknowledgedLateRecovery = false,
): string[] {
  const reasons = [...new Set([
    ...(evidence.reasons ?? []),
    ...(evidence.reason ? [evidence.reason] : []),
  ])];
  // These client limitations are waived only by this service's own DB
  // sidecar validation: no caller-provided anchor flags or digests are used.
  // The reader's evidence object itself remains incomplete and unmodified.
  if (!trustedPersistedBoundary) {
    return reasons;
  }
  const filtered = reasons
    .filter((reason) => reason !== HISTORY_PROVENANCE_REASON &&
      reason !== HISTORY_SNAPSHOT_SHAPE_REASON &&
      (!acknowledgedLateRecovery || (
        reason !== "subaccount_inventory_balance_stale" &&
        reason !== "post_funding_25_snapshot_unverified"
      )));
  // A late snapshot makes the generic reader skip its usual cash equation.
  // Restore that equation before accepting the DB-attested exception.
  if (acknowledgedLateRecovery) {
    try {
      const cash = evidence.collateralSnapshot?.availableCashMicros;
      const delta = evidence.postAnchorCashDeltaMicros;
      const reserve = evidence.collateralSnapshot?.restingEntryReserveMicros;
      if (cash === null || cash === undefined || delta === null || reserve === null ||
          reserve === undefined || delta === undefined ||
          BigInt(cash) - 25_000_000n !== BigInt(delta) - BigInt(reserve)) {
        filtered.push("pair_cash_and_resting_entry_collateral_mismatch");
      }
    } catch {
      filtered.push("pair_cash_and_resting_entry_collateral_mismatch");
    }
  }
  return filtered;
}

async function persistedAcknowledgedLateRecovery(
  boundary: typeof microLivePairBoundaryTable.$inferSelect,
  evidence: KalshiDedicatedPairEvidence,
  ticker: string,
): Promise<boolean> {
  const anchor = fundingAnchorFromRow(boundary);
  if (!anchor || boundary.subaccountNumber !== 1 ||
      boundary.exchangeIndex !== 2 ||
      !["funded", "initialized"].includes(boundary.state) ||
      !boundary.fundingTransferredAt || !boundary.postFundingSnapshotAt ||
      boundary.postFundingSnapshotAt.getTime() - boundary.fundingTransferredAt.getTime() <= 60_000 ||
      boundary.postFundingSnapshotAt.getTime() > Date.parse(evidence.scanFinishedAt) ||
      !/^[0-9a-f]{64}$/.test(boundary.postFundingEvidenceDigest ?? "") ||
      evidence.fundingAnchor?.transferId !== anchor.transferId ||
      evidence.fundingAnchor.postFundingSnapshot?.evidenceDigest !==
        anchor.postFundingSnapshot?.evidenceDigest ||
      evidence.fundingAnchor.postFundingSnapshot?.capturedAt !==
        anchor.postFundingSnapshot?.capturedAt ||
      evidence.fundingAnchor.baselineAt !== anchor.baselineAt ||
      evidence.fundingAnchor.transferredAt !== anchor.transferredAt ||
      evidence.balance.subaccountNumber !== 1 ||
      evidence.balance.exchangeIndex !== 2) return false;
  const inventory = evidence.records?.filter(r =>
    r.feed === "balance" && r.classification === "pair" && r.id === "1:2") ?? [];
  const raw = inventory[0]?.details.updated_ts;
  const updated = raw === undefined ? NaN : Number(raw);
  const updatedMs = updated < 100_000_000_000 ? updated * 1_000 : updated;
  if (inventory.length !== 1 || !Number.isSafeInteger(updatedMs) ||
      updatedMs < boundary.fundingTransferredAt.getTime() - 1_000 ||
      updatedMs > Date.parse(evidence.scanFinishedAt) + 5_000) return false;
  try {
    const attempts = await db.select().from(microLivePairFundingAttemptTable)
      .where(and(
        eq(microLivePairFundingAttemptTable.destinationSubaccount, 1),
        eq(microLivePairFundingAttemptTable.exchangeIndex, 2),
      )).limit(2);
    if (attempts.length !== 1) return false;
    const attempt = attempts[0]!;
    const transferredAt = boundary.fundingTransferredAt.getTime();
    return (attempt.state === "reconciled" || attempt.state === "response_received") &&
      attempt.responseReceivedAt !== null &&
      attempt.sourceSubaccount === 0 && attempt.amountCents === 2500 &&
      attempt.marketTicker === ticker &&
      attempt.cleanBoundaryDigest === boundary.cleanBoundaryEvidenceDigest &&
      attempt.attemptedAt.getTime() >= boundary.cleanBoundaryAt.getTime() &&
      attempt.responseReceivedAt.getTime() >= attempt.attemptedAt.getTime() &&
      transferredAt >= attempt.attemptedAt.getTime() - 1_000 &&
      transferredAt <= attempt.responseReceivedAt.getTime() + 1_000 &&
      (attempt.state === "response_received" && attempt.transferId === null ||
        attempt.state === "reconciled" && attempt.transferId === boundary.fundingTransferId);
  } catch {
    return false;
  }
}

type FundingTransfer = Awaited<ReturnType<typeof readPairTransferHistory>>[number];

/** Never infer a successful POST from a matching transfer after a lost response. */
export function acknowledgedFundingCashProof(
  attempt: MicroLivePairFundingAttempt,
  boundary: typeof microLivePairBoundaryTable.$inferSelect,
  primary: PrimaryBalanceEvidence,
  destination: PrimaryBalanceEvidence,
  transfers: readonly FundingTransfer[],
  now: number,
): FundingTransfer | null {
  try {
    if (attempt.state !== "response_received" || !attempt.responseReceivedAt ||
        attempt.transferId !== null || attempt.reconciledAt !== null ||
        attempt.sourceSubaccount !== 0 || attempt.destinationSubaccount !== 1 ||
        attempt.exchangeIndex !== 2 || attempt.amountCents !== 2500 ||
        attempt.cleanBoundaryDigest !== boundary.cleanBoundaryEvidenceDigest ||
        boundary.state !== "KEY_BOUND_VERIFIED" || boundary.ambiguityFrozenAt !== null ||
        !validTicker(attempt.marketTicker) ||
        attempt.attemptedAt.getTime() < boundary.cleanBoundaryAt.getTime() ||
        attempt.responseReceivedAt.getTime() < attempt.attemptedAt.getTime() ||
        now - primary.observedAt > 30_000 || now - destination.observedAt > 30_000 ||
        primary.observedAt > now + 5_000 || destination.observedAt > now + 5_000 ||
        primary.updatedAt < attempt.attemptedAt.getTime() - 1_000 ||
        destination.updatedAt < attempt.attemptedAt.getTime() - 1_000 ||
        BigInt(attempt.sourceScopedBeforeMicros) - BigInt(primary.scopedMicros) !== 25_000_000n ||
        BigInt(attempt.sourceInventoryBeforeMicros) - BigInt(primary.inventoryMicros) !== 25_000_000n ||
        BigInt(destination.scopedMicros) !== 25_000_000n ||
        BigInt(destination.inventoryMicros) !== 25_000_000n) return null;
    const since = boundary.cleanBoundaryAt.getTime();
    const touching = transfers.filter(t => Date.parse(t.occurredAt) >= since &&
      t.exchangeIndex === 2 && (t.fromSubaccount === 1 || t.toSubaccount === 1));
    const source = transfers.filter(t => Date.parse(t.occurredAt) >=
      attempt.attemptedAt.getTime() - 1_000 && t.exchangeIndex === 2 &&
      (t.fromSubaccount === 0 || t.toSubaccount === 0));
    if (touching.length !== 1 || source.length !== 1 ||
        touching[0]!.transferId !== source[0]!.transferId) return null;
    const match = touching[0]!;
    const time = Date.parse(match.occurredAt);
    return match.fromSubaccount === 0 && match.toSubaccount === 1 &&
      match.amountCents === 2500 && Number.isFinite(time) &&
      time >= since && time >= attempt.attemptedAt.getTime() - 1_000 &&
      time <= attempt.responseReceivedAt.getTime() + 1_000 ? match : null;
  } catch {
    return null;
  }
}

export function recoveryInventoryAndPortfolioClean(
  evidence: KalshiDedicatedPairEvidence,
  transferAt: number,
): boolean {
  const inventory = evidence.records?.filter(r =>
    r.feed === "balance" && r.classification === "pair" && r.id === "1:2") ?? [];
  const scoped = evidence.records?.filter(r =>
    r.feed === "scoped_balance" && r.classification === "pair") ?? [];
  const rawUpdated = inventory[0]?.details.updated_ts;
  const updated = rawUpdated === undefined ? NaN : Number(rawUpdated);
  const updatedMs = updated < 100_000_000_000 ? updated * 1_000 : updated;
  return inventory.length === 1 && scoped.length === 1 &&
    scoped[0]!.details.portfolio_value === "0" &&
    Number.isSafeInteger(updatedMs) && updatedMs >= transferAt - 1_000 &&
    updatedMs <= Date.parse(evidence.scanFinishedAt) + 5_000 &&
    evidence.collateralSnapshot?.availableCashMicros === "25000000" &&
    evidence.collateralSnapshot.inventoryBalanceMicros === "25000000" &&
    evidence.collateralSnapshot.restingEntryReserveMicros === "0" &&
    evidence.recordCounts.positions === 0 && evidence.recordCounts.orders === 0 &&
    evidence.recordCounts.fills === 0 && evidence.recordCounts.settlements === 0;
}

async function readPairEvidence(
  subaccountNumber: number,
  ticker: string,
  anchor?: KalshiDedicatedPairFundingAnchor,
  dependencies: PairBoundaryDependencies = {},
  source: "shared" | "index2" = "shared",
): Promise<KalshiDedicatedPairEvidence> {
  if (dependencies.readEvidence && !isolatedFixture()) {
    throw new Error("pair_boundary_test_reader_not_allowed");
  }
  const reader = dependencies.readEvidence ?? readKalshiDedicatedPairEvidence;
  return source === "shared"
    ? reader(subaccountNumber, ticker, anchor)
    : reader(subaccountNumber, ticker, anchor, source);
}

function cleanSnapshotUsable(
  snapshot: KalshiProspectiveCleanPairSnapshot,
  subaccountNumber: number,
  now: number,
  creationBoundary = false,
): boolean {
  const capturedAt = Date.parse(snapshot.capturedAt);
  return snapshot.status === "clean" &&
    snapshot.pair.subaccountNumber === subaccountNumber &&
    snapshot.pair.exchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    snapshot.availableCashMicros === "0" &&
    snapshot.inventoryCashMicros === "0" &&
    (!creationBoundary || snapshot.portfolioValueMicros === "0") &&
    snapshot.zeroPositions && snapshot.zeroOrders && snapshot.zeroFills &&
    snapshot.zeroSettlements && snapshot.zeroPriorPairTransfers &&
    (creationBoundary ||
      snapshot.keyRestrictionVerified && snapshot.tradePermissionVerified) &&
    snapshot.marketExchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    Boolean(snapshot.evidenceDigest && /^[0-9a-f]{64}$/.test(snapshot.evidenceDigest)) &&
    Number.isFinite(capturedAt) && capturedAt <= now &&
    now - capturedAt <= 30_000;
}

/** Capture and persist the irreversible pre-funding ($0) history boundary. */
export async function captureMicroLivePairCleanBoundary(
  input: { subaccountNumber: number; ticker: string },
  dependencies: PairBoundaryDependencies = {},
): Promise<BoundaryResult> {
  if (process.env.NODE_ENV !== "development") return blocked("pair_boundary_development_only");
  if (!Number.isSafeInteger(input.subaccountNumber) ||
      input.subaccountNumber < 1 || input.subaccountNumber > 63 ||
      !validTicker(input.ticker)) return blocked("pair_boundary_identity_invalid");
  const creation = await getVerifiedCreationAttemptForPair(input.subaccountNumber);
  if (!creation || creation.subaccountNumber !== input.subaccountNumber ||
      creation.exchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      !creation.attemptId.trim() ||
      !/^[0-9a-f]{64}$/.test(creation.inventoryDigest) ||
      !(creation.verifiedAt instanceof Date) ||
      !Number.isFinite(creation.verifiedAt.getTime())) {
    return blocked("pair_boundary_verified_creation_attempt_required");
  }
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!config || config.microLiveProductionEnabled || config.liveExecutionEnabled ||
      !config.manualKillSwitch) return blocked("pair_boundary_execution_gates_not_frozen");

  let snapshot: KalshiProspectiveCleanPairSnapshot;
  try {
    if (dependencies.captureSnapshot && !isolatedFixture()) {
      return blocked("pair_boundary_test_reader_not_allowed");
    }
    snapshot = await (dependencies.captureSnapshot ?? captureCleanPairSnapshot)(
      input.subaccountNumber, input.ticker, { creationBoundary: true },
    );
  } catch {
    return blocked("pair_boundary_clean_snapshot_read_failed");
  }
  if (!cleanSnapshotUsable(
    snapshot, input.subaccountNumber, (dependencies.now?.() ?? new Date()).getTime(), true,
  )) {
    return blocked(snapshot.reasons[0] ?? "pair_boundary_clean_snapshot_not_proven");
  }

  const boundaryEvidenceDigest = digest({
    snapshotDigest: snapshot.evidenceDigest,
    creationAttemptId: creation.attemptId,
    creationInventoryDigest: creation.inventoryDigest,
    creationVerifiedAt: creation.verifiedAt.toISOString(),
  });
  const values = {
    subaccountNumber: input.subaccountNumber,
    exchangeIndex: DEDICATED_EXCHANGE_INDEX,
    restrictedApiKeyId: null,
    restrictedKeyFingerprint: null,
    cleanBalanceMicros: "0",
    cleanBalanceSemantics: "available_cash",
    cleanSnapshotAuthenticated: true,
    cleanOrderCount: 0,
    cleanFillCount: 0,
    cleanPositionCount: 0,
    cleanSettlementCount: 0,
    cleanBoundaryAt: new Date(snapshot.capturedAt),
    cleanBoundaryEvidenceDigest: boundaryEvidenceDigest,
    creationAttemptId: creation.attemptId,
    creationInventoryDigest: creation.inventoryDigest,
    state: "CREATED_CLEAN",
  } as const;

  try {
    const inserted = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber))
        .for("update").limit(1);
      if (existing) {
        return existing.state === "CREATED_CLEAN" &&
          existing.cleanBoundaryEvidenceDigest === values.cleanBoundaryEvidenceDigest &&
          existing.creationAttemptId === creation.attemptId &&
          existing.creationInventoryDigest === creation.inventoryDigest;
      }
      const [result] = await tx.insert(microLivePairBoundaryTable)
        .values(values).onConflictDoNothing().returning({
          subaccountNumber: microLivePairBoundaryTable.subaccountNumber,
        });
      return Boolean(result);
    });
    return inserted
      ? { status: "captured", reason: "pair_created_clean_boundary_persisted",
          evidenceDigest: boundaryEvidenceDigest }
      : blocked("pair_boundary_exists_with_different_or_advanced_evidence");
  } catch {
    return blocked("pair_boundary_persistence_failed");
  }
}

/** Bind the subsequently provisioned key only after independent verifier GET. */
export async function bindMicroLivePairRestrictedKey(
  input: { subaccountNumber: number; cleanCheckedAt?: number },
  dependencies: PairBoundaryDependencies = {},
  source: "shared" | "index2" = "shared",
): Promise<BoundaryResult> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.REPLIT_DEPLOYMENT === "1") return blocked("pair_boundary_development_only");
  if (source === "index2" && (input.subaccountNumber !== PAIR_SUBACCOUNT ||
      process.env.KALSHI_API_ENVIRONMENT !== "production" ||
      !Number.isFinite(input.cleanCheckedAt) ||
      Date.now() - input.cleanCheckedAt! < 0 ||
      Date.now() - input.cleanCheckedAt! > 30_000)) {
    return blocked("pair_boundary_dedicated_key_identity_invalid");
  }
  const key = configuredKey(source);
  if (!key || (source === "shared" &&
      getConfiguredKalshiSubaccount() !== input.subaccountNumber)) {
    return blocked("pair_boundary_restricted_key_binding_mismatch");
  }
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!config || config.microLiveProductionEnabled || config.liveExecutionEnabled ||
      !config.manualKillSwitch) return blocked("pair_boundary_execution_gates_not_frozen");
  const [boundary] = await db.select().from(microLivePairBoundaryTable)
    .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber)).limit(1);
  if (!boundary || boundary.state !== "CREATED_CLEAN" ||
      boundary.creationAttemptId === null || boundary.creationInventoryDigest === null ||
      boundary.exchangeIndex !== DEDICATED_EXCHANGE_INDEX) {
    return blocked("pair_boundary_created_clean_state_required");
  }
  // N=1 already has a different, historical index-0 restricted key. Its
  // subaccount and scopes alone cannot identify the newly provisioned key.
  // Require the separate attempt's exact ID and clean-boundary provenance.
  if (input.subaccountNumber === PAIR_SUBACCOUNT &&
      !await databasePairKeyAttemptStore.bindingEligible(
        input.subaccountNumber, key.apiKeyId, {
          creationAttemptId: boundary.creationAttemptId,
          cleanBoundaryEvidenceDigest: boundary.cleanBoundaryEvidenceDigest,
        },
      )) {
    return blocked("pair_boundary_dedicated_key_attempt_not_verified");
  }
  let verified = false;
  try {
    if (dependencies.verifyKeyBinding && !isolatedFixture()) {
      return blocked("pair_boundary_test_reader_not_allowed");
    }
    verified = await (dependencies.verifyKeyBinding ??
      verifyKalshiRestrictedTradingKeyForSubaccount)(input.subaccountNumber, source);
  } catch {
    return blocked("pair_boundary_restricted_key_verification_failed");
  }
  if (!verified) return blocked("pair_boundary_restricted_key_not_exactly_bound");
  const boundAt = dependencies.now?.() ?? new Date();
  const bindingDigest = digest({
    subaccountNumber: input.subaccountNumber,
    exchangeIndex: DEDICATED_EXCHANGE_INDEX,
    apiKeyId: key.apiKeyId,
    fingerprint: key.fingerprint,
    verifiedAt: boundAt.toISOString(),
    scopes: ["read", "write::trade"],
  });
  try {
    const updated = await db.transaction(async (tx) => {
      const [lockedConfig] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [lockedLive] = await tx.select().from(liveExecutionConfigTable)
        .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
      const [locked] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber))
        .for("update").limit(1);
       if (source === "index2" &&
           (Date.now() - input.cleanCheckedAt! < 0 ||
            Date.now() - input.cleanCheckedAt! > 30_000)) return false;
       if (!lockedConfig || lockedConfig.microLiveProductionEnabled ||
           lockedConfig.liveExecutionEnabled || !lockedConfig.manualKillSwitch ||
           (source === "index2" && lockedConfig.microLiveRunPhase !== "FROZEN") ||
           !lockedLive || lockedLive.liveExecutionEnabled ||
           !lockedLive.manualKillSwitch ||
           !locked || locked.state !== "CREATED_CLEAN" ||
          locked.creationAttemptId !== boundary.creationAttemptId ||
           locked.creationInventoryDigest !== boundary.creationInventoryDigest ||
           locked.cleanBoundaryEvidenceDigest !== boundary.cleanBoundaryEvidenceDigest ||
           locked.restrictedApiKeyId !== null || locked.keyBoundAt !== null ||
           locked.fundingTransferId !== null || locked.cleanBalanceMicros !== "0") return false;
      const [row] = await tx.update(microLivePairBoundaryTable).set({
        state: "KEY_BOUND_VERIFIED",
        restrictedApiKeyId: key.apiKeyId,
        restrictedKeyFingerprint: key.fingerprint,
        keyBoundAt: boundAt,
        keyBindingEvidenceDigest: bindingDigest,
        updatedAt: boundAt,
      }).where(and(
        eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber),
        eq(microLivePairBoundaryTable.state, "CREATED_CLEAN"),
      )).returning({ subaccountNumber: microLivePairBoundaryTable.subaccountNumber });
      return Boolean(row);
    });
    return updated
      ? { status: "captured", reason: "pair_restricted_key_bound_verified",
          evidenceDigest: bindingDigest }
      : blocked("pair_boundary_key_binding_state_changed");
  } catch {
    return blocked("pair_boundary_key_binding_persistence_failed");
  }
}

/**
 * Reconcile the first exact $25 subaccount transfer against the persisted
 * prospective boundary. This only observes Kalshi; it never submits a transfer.
 */
export async function reconcileMicroLivePairFunding(
  input: { subaccountNumber: number; ticker: string; acknowledgedAttemptId?: string },
  dependencies: PairBoundaryDependencies = {},
): Promise<BoundaryResult> {
  if (process.env.NODE_ENV !== "development") return blocked("pair_boundary_development_only");
  if (!validTicker(input.ticker)) return blocked("pair_boundary_market_ticker_invalid");
  const [boundary] = await db.select().from(microLivePairBoundaryTable)
    .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber)).limit(1);
  const index2Key = input.subaccountNumber === PAIR_SUBACCOUNT &&
      boundary?.state === "KEY_BOUND_VERIFIED"
    ? configuredKey("index2")
    : null;
  const source = index2Key &&
      boundary?.restrictedApiKeyId === index2Key.apiKeyId &&
      boundary.restrictedKeyFingerprint === index2Key.fingerprint
    ? "index2" as const
    : "shared" as const;
  const key = configuredKey(source);
  if (!key || (source === "shared" &&
      getConfiguredKalshiSubaccount() !== input.subaccountNumber)) {
    return blocked("pair_boundary_restricted_key_binding_mismatch");
  }
  if (!boundary || !isFundingBoundaryEligible(boundary, {
    subaccountNumber: input.subaccountNumber,
    apiKeyId: key.apiKeyId,
    fingerprint: key.fingerprint,
  })) {
    return blocked("pair_boundary_clean_snapshot_missing_or_identity_changed");
  }
  let acknowledged: {
    attempt: MicroLivePairFundingAttempt;
    transfer: FundingTransfer;
  } | null = null;
  if (input.acknowledgedAttemptId !== undefined) {
    if (source !== "index2" || input.subaccountNumber !== 1 ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.acknowledgedAttemptId)) {
      return blocked("pair_boundary_acknowledged_recovery_invalid");
    }
    try {
      const [attempt] = await db.select().from(microLivePairFundingAttemptTable)
        .where(eq(microLivePairFundingAttemptTable.attemptId, input.acknowledgedAttemptId)).limit(1);
      if (!attempt || attempt.marketTicker !== input.ticker) {
        return blocked("pair_boundary_acknowledged_attempt_missing");
      }
      const [primary, destination, transfers] = await Promise.all([
        readPrimaryIndex2Balance(0), readPrimaryIndex2Balance(1), readPairTransferHistory(),
      ]);
      const transfer = acknowledgedFundingCashProof(
        attempt, boundary, primary, destination, transfers, Date.now(),
      );
      if (!transfer) return blocked("pair_boundary_acknowledged_cash_or_history_unproven");
      acknowledged = { attempt, transfer };
    } catch {
      return blocked("pair_boundary_acknowledged_get_failed");
    }
  }

  let firstRead: KalshiDedicatedPairEvidence;
  try {
    firstRead = await readPairEvidence(
      input.subaccountNumber, input.ticker, undefined, dependencies, source,
    );
  } catch {
    return blocked("pair_boundary_funding_history_read_failed");
  }
  if (firstRead.pair.subaccountNumber !== input.subaccountNumber ||
      firstRead.pair.exchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      !firstRead.keyRestrictionVerified || !firstRead.tradePermissionVerified ||
      firstRead.marketExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      parseMicros(firstRead.balance.availableCashDollars) !== "25000000") {
    return blocked("pair_boundary_funding_identity_or_cash_mismatch");
  }
  const ambiguousTransfer = (firstRead.records ?? []).find((record) =>
    record.feed === "cross_exchange_transfer" &&
    postBoundary(record, boundary.cleanBoundaryAt) &&
    (record.classification === "ambiguous" || isShardTwoTransfer(record)));
  if (ambiguousTransfer) {
    await freezeAmbiguousPairBoundary(
      input.subaccountNumber, "post_boundary_unattributed_transfer",
      digest({ record: ambiguousTransfer, boundary: boundary.cleanBoundaryEvidenceDigest }),
    );
    return blocked("pair_boundary_ambiguous_transfer_requires_review");
  }
  const transferCandidates = (firstRead.records ?? []).filter((record) =>
    record.feed === "subaccount_transfer" && postBoundary(record, boundary.cleanBoundaryAt));
  const anchorTransfers = transferCandidates.filter((record) =>
    transferIsExactFunding(record, input.subaccountNumber));
  if (anchorTransfers.length !== 1 || transferCandidates.length !== 1) {
    const ambiguous = (firstRead.records ?? []).find((record) =>
      (record.classification === "ambiguous" || isShardTwoTransfer(record)) &&
      (record.feed === "cross_exchange_transfer" || postBoundary(record, boundary.cleanBoundaryAt)));
    if (ambiguous) {
      await freezeAmbiguousPairBoundary(
        input.subaccountNumber, "post_boundary_unattributed_transfer",
        digest({ record: ambiguous, boundary: boundary.cleanBoundaryEvidenceDigest }),
      );
      return blocked("pair_boundary_ambiguous_transfer_requires_review");
    }
    return blocked("pair_boundary_exactly_one_completed_25_transfer_required");
  }
  const funding = anchorTransfers[0]!;
  const transferAt = new Date(funding.occurredAt!);
  if (!Number.isFinite(transferAt.getTime()) ||
      transferAt.getTime() < boundary.cleanBoundaryAt.getTime()) {
    return blocked("pair_boundary_funding_predates_clean_boundary");
  }
  if (acknowledged &&
      (funding.id !== acknowledged.transfer.transferId ||
        !recoveryInventoryAndPortfolioClean(firstRead, transferAt.getTime()))) {
    return blocked("pair_boundary_acknowledged_activity_or_inventory_unproven");
  }
  const balanceUpdatedAt = firstRead.balance.updatedTs * 1000;
  const firstScanFinishedAt = Date.parse(firstRead.scanFinishedAt);
  if (!Number.isSafeInteger(balanceUpdatedAt) ||
      balanceUpdatedAt < transferAt.getTime() ||
      !Number.isSafeInteger(firstScanFinishedAt) ||
      balanceUpdatedAt > firstScanFinishedAt + 5_000) {
    return blocked("pair_boundary_post_funding_balance_not_proven_after_transfer");
  }

  const transferId = funding.id;
  const postFundingAt = new Date(firstScanFinishedAt);
  const scanDigest = digest({
    pair: firstRead.pair,
    balance: firstRead.balance,
    transfer: funding,
    records: firstRead.records,
    scanStartedAt: firstRead.scanStartedAt,
    scanFinishedAt: firstRead.scanFinishedAt,
  });
  const anchor: KalshiDedicatedPairFundingAnchor = {
    transferId,
    transferredAt: transferAt.toISOString(),
    amountCents: 2500,
    baselineCashMicros: "25000000",
    baselineAt: postFundingAt.toISOString(),
    preFundingZeroSnapshot: {
      availableCashMicros: "0",
      capturedAt: boundary.cleanBoundaryAt.toISOString(),
      evidenceDigest: boundary.cleanBoundaryEvidenceDigest,
      authenticated: true,
      balanceSemantics: "available_cash",
    },
    postFundingSnapshot: {
      availableCashMicros: "25000000",
      capturedAt: postFundingAt.toISOString(),
      evidenceDigest: scanDigest,
      authenticated: true,
      balanceSemantics: "available_cash",
    },
  };
  let proof: KalshiDedicatedPairEvidence;
  try {
    proof = await readPairEvidence(input.subaccountNumber, input.ticker, anchor, dependencies, source);
  } catch {
    return blocked("pair_boundary_funding_recheck_failed");
  }
  const lateAcknowledgedRecovery = Boolean(acknowledged &&
    transferId === acknowledged.transfer.transferId &&
    anchor.postFundingSnapshot?.capturedAt === postFundingAt.toISOString() &&
    anchor.postFundingSnapshot.evidenceDigest === scanDigest &&
    anchor.postFundingSnapshot.availableCashMicros === "25000000" &&
    anchor.baselineAt === postFundingAt.toISOString() &&
    postFundingAt.getTime() >= transferAt.getTime() &&
    recoveryInventoryAndPortfolioClean(proof, transferAt.getTime()) &&
    proof.postAnchorCashDeltaMicros === "0");
  const proofReasons = historyReasons(
    proof, persistedCleanBoundaryIsTrusted(boundary), lateAcknowledgedRecovery,
  );
  if (proofReasons.length > 0 || proof.balance.subaccountNumber !== input.subaccountNumber ||
      proof.balance.exchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      proof.marketExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      !proof.keyRestrictionVerified || !proof.tradePermissionVerified ||
      parseMicros(proof.balance.availableCashDollars) !== "25000000" ||
      proof.records?.some((record) =>
        record.classification === "ambiguous" && postBoundary(record, boundary.cleanBoundaryAt) ||
        record.feed === "position" && record.classification === "pair" &&
          record.details.position_fp !== "0" && record.details.position !== "0" ||
        ["current_order", "historical_order", "current_fill", "historical_fill", "settlement"]
          .includes(record.feed) && record.classification === "pair" &&
          postBoundary(record, boundary.cleanBoundaryAt))) {
    const ambiguous = proof.records?.find((record) =>
      (record.classification === "ambiguous" || isShardTwoTransfer(record)) &&
      postBoundary(record, boundary.cleanBoundaryAt));
    if (ambiguous) {
      await freezeAmbiguousPairBoundary(
        input.subaccountNumber, "post_boundary_unattributed_activity",
        digest({ record: ambiguous, boundary: boundary.cleanBoundaryEvidenceDigest }),
      );
    }
    return blocked(proofReasons[0] ?? "pair_boundary_funding_activity_unexplained");
  }
  if (acknowledged) {
    try {
      const [primary, destination, transfers] = await Promise.all([
        readPrimaryIndex2Balance(0), readPrimaryIndex2Balance(1), readPairTransferHistory(),
      ]);
      if (acknowledgedFundingCashProof(
        acknowledged.attempt, boundary, primary, destination, transfers, Date.now(),
      )?.transferId !== transferId) {
        return blocked("pair_boundary_acknowledged_final_get_changed");
      }
    } catch {
      return blocked("pair_boundary_acknowledged_final_get_failed");
    }
  }

  const confirmedDigest = digest({
    cleanBoundaryDigest: boundary.cleanBoundaryEvidenceDigest,
    fundingTransferId: transferId,
    fundingTransferredAt: transferAt.toISOString(),
    postFundingSnapshotDigest: scanDigest,
    confirmationDigest: proof.checkpointDigest ?? digest(proof.records),
  });
  try {
    const persisted = await db.transaction(async (tx) => {
      const [lockedConfig] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [lockedLive] = await tx.select().from(liveExecutionConfigTable)
        .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
      const [locked] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber))
        .for("update").limit(1);
      const [lockedAttempt] = acknowledged
        ? await tx.select().from(microLivePairFundingAttemptTable)
          .where(eq(microLivePairFundingAttemptTable.attemptId, acknowledged.attempt.attemptId))
          .for("update").limit(1)
        : [undefined];
      if (!lockedConfig || lockedConfig.microLiveRunPhase !== "FROZEN" ||
          !lockedConfig.manualKillSwitch || lockedConfig.microLiveProductionEnabled ||
          lockedConfig.liveExecutionEnabled ||
          process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true" ||
          process.env.LIVE_EXECUTION_ENABLED === "true" ||
          !lockedLive || !lockedLive.manualKillSwitch || lockedLive.liveExecutionEnabled ||
          !locked || locked.state !== "KEY_BOUND_VERIFIED" ||
          locked.cleanBoundaryEvidenceDigest !== boundary.cleanBoundaryEvidenceDigest ||
          locked.keyBindingEvidenceDigest !== boundary.keyBindingEvidenceDigest ||
          locked.restrictedKeyFingerprint !== key.fingerprint ||
          (acknowledged && (
            lockedAttempt?.state !== "response_received" ||
            !lockedAttempt.responseReceivedAt ||
            lockedAttempt.attemptedAt.getTime() !== acknowledged.attempt.attemptedAt.getTime() ||
            lockedAttempt.responseReceivedAt.getTime() !==
              acknowledged.attempt.responseReceivedAt!.getTime() ||
            lockedAttempt.sourceScopedBeforeMicros !==
              acknowledged.attempt.sourceScopedBeforeMicros ||
            lockedAttempt.sourceInventoryBeforeMicros !==
              acknowledged.attempt.sourceInventoryBeforeMicros ||
            lockedAttempt.cleanBoundaryDigest !== locked.cleanBoundaryEvidenceDigest ||
            lockedAttempt.marketTicker !== input.ticker ||
            lockedAttempt.transferId !== null
          ))) return false;
      const updated = await tx.update(microLivePairBoundaryTable).set({
        state: "funded",
        fundingTransferId: transferId,
        fundingAmountCents: 2500,
        fundingTransferredAt: transferAt,
        postFundingBalanceMicros: "25000000",
        postFundingBalanceSemantics: "available_cash",
        postFundingSnapshotAuthenticated: true,
        postFundingSnapshotAt: postFundingAt,
        postFundingEvidenceDigest: confirmedDigest,
        activityCheckpointCursor: `boundary:${confirmedDigest}`,
        activityCheckpointAt: postFundingAt,
        activityCheckpointDigest: confirmedDigest,
        updatedAt: new Date(),
      }).where(and(
        eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber),
        eq(microLivePairBoundaryTable.state, "KEY_BOUND_VERIFIED"),
      )).returning({ subaccountNumber: microLivePairBoundaryTable.subaccountNumber });
      return Boolean(updated[0]);
    });
    return persisted
      ? { status: "funded", reason: "pair_25_funding_reconciled",
          evidenceDigest: confirmedDigest }
      : blocked("pair_boundary_funding_state_changed");
  } catch {
    return blocked("pair_boundary_funding_persistence_failed");
  }
}

async function freshFeeProof(
  config: typeof microLiveConfigTable.$inferSelect,
  ticker: string,
  dependencies: PairBoundaryDependencies,
  now: Date,
): Promise<{ approval: StandingFeePolicyApproval; fingerprint: string; checkedAt: number } | null> {
  const approval = await (dependencies.readFeeApproval ?? approvedFeeSession)();
  if (!approval || !config.microLiveFeeApprovalApproved ||
      config.microLiveFeeApprovalInvalidated ||
      config.microLiveFeeApprovalId !== approval.id ||
      config.microLiveFeeApprovalDigest !== approval.digest ||
      !standingFeePolicyApprovalIsValid(approval, config.microLiveRunCapMicros)) return null;
  const terms = await (dependencies.readFeeTerms ?? readCurrentEntryFeeTerms)(ticker);
  if (!terms || terms.ticker !== ticker ||
      !feeEvidenceMatchesApproval(terms.fingerprint, approval) ||
      now.getTime() - terms.verifiedAt < 0 ||
      now.getTime() - terms.verifiedAt > 15_000) return null;
  const state = await getFeeVerificationState({
    approvalId: approval.id,
    approvalDigest: approval.digest,
    policyVersion: approval.policyVersion,
    sourceUrl: config.microLiveFeeApprovalSourceUrl ?? "",
    formulaVersion: config.microLiveFeeFormulaVersion ?? "",
  });
  if (!state || state.status !== "verified" || state.feeEvidenceFingerprint !== terms.fingerprint ||
      !state.checkedAt || state.checkedAt.getTime() !== terms.verifiedAt ||
      now.getTime() - state.checkedAt.getTime() < 0 ||
      now.getTime() - state.checkedAt.getTime() > 15_000) return null;
  return { approval, fingerprint: terms.fingerprint, checkedAt: terms.verifiedAt };
}

/** Create a fresh bounded run from a reconciled prospective (N,2) boundary. */
export async function initializeMicroLivePairRun(
  input: { subaccountNumber: number; ticker: string },
  dependencies: PairBoundaryDependencies = {},
): Promise<BoundaryResult> {
  if (process.env.NODE_ENV !== "development") return blocked("pair_boundary_development_only");
  if (!validTicker(input.ticker)) return blocked("pair_boundary_market_ticker_invalid");
  const key = configuredKey();
  if (!key || getConfiguredKalshiSubaccount() !== input.subaccountNumber) {
    return blocked("pair_boundary_restricted_key_binding_mismatch");
  }
  const [boundary] = await db.select().from(microLivePairBoundaryTable)
    .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber)).limit(1);
  if (!boundary || boundary.state !== "funded" || boundary.ambiguityFrozenAt ||
      boundary.restrictedApiKeyId !== key.apiKeyId ||
      boundary.restrictedKeyFingerprint !== key.fingerprint) {
    if (boundary?.state === "initialized" && boundary.initializedRunId) {
      const [config] = await db.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
      return config?.microLiveRunId === boundary.initializedRunId
        ? { status: "initialized", reason: "pair_run_already_initialized",
            runId: boundary.initializedRunId }
        : blocked("pair_boundary_initialized_run_identity_changed");
    }
    return blocked("pair_boundary_funded_state_required");
  }
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!config || config.microLiveRunId !== null ||
      config.microLiveRunPhase !== "UNARMED" ||
      config.microLiveProductionEnabled || config.liveExecutionEnabled ||
      !config.manualKillSwitch || config.microLiveEntryAttempted ||
      config.microLiveExitAttempted || config.microLiveReservedMicros !== 0 ||
      config.microLiveSelectedSubaccount !== null ||
      config.microLiveSelectedExchangeIndex !== null) {
    return blocked("pair_initializer_requires_pristine_unarmed_singleton");
  }
  const [existingOrders, existingFills, existingSettlements] = await Promise.all([
    db.select().from(microLiveOrderTable),
    db.select().from(microLiveFillTable),
    db.select().from(microLiveSettlementTable),
  ]);
  if (existingOrders.length || existingFills.length || existingSettlements.length) {
    return blocked("pair_initializer_requires_empty_local_ledger");
  }
  const now = dependencies.now?.() ?? new Date();
  const fee = await freshFeeProof(config, input.ticker, dependencies, now).catch(() => null);
  if (!fee) return blocked("pair_initializer_fee_verification_not_current");
  const anchor = fundingAnchorFromRow(boundary);
  if (!anchor) return blocked("pair_boundary_funding_evidence_incomplete");
  let evidence: KalshiDedicatedPairEvidence;
  try {
    evidence = await readPairEvidence(input.subaccountNumber, input.ticker, anchor, dependencies);
  } catch {
    return blocked("pair_initializer_account_evidence_read_failed");
  }
  const reasons = historyReasons(evidence, persistedCleanBoundaryIsTrusted(boundary),
    await persistedAcknowledgedLateRecovery(boundary, evidence, input.ticker));
  const records = evidence.records ?? [];
  const checkpointDigest = evidence.checkpointDigest ?? digest({
    boundaryDigest: boundary.cleanBoundaryEvidenceDigest,
    fundingDigest: boundary.postFundingEvidenceDigest,
    transferId: boundary.fundingTransferId,
    records,
    scanStartedAt: evidence.scanStartedAt,
    scanFinishedAt: evidence.scanFinishedAt,
  });
  const unexpected = records.find((record) =>
    record.classification === "ambiguous" && postBoundary(record, boundary.cleanBoundaryAt) ||
    isShardTwoTransfer(record) && postBoundary(record, boundary.cleanBoundaryAt) ||
    record.feed === "subaccount_transfer" && record.classification === "pair" &&
      record.id !== boundary.fundingTransferId && postBoundary(record, boundary.cleanBoundaryAt) ||
    ["current_order", "historical_order", "current_fill", "historical_fill", "settlement"]
      .includes(record.feed) && record.classification === "pair" &&
      postBoundary(record, boundary.cleanBoundaryAt) ||
    record.feed === "position" && record.classification === "pair" &&
      record.details.position_fp !== "0" && record.details.position !== "0");
  if (unexpected || reasons.length || !evidence.keyRestrictionVerified ||
      !evidence.tradePermissionVerified ||
      evidence.marketExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      parseMicros(evidence.balance.availableCashDollars) !== "25000000" ||
      !anchor.transferId || anchor.transferId !== boundary.fundingTransferId ||
      !/^[0-9a-f]{64}$/.test(checkpointDigest)) {
    if (unexpected && (unexpected.classification === "ambiguous" ||
        isShardTwoTransfer(unexpected) ||
        unexpected.feed === "subaccount_transfer" &&
          unexpected.id !== boundary.fundingTransferId)) {
      await freezeAmbiguousPairBoundary(
        input.subaccountNumber, "pair_initializer_unattributed_activity",
        digest({ record: unexpected, boundary: boundary.cleanBoundaryEvidenceDigest }),
      );
    }
    return blocked(reasons[0] ?? "pair_initializer_account_evidence_unreconciled");
  }
  const observedScanAt = Date.parse(evidence.scanFinishedAt);
  const effectiveNow = new Date(Math.max(
    now.getTime(), observedScanAt, boundary.postFundingSnapshotAt?.getTime() ?? 0,
  ));
  if (!Number.isSafeInteger(observedScanAt) || observedScanAt <= 0 ||
      effectiveNow.getTime() - fee.checkedAt < 0 ||
      effectiveNow.getTime() - fee.checkedAt > 15_000) {
    return blocked("pair_initializer_evidence_or_fee_proof_stale");
  }
  const runId = randomUUID();
  const cursor = `boundary:${checkpointDigest}`;
  try {
    const initialized = await db.transaction(async (tx) => {
      const [lockedConfig] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [lockedBoundary] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber))
        .for("update").limit(1);
      if (!lockedBoundary || !lockedConfig ||
          lockedBoundary.state !== "funded" ||
          lockedBoundary.cleanBoundaryEvidenceDigest !== boundary.cleanBoundaryEvidenceDigest ||
          lockedBoundary.fundingTransferId !== boundary.fundingTransferId ||
          lockedConfig.microLiveRunId !== null ||
          lockedConfig.microLiveRunPhase !== "UNARMED" ||
          lockedConfig.microLiveProductionEnabled || lockedConfig.liveExecutionEnabled ||
          !lockedConfig.manualKillSwitch || lockedConfig.microLiveSelectedSubaccount !== null ||
          lockedConfig.microLiveSelectedExchangeIndex !== null ||
          !await lockFeeVerificationForPost(tx, {
            approvalId: fee.approval.id,
            approvalDigest: fee.approval.digest,
            policyVersion: fee.approval.policyVersion,
            sourceUrl: lockedConfig.microLiveFeeApprovalSourceUrl ?? "",
            formulaVersion: lockedConfig.microLiveFeeFormulaVersion ?? "",
            }, fee.fingerprint, fee.checkedAt, effectiveNow.getTime())) return false;
      const [orders] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(microLiveOrderTable);
      const [fills] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(microLiveFillTable);
      const [settlements] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(microLiveSettlementTable);
      if ((orders?.count ?? 0) !== 0 || (fills?.count ?? 0) !== 0 ||
          (settlements?.count ?? 0) !== 0) return false;
      const updatedBoundary = await tx.update(microLivePairBoundaryTable).set({
        state: "initialized",
        initializedRunId: runId,
        initializedAt: effectiveNow,
        activityCheckpointCursor: cursor,
        activityCheckpointAt: new Date(evidence.scanFinishedAt),
        activityCheckpointDigest: checkpointDigest,
        updatedAt: effectiveNow,
      }).where(and(
        eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber),
        eq(microLivePairBoundaryTable.state, "funded"),
      )).returning({
        subaccountNumber: microLivePairBoundaryTable.subaccountNumber,
      });
      if (!updatedBoundary[0]) return false;
      const updatedConfig = await tx.update(microLiveConfigTable).set({
        microLiveRunId: runId,
        microLiveRunPhase: "UNARMED",
        microLiveEntryAttempted: false,
        microLiveExitAttempted: false,
        microLiveRunArmedAt: null,
        microLiveRunDeadline: null,
        microLiveRunApprovalId: null,
        microLiveRunApprovalDigest: null,
        microLiveRunFreezeReason: null,
        microLiveAccountMode: "exclusive",
        microLiveSelectedSubaccount: input.subaccountNumber,
        microLiveSelectedExchangeIndex: DEDICATED_EXCHANGE_INDEX,
        microLiveRestrictedApiKeyId: key.apiKeyId,
        microLiveRestrictedKeyFingerprint: key.fingerprint,
        microLiveFundingAnchorSubaccount: input.subaccountNumber,
        microLiveFundingAnchorExchangeIndex: DEDICATED_EXCHANGE_INDEX,
        microLiveFundingAnchorTransferId: boundary.fundingTransferId,
        microLiveFundingAnchorTransferAt: boundary.fundingTransferredAt,
        microLiveFundingAnchorAmountCents: 2500,
        microLivePairCashBaselineMicros: "25000000",
        microLivePairCashBaselineRunId: runId,
        microLivePairCashBaselineAt: boundary.postFundingSnapshotAt,
        microLivePairCashBaselineEvidenceDigest: boundary.postFundingEvidenceDigest,
        microLiveAccountActivityCheckpointRunId: runId,
        microLiveAccountActivityCheckpointCursor: cursor,
        microLiveAccountActivityCheckpointAt: new Date(evidence.scanFinishedAt),
        microLiveAccountActivityCheckpointEvidenceDigest: checkpointDigest,
        microLiveAccountActivityCheckpointSubaccount: input.subaccountNumber,
        microLiveAccountActivityCheckpointExchangeIndex: DEDICATED_EXCHANGE_INDEX,
        microLiveAccountingUnresolved: false,
        microLiveAccountingUnresolvedReason: null,
        manualKillSwitch: true,
        microLiveProductionEnabled: false,
        liveExecutionEnabled: false,
        updatedAt: effectiveNow,
      }).where(and(
        eq(microLiveConfigTable.id, "singleton"),
        isNull(microLiveConfigTable.microLiveRunId),
        eq(microLiveConfigTable.microLiveRunPhase, "UNARMED"),
        eq(microLiveConfigTable.manualKillSwitch, true),
        eq(microLiveConfigTable.microLiveProductionEnabled, false),
        eq(microLiveConfigTable.liveExecutionEnabled, false),
      )).returning({ id: microLiveConfigTable.id });
      if (!updatedConfig[0]) throw new Error("pair_config_interlock_failed");
      return true;
    });
    return initialized
      ? { status: "initialized", reason: "pair_new_run_initialized_gates_remain_closed",
          runId, evidenceDigest: checkpointDigest }
      : blocked("pair_initializer_transaction_interlock_failed");
  } catch (error) {
    return transactionFailure("pair_initializer_transaction_failed", error);
  }
}

async function freezeAmbiguousPairBoundary(
  subaccountNumber: number,
  reason: string,
  evidenceDigest: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) return;
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      const [boundary] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber))
        .for("update").limit(1);
      if (!boundary || boundary.ambiguityFrozenAt) return;
      await tx.update(microLivePairBoundaryTable).set({
        state: "frozen",
        ambiguityFrozenAt: now,
        ambiguityFreezeReason: reason,
        ambiguityEvidenceDigest: evidenceDigest,
        updatedAt: now,
      }).where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber));
      await tx.update(microLiveConfigTable).set({
        manualKillSwitch: true,
        microLiveProductionEnabled: false,
        liveExecutionEnabled: false,
        microLiveRunPhase: "FROZEN",
        microLiveRunFreezeReason: "dedicated_pair_ambiguous_cross_exchange_transfer",
        microLiveAccountingUnresolved: true,
        microLiveAccountingUnresolvedReason: reason,
        updatedAt: now,
      }).where(and(
        eq(microLiveConfigTable.id, "singleton"),
        eq(microLiveConfigTable.microLiveSelectedSubaccount, subaccountNumber),
        eq(microLiveConfigTable.microLiveSelectedExchangeIndex, DEDICATED_EXCHANGE_INDEX),
      ));
    });
  } catch {
    // A failed freeze commit is not success; callers block the operation.
  }
}

/**
 * Verify the persisted boundary before startup readiness or the signed-order
 * guard. Unknown shard-2 cross-exchange transfers permanently freeze the pair.
 */
export async function verifyMicroLivePairBoundary(
  input: { subaccountNumber: number; ticker: string; runId: string },
  dependencies: PairBoundaryDependencies = {},
): Promise<BoundaryResult> {
  const [boundary] = await db.select().from(microLivePairBoundaryTable)
    .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber)).limit(1);
  const key = configuredKey();
  if (!boundary || boundary.state !== "initialized" || boundary.ambiguityFrozenAt ||
      boundary.initializedRunId !== input.runId || !key ||
      boundary.restrictedApiKeyId !== key.apiKeyId ||
      boundary.restrictedKeyFingerprint !== key.fingerprint ||
      getConfiguredKalshiSubaccount() !== input.subaccountNumber) {
    return blocked("pair_boundary_run_or_key_identity_mismatch");
  }
  const anchor = fundingAnchorFromRow(boundary);
  if (!anchor) return blocked("pair_boundary_anchor_evidence_incomplete");
  let evidence: KalshiDedicatedPairEvidence;
  try {
    evidence = await readPairEvidence(input.subaccountNumber, input.ticker, anchor, dependencies);
  } catch {
    return blocked("pair_boundary_account_evidence_read_failed");
  }

  const ambiguous = evidence.records?.find((record) =>
    (isShardTwoTransfer(record) || record.classification === "ambiguous" ||
      record.feed === "subaccount_transfer" &&
        record.classification === "pair" && record.id !== boundary.fundingTransferId) &&
    postBoundary(record, boundary.cleanBoundaryAt));
  if (ambiguous) {
    await freezeAmbiguousPairBoundary(
      input.subaccountNumber, "post_boundary_unattributed_or_external_transfer",
      digest({ record: ambiguous, boundary: boundary.cleanBoundaryEvidenceDigest }),
    );
    return blocked("pair_boundary_ambiguous_post_boundary_transfer_frozen");
  }
  const reasons = historyReasons(evidence, persistedCleanBoundaryIsTrusted(boundary),
    await persistedAcknowledgedLateRecovery(boundary, evidence, input.ticker));
  if (reasons.length || !evidence.keyRestrictionVerified ||
      !evidence.tradePermissionVerified ||
      evidence.marketExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      parseMicros(evidence.balance.availableCashDollars) === null ||
      !Number.isSafeInteger(Date.parse(evidence.scanFinishedAt)) ||
      Math.abs(Date.now() - Date.parse(evidence.scanFinishedAt)) > 15_000) {
    return blocked(reasons[0] ?? "pair_boundary_account_evidence_incomplete");
  }

  const [localOrders, localFills, localSettlements] = await Promise.all([
    db.select().from(microLiveOrderTable),
    db.select().from(microLiveFillTable),
    db.select().from(microLiveSettlementTable),
  ]);
  const accountOrders = new Set((evidence.records ?? [])
    .filter((record) =>
      record.classification === "pair" &&
      (record.feed === "current_order" || record.feed === "historical_order"))
    .map((record) => record.id));
  const localOrderIds = new Set(localOrders.flatMap((order) =>
    order.exchangeOrderId ? [order.exchangeOrderId] : []));
  const accountFills = new Set((evidence.records ?? [])
    .filter((record) =>
      record.classification === "pair" &&
      (record.feed === "current_fill" || record.feed === "historical_fill"))
    .map((record) => record.id));
  const localFillIds = new Set(localFills.map((fill) => fill.exchangeFillId));
  const accountSettlements = new Set((evidence.records ?? [])
    .filter((record) => record.classification === "pair" && record.feed === "settlement")
    .map((record) => record.details.ticker).filter((ticker): ticker is string => Boolean(ticker)));
  const localSettlementTickers = new Set(localSettlements.map((row) => row.marketTicker));
  const equalSets = (left: Set<string>, right: Set<string>) =>
    left.size === right.size && [...left].every((value) => right.has(value));
  if (!equalSets(accountOrders, localOrderIds) ||
      !equalSets(accountFills, localFillIds) ||
      !equalSets(accountSettlements, localSettlementTickers)) {
    return blocked("pair_boundary_exchange_history_local_ledger_mismatch");
  }
  const identityStillCurrent = await db.transaction(async (tx) => {
    const [lockedConfig] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    const [lockedBoundary] = await tx.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber))
      .for("update").limit(1);
    return Boolean(lockedBoundary && lockedConfig &&
      lockedBoundary.state === "initialized" && !lockedBoundary.ambiguityFrozenAt &&
      lockedBoundary.initializedRunId === input.runId &&
      lockedBoundary.cleanBoundaryEvidenceDigest === boundary.cleanBoundaryEvidenceDigest &&
      lockedBoundary.activityCheckpointDigest === boundary.activityCheckpointDigest &&
      lockedConfig.microLiveRunId === input.runId &&
      lockedConfig.microLiveAccountMode === "exclusive" &&
      lockedConfig.microLiveSelectedSubaccount === input.subaccountNumber &&
      lockedConfig.microLiveSelectedExchangeIndex === DEDICATED_EXCHANGE_INDEX &&
      lockedConfig.microLiveRestrictedApiKeyId === key.apiKeyId &&
      lockedConfig.microLiveRestrictedKeyFingerprint === key.fingerprint &&
      lockedConfig.microLiveFundingAnchorTransferId === boundary.fundingTransferId &&
      lockedConfig.microLivePairCashBaselineEvidenceDigest ===
        boundary.postFundingEvidenceDigest &&
      lockedConfig.microLiveAccountActivityCheckpointRunId === input.runId &&
      lockedConfig.microLiveAccountActivityCheckpointEvidenceDigest ===
        boundary.activityCheckpointDigest);
  }).catch(() => false);
  if (!identityStillCurrent) return blocked("pair_boundary_state_changed_during_account_scan");

  // Keep the legacy runtime guard closed until runtime consumes the exported
  // collateral proof together with a separate lock-through-POST barrier.
  return blocked("pair_boundary_full_hold_cash_restart_and_exit_proof_required");
}

/**
 * Reconcile the authenticated (N, exchange_index=2) orders, fills, inventory,
 * fees, cash holds and persisted run ledger. This is proof only: it never arms
 * execution or authorizes a POST, and the caller must still establish its own
 * lock-through-mutation barrier.
 */
export async function reconcileMicroLivePairCollateral(
  input: {
    subaccountNumber: number;
    ticker: string;
    runId: string;
    mode: MicroLivePairCollateralMode;
  },
  dependencies: PairBoundaryDependencies = {},
): Promise<MicroLivePairCollateralProof> {
  const now = () => (dependencies.now?.() ?? new Date()).getTime();
  const checkedAt = now();
  const fail = (reason: string): MicroLivePairCollateralProof => ({
    status: "blocked", reason, checkedAt, mode: input.mode,
    proofKind: "collateral_reconciliation_only", authorization: "none",
  });
  let boundary: typeof microLivePairBoundaryTable.$inferSelect | undefined;
  let config: PairCollateralConfig | undefined;
  try {
    [[boundary], [config]] = await Promise.all([
      db.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber))
        .limit(1),
      db.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).limit(1),
    ]);
  } catch {
    return fail("pair_collateral_initial_state_read_failed");
  }
  const key = configuredKey();
  if (!boundary || boundary.state !== "initialized" || boundary.ambiguityFrozenAt ||
      boundary.initializedRunId !== input.runId || !key ||
      boundary.restrictedApiKeyId !== key.apiKeyId ||
      boundary.restrictedKeyFingerprint !== key.fingerprint ||
      getConfiguredKalshiSubaccount() !== input.subaccountNumber ||
      !config || config.microLiveRunId !== input.runId ||
      config.microLiveAccountMode !== "exclusive" ||
      config.microLiveSelectedSubaccount !== input.subaccountNumber ||
      config.microLiveSelectedExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      config.microLiveRestrictedApiKeyId !== key.apiKeyId ||
      config.microLiveRestrictedKeyFingerprint !== key.fingerprint ||
      config.microLiveFundingAnchorTransferId !== boundary.fundingTransferId ||
      config.microLivePairCashBaselineEvidenceDigest !== boundary.postFundingEvidenceDigest ||
      config.microLiveAccountActivityCheckpointRunId !== input.runId ||
      config.microLiveAccountActivityCheckpointEvidenceDigest !==
        boundary.activityCheckpointDigest) {
    return fail("pair_collateral_run_or_key_identity_mismatch");
  }
  if (!pairCollateralModeMatches(config, input.mode)) {
    return fail("pair_collateral_config_mode_mismatch");
  }
  const startingBoundaryDigest = digest(boundary);
  const startingConfigDigest = digest(config);
  const anchor = fundingAnchorFromRow(boundary);
  if (!anchor || boundary.postFundingBalanceMicros !== "25000000") {
    return fail("pair_collateral_persisted_anchor_incomplete");
  }
  let local: {
    orders: typeof microLiveOrderTable.$inferSelect[];
    fills: typeof microLiveFillTable.$inferSelect[];
    settlements: typeof microLiveSettlementTable.$inferSelect[];
  };
  try {
    const [orders, fills, settlements] = await Promise.all([
      db.select().from(microLiveOrderTable),
      db.select().from(microLiveFillTable),
      db.select().from(microLiveSettlementTable),
    ]);
    local = { orders, fills, settlements };
  } catch {
    return fail("pair_collateral_local_ledger_read_failed");
  }
  let evidence: KalshiDedicatedPairEvidence;
  try {
    evidence = await readPairEvidence(
      input.subaccountNumber, input.ticker, anchor, dependencies,
    );
  } catch {
    return fail("pair_collateral_account_evidence_read_failed");
  }
  const ambiguous = evidence.records?.find((record) =>
    (isShardTwoTransfer(record) || record.classification === "ambiguous" ||
      record.feed === "subaccount_transfer" &&
        record.classification === "pair" && record.id !== boundary.fundingTransferId) &&
    postBoundary(record, boundary.cleanBoundaryAt));
  if (ambiguous) {
    await freezeAmbiguousPairBoundary(
      input.subaccountNumber, "post_boundary_unattributed_or_external_transfer",
      digest({ record: ambiguous, boundary: boundary.cleanBoundaryEvidenceDigest }),
    );
    return fail("pair_boundary_ambiguous_post_boundary_transfer_frozen");
  }
  const reasons = historyReasons(evidence, persistedCleanBoundaryIsTrusted(boundary),
    await persistedAcknowledgedLateRecovery(boundary, evidence, input.ticker));
  if (reasons.length || !evidence.keyRestrictionVerified ||
      !evidence.tradePermissionVerified ||
      evidence.marketExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      parseMicros(evidence.balance.availableCashDollars) === null ||
      !Number.isFinite(Date.parse(evidence.scanFinishedAt)) ||
      Date.parse(evidence.scanFinishedAt) > now() + 5_000 ||
      now() - Date.parse(evidence.scanFinishedAt) > 15_000) {
    return fail(reasons[0] ?? "pair_collateral_account_evidence_incomplete");
  }
  const collateral = reconcilePairCollateralLedger({
    evidence: { ...evidence, reasons, reason: null },
    local,
    subaccountNumber: input.subaccountNumber,
    runId: input.runId,
    baselineCashMicros: anchor.baselineCashMicros,
    now: now(),
  });
  if (collateral.status !== "verified") {
    return {
      ...collateral,
      mode: input.mode,
      proofKind: "collateral_reconciliation_only",
      authorization: "none",
    };
  }

  const ledgerDigest = (value: typeof local) => digest({
    orders: [...value.orders].sort((a, b) => a.id.localeCompare(b.id)),
    fills: [...value.fills].sort((a, b) =>
      a.exchangeFillId.localeCompare(b.exchangeFillId)),
    settlements: [...value.settlements].sort((a, b) =>
      a.positionId.localeCompare(b.positionId)),
  });
  const startingLedgerDigest = ledgerDigest(local);
  let evidenceWentStaleAtCommit = false;
  const identityAndLedgerStillCurrent = await db.transaction(async (tx) => {
    // Match the submit path's global lock order: config -> boundary -> ledger.
    const [lockedConfig] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    const [lockedBoundary] = await tx.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, input.subaccountNumber))
      .for("update").limit(1);
    await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
      ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
    const [orders, fills, settlements] = await Promise.all([
      tx.select().from(microLiveOrderTable),
      tx.select().from(microLiveFillTable),
      tx.select().from(microLiveSettlementTable),
    ]);
    const evidenceFinishedAt = Date.parse(evidence.scanFinishedAt);
    const committedAt = now();
    if (!Number.isFinite(evidenceFinishedAt) ||
        evidenceFinishedAt > committedAt + 5_000 ||
        committedAt - evidenceFinishedAt > 15_000) {
      evidenceWentStaleAtCommit = true;
      return false;
    }
    return Boolean(lockedBoundary && lockedConfig &&
      lockedBoundary.state === "initialized" && !lockedBoundary.ambiguityFrozenAt &&
      lockedBoundary.initializedRunId === input.runId &&
      digest(lockedBoundary) === startingBoundaryDigest &&
      lockedConfig.microLiveRunId === input.runId &&
      digest(lockedConfig) === startingConfigDigest &&
      pairCollateralModeMatches(lockedConfig, input.mode) &&
      ledgerDigest({ orders, fills, settlements }) === startingLedgerDigest);
  }).catch(() => false);
  if (!identityAndLedgerStillCurrent) {
    return fail(evidenceWentStaleAtCommit
      ? "pair_collateral_signed_evidence_stale_at_commit"
      : "pair_collateral_state_or_local_ledger_changed_during_scan");
  }
  return {
    ...collateral,
    mode: input.mode,
    proofKind: "collateral_reconciliation_only",
    authorization: "none",
    runId: input.runId,
    boundaryEvidenceDigest: boundary.cleanBoundaryEvidenceDigest,
    configStateDigest: startingConfigDigest,
    evidenceDigest: digest({
      mode: input.mode,
      configStateDigest: startingConfigDigest,
      boundary: boundary.cleanBoundaryEvidenceDigest,
      activityCheckpoint: boundary.activityCheckpointDigest,
      records: (evidence.records ?? []).map((record) => [
        record.feed, record.id, record.payloadDigest,
      ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      collateral,
      ledger: startingLedgerDigest,
    }),
  };
}