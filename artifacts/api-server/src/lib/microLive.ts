import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import {
  forwardTestEngineTable,
  forwardTestEvaluationTable,
  microLiveConfigTable,
  microLiveRunArchiveTable,
  microLiveDecisionTable,
  microLiveFillTable,
  microLiveSettlementTable,
  microLiveOrderTable,
  microLivePairBoundaryTable,
  microLiveFeeVerificationTable,
  db,
} from "@workspace/db";
import type {
  KalshiAccountActivity, KalshiAccountSnapshot,
  KalshiHistoricalFillsSnapshot, KalshiSettlementsSnapshot,
} from "./kalshiAccountClient";
import {
  getConfiguredKalshiSubaccount, readKalshiAccount, readKalshiAccountActivity,
  readKalshiHistoricalFills, readKalshiOrderbook, readKalshiSettlements,
} from "./kalshiAccountClient";
import {
  reconcileMicroLivePairCollateral,
  type MicroLivePairCollateralMode,
  type MicroLivePairCollateralProof,
  type PairBoundaryDependencies,
} from "./microLivePairBoundary";
import {
  diagnoseMicroLiveAccountActivity, diagnosePrimaryMicroLiveAccountActivity,
  separateMicroLiveAccountActivity,
} from "./microLiveOwnership";
import {
  authorizeKalshiCancellation,
  authorizeKalshiSubmission,
  createKalshiTradingClient,
  type KalshiShardTwoPairEvidence,
  type KalshiLimitOrderRequest,
  type KalshiOrder,
} from "./kalshiTradingClient";
import { publicForwardTestFeeds } from "./forwardTestFeeds";
import { FORWARD_TEST_ENGINE_ID } from "./forwardTestRepository";
import { fifoExitCostBasis, reconstructMicroLivePositions } from "./microLivePosition";
import { dollarsToMicros, fillTradeMicros, microsToRoundedCents } from "./microLiveMoney";
import {
  computeBotAttributableAvailableCashDelta,
  reconcilePrimaryCashActivityCheckpoint,
  type PrimaryCashActivityCheckpoint,
  type PrimaryCashActivityScan,
  type PrimaryCashBaseline,
  type PrimaryCashSettlementEvidence,
} from "./microLivePrimaryCashAccounting";
import { LIVE_TEST_CAP_MICROS, withinAllInLiveTestCap } from "./microLiveFeeCap";
import {
  frozenUnusedRunBlockReason, PREPARED_BOUNDED_RUN_CAP_MICROS,
} from "./microLiveBoundedRunTransition";
import {
  entryCashDebitMicrosForContracts, feeBoundForContracts,
  readCurrentEntryFeeTerms, feeEvidenceMatchesApproval, type EntryFeeTerms,
  feeEvidenceMatchesMarketIdentity,
  standingFeePolicyApprovalIsValid, MICRO_LIVE_STANDING_FEE_POLICY_VERSION,
  type StandingFeePolicyApproval,
} from "./microLiveEntryFees";
import {
  lockFeeVerificationForPost,
  type FeeVerificationTransaction,
} from "./microLiveFeeVerification";
import { approvedFeeSession } from "./microLiveFeeApproval";
import {
  CANONICAL_FEE_SCHEDULE_URL, STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
} from "./microLiveFeeArtifact";
import {
  compatibleOptionalDirection, compatibleOptionalPrice,
  mergeDirectionAndPrices, microLiveOrderLegFillPrice,
} from "./microLiveFillNormalization";
import {
  evaluateV13Strategy,
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import { planV13IocEntry } from "./v13ExecutionPlanner";

const FRESHNESS_MS = 15_000;

function isChampionV13Evaluation(evaluation: {
  strategyVersion: string;
  strategyParameterSetId: string | null;
  strategyParameterHash: string | null;
} | null | undefined): boolean {
  return Boolean(
    evaluation &&
    evaluation.strategyVersion === "V1.3" &&
    evaluation.strategyParameterSetId === V13_CHAMPION_PARAMETER_SET.id &&
    evaluation.strategyParameterHash === V13_CHAMPION_PARAMETER_HASH
  );
}
const RECONCILIATION_MS = 30_000;
const BOUNDED_RUN_PHASES = ["UNARMED", "PREPARING", "ENTRY_OPEN", "EXIT_ONLY", "FROZEN"] as const;
type BoundedRunPhase = typeof BOUNDED_RUN_PHASES[number];
type BoundedRunResult = { status: "armed" | "resumed" | "blocked"; reason: string };
let startupReadiness: { ready: boolean; checkedAt: number; reason: string | null } = {
  ready: false, checkedAt: 0, reason: "startup_reconciliation_not_run",
};
type PrimaryCashPreflightProof = {
  orderId: string;
  runId: string;
  marketTicker: string;
  baselineDigest: string;
  baselineMicros: string;
  baselineAt: number;
  checkedAt: number;
};
let primaryCashPreflightProof: PrimaryCashPreflightProof | null = null;
let boundedWorkerLeaseEvidence: { owner: string; expiresAt: number; observedAt: number } | null = null;
let localWorkerLeaseOwner: string | null = null;
/** Called only by the server worker after acquiring or releasing its lease. */
export function registerMicroLiveWorkerLeaseOwner(owner: string | null): void {
  localWorkerLeaseOwner = owner;
  if (owner === null) boundedWorkerLeaseEvidence = null;
}
let boundedRunOperationId: string | null = null;
/** Isolated database tests simulate a new process without rewriting the durable run identity. */
export function simulateMicroLiveRestartForIsolatedTest(): void {
  if (process.env.NODE_ENV !== "development" ||
      !/^micro_live_test_[a-f0-9]{24}$/.test(
        process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "",
      )) throw new Error("isolated_micro_live_test_only");
  clearPrimaryCashPreflightProof();
  localWorkerLeaseOwner = null;
  boundedWorkerLeaseEvidence = null;
  boundedRunOperationId = null;
  boundedRunRestartRecoveryId = null;
  startupReadiness = { ready: false, checkedAt: 0, reason: "startup_reconciliation_not_run" };
}
let boundedRunRestartRecoveryId: string | null = null;
type ReadOnlyAuditEvidence = {
  boundaryAt: string | null;
  knownBotFills: number | null;
  historicalUnattributedFills: number | null;
  unexplainedFills: number | null;
  positionDiscrepancies: number | null;
};
const emptyReadOnlyAuditEvidence = (): ReadOnlyAuditEvidence => ({
  boundaryAt: null, knownBotFills: null, historicalUnattributedFills: null,
  unexplainedFills: null, positionDiscrepancies: null,
});
let readOnlyAudit: ReadOnlyAuditEvidence & {
  status: "not_run" | "observed" | "blocked"; checkedAt: number; reason: string | null;
} = {
  status: "not_run", checkedAt: 0, reason: null, ...emptyReadOnlyAuditEvidence(),
};
let readOnlyAuditRun = 0;

export type MicroLiveDecision = {
  evaluationId: string | null;
  status: "blocked" | "submitted" | "unknown" | "rejected" | "partial" | "filled";
  reason: string;
  decidedAt: string;
  orderId?: string;
};

export type MicroLiveState = {
  enabled: boolean;
  configurationExists: boolean;
  accountingUnresolved: boolean;
  accountingUnresolvedReason: string | null;
  databaseFlags: { microLiveProductionEnabled: boolean; liveExecutionEnabled: boolean } | null;
  environmentFlags: { microLiveProductionEnabled: boolean; liveExecutionEnabled: boolean };
  killSwitch: "ON" | "OFF";
  lease: { held: boolean; owner: string | null; expiresAt: string | null };
  reconciliation: { status: "not_run" | "required" | "current"; checkedAt: string | null };
  readOnlyAudit: ReadOnlyAuditEvidence & {
    status: "not_run" | "observed" | "blocked"; checkedAt: string | null; reason: string | null;
  };
  availableBankrollCents: number | null;
  maxLiveBankrollCents: number | null;
  availableKalshiBalance: { cents: number; dollars: string; observedAt: string } | null;
  pendingOrders: { count: number; list: Array<Record<string, unknown>> };
  fills: { count: number; list: Array<Record<string, unknown>> };
  openExposureCents: number;
  reservedRiskCents: number;
  realizedPnlCents: number | null;
  realizedPnlMicros: number | null;
  unrealizedPnlCents: number | null;
  wins: number | null;
  losses: number | null;
  currentPosition: Record<string, unknown> | null;
  lastAttempted: MicroLiveDecision | null;
  lastAccepted: MicroLiveDecision | null;
  lastRejection: MicroLiveDecision | null;
  latestBlockedReason: string | null;
  currentV13Signal: { signal: string; direction: string; ticker: string | null; evaluatedAt: string | null } | null;
  openPositionCount: number;
  recentDecision: MicroLiveDecision | null;
  boundedRun: {
    phase: BoundedRunPhase | null;
    entryDeadlineAt: string | null;
    armedAt: string | null;
    runId: string | null;
    entryAttempted: boolean;
    exitAttempted: boolean;
    freezeReason: string | null;
  };
};

type MicroLiveOrderbook = Awaited<ReturnType<typeof readKalshiOrderbook>>;
type MicroLiveTradingClient = ReturnType<typeof createKalshiTradingClient>;

const DEDICATED_EXCHANGE_INDEX = 2 as const;

function restrictedKeyFingerprint(): { apiKeyId: string; fingerprint: string } | null {
  const apiKeyId = process.env.KALSHI_API_KEY_ID?.trim();
  const privateKey = process.env.KALSHI_API_PRIVATE_KEY?.trim();
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

function dedicatedShardTwoIdentityMatchesConfig(
  config: typeof microLiveConfigTable.$inferSelect,
  binding = configuredMicroLiveAccountBinding(),
): boolean {
  const key = restrictedKeyFingerprint();
  return Boolean(binding && key &&
    config.microLiveAccountMode === "exclusive" &&
    config.microLiveSelectedSubaccount === binding.subaccount &&
    binding.mode === "exclusive" && binding.subaccount > 0 &&
    config.microLiveSelectedExchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    config.microLiveRestrictedApiKeyId === key.apiKeyId &&
    config.microLiveRestrictedKeyFingerprint === key.fingerprint);
}

function dedicatedShardTwoCashAnchorMatchesConfig(
  config: typeof microLiveConfigTable.$inferSelect,
): boolean {
  return Boolean(dedicatedShardTwoIdentityMatchesConfig(config) &&
    config.microLiveRunId &&
    config.microLiveFundingAnchorSubaccount === config.microLiveSelectedSubaccount &&
    config.microLiveFundingAnchorExchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    config.microLiveFundingAnchorTransferId &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(config.microLiveFundingAnchorTransferId) &&
    config.microLiveFundingAnchorTransferAt &&
    config.microLiveFundingAnchorTransferAt.getTime() > 0 &&
    config.microLiveFundingAnchorAmountCents === 2500 &&
    config.microLivePairCashBaselineMicros === "25000000" &&
    config.microLivePairCashBaselineRunId === config.microLiveRunId &&
    config.microLivePairCashBaselineAt &&
    /^[0-9a-f]{64}$/.test(config.microLivePairCashBaselineEvidenceDigest ?? ""));
}

type DedicatedPairPostProof = {
  proof: MicroLivePairCollateralProof;
  config: typeof microLiveConfigTable.$inferSelect;
  localLedgerFingerprint: string;
  configIdentityFingerprint: string;
  reservationId: string;
  ticker: string;
  action: "entry" | "exit";
  phase: "ENTRY_OPEN" | "EXIT_ONLY";
};

type DedicatedPairCancellationProof = {
  proof: MicroLivePairCollateralProof;
  config: typeof microLiveConfigTable.$inferSelect;
  localLedgerFingerprint: string;
  configIdentityFingerprint: string;
  configStateDigest: string;
  boundaryStateDigest: string;
  ledgerStateDigest: string;
  ticker: string;
};

function dedicatedPairCollateralDependencies(
  dependencies: MicroLiveDependencies,
): PairBoundaryDependencies {
  const isolatedSchema = process.env.NODE_ENV === "development" &&
    /^micro_live_test_[a-f0-9]{24}$/.test(
      process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "",
    );
  return {
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(isolatedSchema && dependencies.readDedicatedPairEvidenceForTest
      ? { readEvidence: dependencies.readDedicatedPairEvidenceForTest }
      : {}),
  };
}

function dedicatedPairConfigIdentityFingerprint(
  config: typeof microLiveConfigTable.$inferSelect,
): string {
  return createHash("sha256").update(JSON.stringify({
    runId: config.microLiveRunId,
    phase: config.microLiveRunPhase,
    mode: config.microLiveAccountMode,
    subaccount: config.microLiveSelectedSubaccount,
    exchangeIndex: config.microLiveSelectedExchangeIndex,
    restrictedApiKeyId: config.microLiveRestrictedApiKeyId,
    restrictedKeyFingerprint: config.microLiveRestrictedKeyFingerprint,
    fundingAnchorSubaccount: config.microLiveFundingAnchorSubaccount,
    fundingAnchorExchangeIndex: config.microLiveFundingAnchorExchangeIndex,
    fundingAnchorTransferId: config.microLiveFundingAnchorTransferId,
    fundingAnchorTransferAt: config.microLiveFundingAnchorTransferAt?.getTime() ?? null,
    pairCashBaselineMicros: config.microLivePairCashBaselineMicros,
    pairCashBaselineRunId: config.microLivePairCashBaselineRunId,
    pairCashBaselineAt: config.microLivePairCashBaselineAt?.getTime() ?? null,
    pairCashBaselineEvidenceDigest: config.microLivePairCashBaselineEvidenceDigest,
    checkpointRunId: config.microLiveAccountActivityCheckpointRunId,
    checkpointCursor: config.microLiveAccountActivityCheckpointCursor,
    checkpointAt: config.microLiveAccountActivityCheckpointAt?.getTime() ?? null,
    checkpointEvidenceDigest: config.microLiveAccountActivityCheckpointEvidenceDigest,
    checkpointSubaccount: config.microLiveAccountActivityCheckpointSubaccount,
    checkpointExchangeIndex: config.microLiveAccountActivityCheckpointExchangeIndex,
    manualKillSwitch: config.manualKillSwitch,
    microLiveProductionEnabled: config.microLiveProductionEnabled,
    liveExecutionEnabled: config.liveExecutionEnabled,
    accountingUnresolved: config.microLiveAccountingUnresolved,
    runApprovalId: config.microLiveRunApprovalId,
    runApprovalDigest: config.microLiveRunApprovalDigest,
    runCapMicros: config.microLiveRunCapMicros,
  })).digest("hex");
}

function dedicatedPairBoundaryIdentityFingerprint(
  config: typeof microLiveConfigTable.$inferSelect,
): string {
  return createHash("sha256").update(JSON.stringify({
    runId: config.microLiveRunId,
    mode: config.microLiveAccountMode,
    subaccount: config.microLiveSelectedSubaccount,
    exchangeIndex: config.microLiveSelectedExchangeIndex,
    restrictedApiKeyId: config.microLiveRestrictedApiKeyId,
    restrictedKeyFingerprint: config.microLiveRestrictedKeyFingerprint,
    fundingAnchorSubaccount: config.microLiveFundingAnchorSubaccount,
    fundingAnchorExchangeIndex: config.microLiveFundingAnchorExchangeIndex,
    fundingAnchorTransferId: config.microLiveFundingAnchorTransferId,
    fundingAnchorTransferAt: config.microLiveFundingAnchorTransferAt?.getTime() ?? null,
    pairCashBaselineMicros: config.microLivePairCashBaselineMicros,
    pairCashBaselineRunId: config.microLivePairCashBaselineRunId,
    pairCashBaselineAt: config.microLivePairCashBaselineAt?.getTime() ?? null,
    pairCashBaselineEvidenceDigest: config.microLivePairCashBaselineEvidenceDigest,
    checkpointRunId: config.microLiveAccountActivityCheckpointRunId,
    checkpointCursor: config.microLiveAccountActivityCheckpointCursor,
    checkpointAt: config.microLiveAccountActivityCheckpointAt?.getTime() ?? null,
    checkpointEvidenceDigest: config.microLiveAccountActivityCheckpointEvidenceDigest,
    checkpointSubaccount: config.microLiveAccountActivityCheckpointSubaccount,
    checkpointExchangeIndex: config.microLiveAccountActivityCheckpointExchangeIndex,
  })).digest("hex");
}

async function dedicatedPairLocalLedgerFingerprint(): Promise<string> {
  const [orders, fills, settlements] = await Promise.all([
    db.select().from(microLiveOrderTable),
    db.select().from(microLiveFillTable),
    db.select().from(microLiveSettlementTable),
  ]);
  return ledgerFingerprint(orders, fills) + JSON.stringify(settlements);
}

function dedicatedPairLedgerFingerprintFrom(
  orders: typeof microLiveOrderTable.$inferSelect[],
  fills: typeof microLiveFillTable.$inferSelect[],
  settlements: typeof microLiveSettlementTable.$inferSelect[],
): string {
  return ledgerFingerprint(orders, fills) + JSON.stringify(settlements);
}

function digestMicroLiveState(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dedicatedPairCancellationLedgerStateDigest(
  orders: typeof microLiveOrderTable.$inferSelect[],
  fills: typeof microLiveFillTable.$inferSelect[],
  settlements: typeof microLiveSettlementTable.$inferSelect[],
  localOrderId: string,
): string {
  return digestMicroLiveState({
    orders: orders.map((order) => order.id === localOrderId
      ? { ...order, cancellationAuthorizedAt: null } : order)
      .sort((a, b) => a.id.localeCompare(b.id)),
    fills: [...fills].sort((a, b) => a.exchangeFillId.localeCompare(b.exchangeFillId)),
    settlements: [...settlements].sort((a, b) =>
      a.positionId.localeCompare(b.positionId)),
  });
}

async function dedicatedPairCancellationStateSnapshot(localOrderId: string) {
  return db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config?.microLiveSelectedSubaccount) return null;
    const [boundary] = await tx.select().from(microLivePairBoundaryTable)
      .where(eq(
        microLivePairBoundaryTable.subaccountNumber,
        config.microLiveSelectedSubaccount,
      )).for("update").limit(1);
    await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
      ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
    const [orders, fills, settlements] = await Promise.all([
      tx.select().from(microLiveOrderTable),
      tx.select().from(microLiveFillTable),
      tx.select().from(microLiveSettlementTable),
    ]);
    return {
      config, boundary, orders, fills, settlements,
      configStateDigest: digestMicroLiveState(config),
      boundaryStateDigest: boundary ? digestMicroLiveState(boundary) : "",
      ledgerStateDigest: dedicatedPairCancellationLedgerStateDigest(
        orders, fills, settlements, localOrderId,
      ),
      localLedgerFingerprint: dedicatedPairLedgerFingerprintFrom(
        orders, fills, settlements,
      ),
    };
  });
}

async function captureDedicatedPairCancellationProof(
  localOrderId: string,
  ticker: string,
  dependencies: MicroLiveDependencies,
): Promise<DedicatedPairCancellationProof | null> {
  const before = await dedicatedPairCancellationStateSnapshot(localOrderId).catch(() => null);
  if (!before?.config || !before.boundary ||
      !isDedicatedShardTwoRun(before.config) ||
      before.config.microLiveRunPhase !== "FROZEN" ||
      !before.config.manualKillSwitch || before.config.microLiveProductionEnabled ||
      before.config.liveExecutionEnabled ||
      before.boundary.state !== "initialized" || before.boundary.ambiguityFrozenAt) return null;
  const proof = await readDedicatedPairCollateralProof(
    before.config, ticker, { kind: "recovery_get" }, dependencies,
  );
  const after = await dedicatedPairCancellationStateSnapshot(localOrderId).catch(() => null);
  const now = (dependencies.now?.() ?? new Date()).getTime();
  if (!after?.config || !after.boundary ||
      proof.status !== "verified" || proof.mode?.kind !== "recovery_get" ||
      proof.runId !== before.config.microLiveRunId ||
      !/^[0-9a-f]{64}$/.test(proof.evidenceDigest ?? "") ||
      now - proof.checkedAt < 0 || now - proof.checkedAt > 5_000 ||
      before.configStateDigest !== after.configStateDigest ||
      before.boundaryStateDigest !== after.boundaryStateDigest ||
      before.ledgerStateDigest !== after.ledgerStateDigest ||
      proof.configStateDigest !== before.configStateDigest ||
      before.config.microLiveRunId !== after.config.microLiveRunId) return null;
  return {
    proof, config: after.config,
    localLedgerFingerprint: after.localLedgerFingerprint,
    configIdentityFingerprint: dedicatedPairConfigIdentityFingerprint(after.config),
    configStateDigest: after.configStateDigest,
    boundaryStateDigest: after.boundaryStateDigest,
    ledgerStateDigest: after.ledgerStateDigest,
    ticker,
  };
}

async function dedicatedPairProofStillMatches(
  handoff: DedicatedPairPostProof | undefined,
  reservationId: string,
  config: typeof microLiveConfigTable.$inferSelect,
  now: number,
): Promise<boolean> {
  if (!handoff || handoff.reservationId !== reservationId ||
      handoff.proof.status !== "verified" ||
      handoff.proof.proofKind !== "collateral_reconciliation_only" ||
      handoff.proof.authorization !== "none" ||
      handoff.proof.mode?.kind !== "final_post" ||
      handoff.proof.mode.action !== handoff.action ||
      handoff.proof.mode.phase !== handoff.phase ||
      handoff.proof.runId !== config.microLiveRunId ||
      handoff.ticker.length === 0 ||
      !/^[0-9a-f]{64}$/.test(handoff.proof.evidenceDigest ?? "") ||
      !/^[0-9a-f]{64}$/.test(handoff.proof.configStateDigest ?? "") ||
      now - handoff.proof.checkedAt < 0 || now - handoff.proof.checkedAt > 5_000 ||
      dedicatedPairConfigIdentityFingerprint(config) !== handoff.configIdentityFingerprint) {
    return false;
  }
  try {
    const [orders, fills, settlements] = await Promise.all([
      db.select().from(microLiveOrderTable),
      db.select().from(microLiveFillTable),
      db.select().from(microLiveSettlementTable),
    ]);
    const originalOrders = orders.filter((row) => row.id !== reservationId);
    return dedicatedPairLedgerFingerprintFrom(
      originalOrders, fills, settlements,
    ) === handoff.localLedgerFingerprint;
  } catch {
    return false;
  }
}

async function readDedicatedPairCollateralProof(
  config: typeof microLiveConfigTable.$inferSelect,
  ticker: string,
  mode: MicroLivePairCollateralMode,
  dependencies: MicroLiveDependencies,
): Promise<MicroLivePairCollateralProof> {
  const subaccountNumber = config.microLiveSelectedSubaccount;
  const runId = config.microLiveRunId;
  if (!subaccountNumber || !runId ||
      !dedicatedShardTwoCashAnchorMatchesConfig(config) ||
      config.microLiveAccountActivityCheckpointRunId !== runId ||
      config.microLiveAccountActivityCheckpointSubaccount !== subaccountNumber ||
      config.microLiveAccountActivityCheckpointExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      !config.microLiveAccountActivityCheckpointCursor?.trim() ||
      !config.microLiveAccountActivityCheckpointAt ||
      !/^[0-9a-f]{64}$/.test(
        config.microLiveAccountActivityCheckpointEvidenceDigest ?? "",
      )) {
    return {
      status: "blocked",
      reason: "dedicated_pair_collateral_persisted_identity_incomplete",
      checkedAt: (dependencies.now?.() ?? new Date()).getTime(),
      mode,
      proofKind: "collateral_reconciliation_only",
      authorization: "none",
    };
  }
  try {
    return await reconcileMicroLivePairCollateral({
      subaccountNumber,
      ticker,
      runId,
      mode,
    }, dedicatedPairCollateralDependencies(dependencies));
  } catch {
    return {
      status: "blocked",
      reason: "dedicated_pair_collateral_reconciliation_failed",
      checkedAt: (dependencies.now?.() ?? new Date()).getTime(),
      mode,
      proofKind: "collateral_reconciliation_only",
      authorization: "none",
    };
  }
}

async function captureDedicatedPairPostProof(
  config: typeof microLiveConfigTable.$inferSelect,
  reservationId: string,
  ticker: string,
  action: "entry" | "exit",
  phase: "ENTRY_OPEN" | "EXIT_ONLY",
  dependencies: MicroLiveDependencies,
): Promise<{ proof: DedicatedPairPostProof | null; reason: string | null }> {
  const configIdentityFingerprint = dedicatedPairConfigIdentityFingerprint(config);
  let localLedgerFingerprint: string;
  try {
    localLedgerFingerprint = await dedicatedPairLocalLedgerFingerprint();
  } catch {
    return { proof: null, reason: "dedicated_pair_local_ledger_read_failed" };
  }
  const collateral = await readDedicatedPairCollateralProof(config, ticker, {
    kind: "final_post", action, phase,
  }, dependencies);
  const checkedAt = (dependencies.now?.() ?? new Date()).getTime();
  if (collateral.status === "blocked") {
    return {
      proof: null,
      reason: collateral.reason ?? "dedicated_pair_collateral_proof_unavailable",
    };
  }
  if (collateral.mode?.kind !== "final_post" ||
      collateral.mode.action !== action || collateral.mode.phase !== phase ||
      collateral.runId !== config.microLiveRunId ||
      !/^[0-9a-f]{64}$/.test(collateral.evidenceDigest ?? "") ||
      !/^[0-9a-f]{64}$/.test(collateral.configStateDigest ?? "") ||
      checkedAt - collateral.checkedAt < 0 || checkedAt - collateral.checkedAt > 5_000) {
    return { proof: null, reason: "dedicated_pair_post_proof_stale_or_invalid" };
  }
  let latestConfig: typeof config | undefined;
  let latestLedgerFingerprint: string;
  try {
    [latestConfig] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    latestLedgerFingerprint = await dedicatedPairLocalLedgerFingerprint();
  } catch {
    return { proof: null, reason: "dedicated_pair_post_proof_revalidation_failed" };
  }
  if (!latestConfig ||
      dedicatedPairConfigIdentityFingerprint(latestConfig) !== configIdentityFingerprint ||
      latestLedgerFingerprint !== localLedgerFingerprint) {
    return { proof: null, reason: "dedicated_pair_post_proof_state_changed" };
  }
  return {
    proof: {
      proof: collateral,
      config,
      localLedgerFingerprint,
      configIdentityFingerprint,
      reservationId,
      ticker,
      action,
      phase,
    },
    reason: null,
  };
}

async function verifyDedicatedShardTwoPair(
  request: Parameters<NonNullable<
    Parameters<typeof createKalshiTradingClient>[0]["verifyDedicatedShardTwoPair"]
  >>[0],
  postHandoff?: DedicatedPairPostProof,
  cancellationHandoff?: DedicatedPairCancellationProof,
): Promise<KalshiShardTwoPairEvidence | null> {
  const key = restrictedKeyFingerprint();
  const recovering = request.authorizationMode === "recovery_get";
  const handoff = recovering ? cancellationHandoff : postHandoff;
  const config = handoff?.config;
  const proof = handoff?.proof;
  const modeMatches = recovering
    ? proof?.mode?.kind === "recovery_get" &&
      request.action === "sell" &&
      request.requiredEvidenceDigest === proof.evidenceDigest &&
      config?.microLiveRunPhase === "FROZEN" &&
      config.manualKillSwitch && !config.microLiveProductionEnabled &&
      !config.liveExecutionEnabled
    : proof?.mode?.kind === "final_post" &&
      proof.mode.action === (request.action === "buy" ? "entry" : "exit");
  const collateralMode = proof?.mode?.kind === "recovery_get"
    ? { kind: "recovery_get" as const }
    : proof?.mode?.kind === "final_post" ? proof.mode : null;
  if (!config || !proof || proof.status !== "verified" ||
      proof.proofKind !== "collateral_reconciliation_only" ||
      proof.authorization !== "none" || !modeMatches || !collateralMode ||
      !key || request.exchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      request.apiKeyId !== key.apiKeyId ||
      request.subaccountNumber !== config.microLiveSelectedSubaccount ||
      request.runId !== config.microLiveRunId ||
      proof.runId !== request.runId ||
      handoff.ticker !== request.marketTicker ||
      request.now - proof.checkedAt < 0 || request.now - proof.checkedAt > 5_000 ||
      !proof.evidenceDigest || !proof.boundaryEvidenceDigest ||
      !proof.configStateDigest ||
      recovering && (
        !(handoff as DedicatedPairCancellationProof).configStateDigest ||
        proof.configStateDigest !==
          (handoff as DedicatedPairCancellationProof).configStateDigest ||
        request.requiredEvidenceDigest !== proof.evidenceDigest
      ) ||
      !recovering && (
        proof.mode?.kind !== "final_post" ||
        proof.mode.action !== (request.action === "buy" ? "entry" : "exit") ||
        proof.mode.action !== (postHandoff?.action ?? "") ||
        proof.mode.phase !== (postHandoff?.phase ?? "")
      ) ||
      !dedicatedShardTwoCashAnchorMatchesConfig(config) ||
      config.microLiveAccountActivityCheckpointRunId !== config.microLiveRunId ||
      config.microLiveAccountActivityCheckpointSubaccount !== request.subaccountNumber ||
      config.microLiveAccountActivityCheckpointExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
      !config.microLiveAccountActivityCheckpointCursor ||
      !config.microLiveAccountActivityCheckpointAt ||
      !/^[0-9a-f]{64}$/.test(
        config.microLiveAccountActivityCheckpointEvidenceDigest ?? "",
      )) return null;
  const collateralAmounts = [
    proof.availableCashMicros,
    proof.inventoryBalanceMicros,
    proof.activityCashDeltaMicros,
    proof.expectedAvailableCashMicros,
    proof.restingEntryReserveMicros,
    proof.filledBuyExposureMicros,
    proof.reconciledFeeMicros,
  ];
  if (collateralAmounts.some((value) =>
    typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value))) return null;
  return {
    checkedAt: proof.checkedAt,
    apiKeyId: key.apiKeyId,
    restrictedKeySubaccount: request.subaccountNumber,
    persistedIdentity: {
      runId: request.runId,
      subaccountNumber: request.subaccountNumber,
      exchangeIndex: DEDICATED_EXCHANGE_INDEX,
      apiKeyId: key.apiKeyId,
    },
    fundingAnchor: {
      runId: request.runId,
      subaccountNumber: request.subaccountNumber,
      exchangeIndex: DEDICATED_EXCHANGE_INDEX,
      transferId: config.microLiveFundingAnchorTransferId!,
      transferredAt: config.microLiveFundingAnchorTransferAt!.getTime(),
      amountMicros: "25000000",
      initialBalanceMicros: "25000000",
      evidenceDigest: config.microLivePairCashBaselineEvidenceDigest!,
    },
    accountEvidence: {
      runId: request.runId,
      subaccountNumber: request.subaccountNumber,
      exchangeIndex: DEDICATED_EXCHANGE_INDEX,
      capturedAt: proof.checkedAt,
      complete: true,
      evidenceDigest: proof.evidenceDigest!,
    },
    marketEvidence: {
      ticker: request.marketTicker,
      exchangeIndex: DEDICATED_EXCHANGE_INDEX,
      capturedAt: proof.checkedAt,
    },
    collateralProof: {
      status: "verified",
      proofKind: "collateral_reconciliation_only",
      authorization: "none",
      mode: collateralMode,
      runId: request.runId,
      checkedAt: proof.checkedAt,
      evidenceDigest: proof.evidenceDigest!,
      boundaryEvidenceDigest: proof.boundaryEvidenceDigest!,
      configStateDigest: proof.configStateDigest!,
      availableCashMicros: proof.availableCashMicros!,
      inventoryBalanceMicros: proof.inventoryBalanceMicros!,
      activityCashDeltaMicros: proof.activityCashDeltaMicros!,
      expectedAvailableCashMicros: proof.expectedAvailableCashMicros!,
      restingEntryReserveMicros: proof.restingEntryReserveMicros!,
      filledBuyExposureMicros: proof.filledBuyExposureMicros!,
      reconciledFeeMicros: proof.reconciledFeeMicros!,
    },
  };
}

function createMicroLiveTradingClient(
  dedicatedPairProof?: DedicatedPairPostProof,
  dedicatedPairCancellationProof?: DedicatedPairCancellationProof,
): MicroLiveTradingClient {
  return createKalshiTradingClient({
    fetchImpl: globalThis.fetch,
    verifyDedicatedShardTwoPair: (request) =>
      verifyDedicatedShardTwoPair(
        request, dedicatedPairProof, dedicatedPairCancellationProof,
      ),
  });
}

export type MicroLiveDependencies = {
  now?: () => Date;
  readBtc?: () => Promise<{ price: number; receivedAt: Date; providerAt: Date }>;
  readOrderbook?: (ticker: string) => Promise<MicroLiveOrderbook>;
  readAccount?: () => Promise<KalshiAccountSnapshot>;
  readAccountActivity?: () => Promise<KalshiAccountActivity>;
  /** Only isolated fixtures can provide complete authenticated transfer coverage. */
  readPrimaryCashActivityScanForTest?: (
    checkpoint: PrimaryCashActivityCheckpoint | null,
    baseline: PrimaryCashBaseline,
  ) => Promise<PrimaryCashActivityScan>;
  readHistoricalFills?: (tickers: string[]) => Promise<KalshiHistoricalFillsSnapshot>;
  readSettlements?: () => Promise<KalshiSettlementsSnapshot>;
  readOrderStatus?: (orderId: string) => Promise<KalshiOrder>;
  readEntryFeeTerms?: (ticker: string) => Promise<EntryFeeTerms | null>;
  /** Test-only approval injection is honored only in the guarded disposable schema. */
  approvedFeeSessionForTest?: () => (Partial<StandingFeePolicyApproval> & {
    id: string; digest: string; approvedAt: number; expiresAt?: number;
  }) | null;
  cancelOrder?: MicroLiveTradingClient["cancelOrder"];
  /** Internal recovery mode: reconcile evidence without ever reopening execution. */
  frozenExitReconciliation?: boolean;
  /** Internal recursion marker for dedicated (N,2) GET-only startup recovery. */
  dedicatedPairRecovery?: boolean;
  /**
   * Raw authenticated evidence reader injection for isolated integration
   * fixtures. The production collateral reconciler still validates the full
   * proof; callers cannot inject a proof/authorization result.
   */
  readDedicatedPairEvidenceForTest?: PairBoundaryDependencies["readEvidence"];
  /** Isolated integration-fixture simulation only; never set by application callers. */
  isolatedTestFeeCapFixture?: boolean;
  readOnlyAudit?: boolean;
  beforeSubmissionInterlock?: () => Promise<void>;
  afterRecoveryWrites?: () => Promise<void>;
  afterExitPost?: () => Promise<void>;
  submitOrder?: (
    input: KalshiLimitOrderRequest,
    context: Parameters<MicroLiveTradingClient["createLimitOrder"]>[1],
  ) => Promise<KalshiOrder>;
};

function primaryActivityCheckpoint(
  config: typeof microLiveConfigTable.$inferSelect,
): PrimaryCashActivityCheckpoint | null {
  if (config.microLivePrimaryActivityCheckpointRunId === null &&
      config.microLivePrimaryActivityCheckpointCursor === null &&
      config.microLivePrimaryActivityCheckpointAt === null &&
      config.microLivePrimaryActivityCheckpointEvidenceDigest === null) return null;
  if (!config.microLivePrimaryActivityCheckpointRunId ||
      !config.microLivePrimaryActivityCheckpointCursor ||
      !config.microLivePrimaryActivityCheckpointAt ||
      !config.microLivePrimaryActivityCheckpointEvidenceDigest) {
    throw new Error("primary_activity_checkpoint_incomplete");
  }
  return {
    runId: config.microLivePrimaryActivityCheckpointRunId,
    cursor: config.microLivePrimaryActivityCheckpointCursor,
    capturedAt: config.microLivePrimaryActivityCheckpointAt.toISOString(),
    evidenceDigest: config.microLivePrimaryActivityCheckpointEvidenceDigest,
  };
}

async function verifyPrimaryActivityCheckpoint(
  config: typeof microLiveConfigTable.$inferSelect,
  baseline: PrimaryCashBaseline,
  dependencies: MicroLiveDependencies,
  now: number,
): Promise<{ reason: string } | { checkpoint: PrimaryCashActivityCheckpoint }> {
  let previous: PrimaryCashActivityCheckpoint | null;
  try {
    previous = primaryActivityCheckpoint(config);
  } catch {
    return { reason: "primary_activity_checkpoint_incomplete" };
  }
  // The live reader has no authenticated transfer ledger. An isolated fixture
  // may supply complete mocked evidence; never mistake absence for no activity.
  const isolated = process.env.NODE_ENV === "development" &&
    /^micro_live_test_[a-f0-9]{24}$/.test(process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "");
  if (!isolated || !dependencies.readPrimaryCashActivityScanForTest) {
    return { reason: "primary_cash_transfer_history_unavailable_or_incomplete" };
  }
  let scan: PrimaryCashActivityScan;
  try {
    scan = await dependencies.readPrimaryCashActivityScanForTest(previous, baseline);
  } catch {
    return { reason: "primary_activity_history_read_failed" };
  }
  const result = reconcilePrimaryCashActivityCheckpoint({
    baseline, currentRunId: baseline.runId, previousCheckpoint: previous,
    activity: scan, nowMs: Math.max(now, (dependencies.now?.() ?? new Date()).getTime()),
  });
  if (!result.ok) return { reason: result.reason };
  // Even offsetting transfers cannot be treated as bot-attributable cash.
  if (result.unrelatedCashMovementIds.length) {
    return { reason: "primary_cash_external_transfer_requires_review" };
  }
  return { checkpoint: result.nextCheckpoint };
}

/** Bridge a completed paper feed cycle into independently evaluated live intent.
 * With either execution flag off this path makes no exchange calls or writes.
 */
export async function processMicroLiveForwardTestCycle(
  paperEvaluationId: string | null,
  dependencies: MicroLiveDependencies = {},
): Promise<MicroLiveDecision | null> {
  if (!paperEvaluationId) return null;
  const workerObservationTime = dependencies.now?.() ?? new Date();
  const workerLease = await currentLease(workerObservationTime);
  if (workerLease.held && workerLease.owner && workerLease.expiresAt) {
    boundedWorkerLeaseEvidence = {
      owner: workerLease.owner,
      expiresAt: Date.parse(workerLease.expiresAt),
      observedAt: workerObservationTime.getTime(),
    };
  }
  const flags = environmentFlags();
  let [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  let now = dependencies.now?.() ?? new Date();
  const [source] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, paperEvaluationId)).limit(1);
  let sourceIsCurrent = Boolean(source && isChampionV13Evaluation(source) &&
    source.evaluationSource === "paper" && source.feedFreshness === "current" &&
    now.getTime() - source.evaluatedAt.getTime() >= 0 &&
    now.getTime() - source.evaluatedAt.getTime() <= FRESHNESS_MS);
  if (isPrimaryRun(config) && knownBoundedRunPhase(config?.microLiveRunPhase) &&
      ["PREPARING", "ENTRY_OPEN", "EXIT_ONLY"].includes(config.microLiveRunPhase) &&
      config.microLiveRunId && boundedRunOperationId !== config.microLiveRunId) {
    if (boundedRunRestartRecoveryId === config.microLiveRunId) return null;
    if (config.microLiveRunPhase === "ENTRY_OPEN" && sourceIsCurrent) {
      if (!await recoverPristineBoundedRunAfterRestart(config.microLiveRunId, source!, dependencies)) {
        return null;
      }
      [config] = await db.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
      now = dependencies.now?.() ?? new Date();
      sourceIsCurrent = Boolean(source && isChampionV13Evaluation(source) &&
        source.evaluationSource === "paper" && source.feedFreshness === "current" &&
        now.getTime() - source.evaluatedAt.getTime() >= 0 &&
        now.getTime() - source.evaluatedAt.getTime() <= FRESHNESS_MS);
    } else {
      await freezeBoundedRun(config.microLiveRunId, "process_restart_requires_explicit_exit_resume");
      await reconcileMicroLiveAtStartup({
        ...dependencies, frozenExitReconciliation: true,
      });
      return null;
    }
  }
  if (!flags.microLiveProductionEnabled || !flags.liveExecutionEnabled) return null;
  if (!config || config.manualKillSwitch || !config.microLiveProductionEnabled ||
      !config.liveExecutionEnabled) return null;
  if (isPrimaryRun(config) &&
      (!knownBoundedRunPhase(config.microLiveRunPhase) ||
       !["ENTRY_OPEN", "EXIT_ONLY"].includes(config.microLiveRunPhase))) return null;
  if (!sourceIsCurrent || !source) return null;
  const orders = await db.select().from(microLiveOrderTable);
  const fills = await db.select().from(microLiveFillTable);
  if (!accountBindingMatchesConfig(config) || config.microLiveAccountingUnresolved) return null;
  const ledger = reconstructMicroLivePositions({ orders, fills });
  if (ledger.anomalies.length) {
    startupReadiness = { ready: false, checkedAt: 0,
      reason: `micro_live_ledger_anomaly_${ledger.anomalies[0]!.code}` };
    return null;
  }
  const open = ledger.positions.filter((position) => !position.closed &&
    (position.contractsBought > position.contractsSold ||
      position.reservedBuyRiskCents > 0 || position.outstandingSellContracts > 0));
  if (open.length > 1) return null;
  if (open.length === 1) {
    if (isPrimaryRun(config) && config.microLiveRunPhase !== "ENTRY_OPEN" &&
        config.microLiveRunPhase !== "EXIT_ONLY") return null;
    if (open[0]!.marketTicker !== source.marketTicker) return null;
    const intent = await qualifyMicroLivePositionEvaluation(open[0]!.positionId, dependencies);
    return intent.evaluationId
      ? executeQualifiedV13Trigger(intent.evaluationId, dependencies) : null;
  }
  if (isPrimaryRun(config) &&
      (config.microLiveRunPhase !== "ENTRY_OPEN" ||
       !config.microLiveRunArmedAt ||
       source.evaluatedAt.getTime() <= config.microLiveRunArmedAt.getTime())) return null;
  if ((source.signal !== "SCOUT" && source.signal !== "CONFIRM") ||
      !source.qualifyingTrigger) return null;
  if (!readinessIsCurrent(now.getTime())) {
    const recovery = await reconcileMicroLiveAtStartup(dependencies);
    if (!recovery.ready) return null;
  }
  return executeQualifiedV13Trigger(source.id, dependencies);
}

/** Re-run the unchanged V1.3 classifier with the actual reconciled live position.
 * A paper cycle supplies feed evidence, never the position or the action intent.
 */
export async function qualifyMicroLivePositionEvaluation(
  positionId: string,
  dependencies: Pick<MicroLiveDependencies, "readAccount" | "readOrderStatus" | "now"> = {},
): Promise<{ evaluationId: string | null; reason: string }> {
  const recovery = await reconcileMicroLiveAtStartup(dependencies);
  if (!recovery.ready) return { evaluationId: null, reason: recovery.reason };
  const now = dependencies.now?.() ?? new Date();
  const rows = await db.select().from(microLiveOrderTable);
  const fills = await db.select().from(microLiveFillTable);
  const ledger = reconstructMicroLivePositions({ orders: rows, fills });
  const position = ledger.positions.find((item) => item.positionId === positionId);
  if (ledger.anomalies.length || !position || position.closed ||
      position.contractsBought <= position.contractsSold ||
      position.outstandingSellContracts > 0) {
    return { evaluationId: null, reason: "live_position_not_proven_or_entry_still_open" };
  }
  const paper = await db.select().from(forwardTestEvaluationTable).where(and(
    eq(forwardTestEvaluationTable.marketTicker, position.marketTicker),
    eq(forwardTestEvaluationTable.evaluationSource, "paper"),
  )).orderBy(desc(forwardTestEvaluationTable.evaluatedAt),
    desc(forwardTestEvaluationTable.id)).limit(2);
  const source = paper[0];
  const previous = paper[1];
  if (!source || !isChampionV13Evaluation(source) || source.feedFreshness !== "current" ||
      !Number.isFinite(source.btcPrice) || !Number.isFinite(source.target) ||
      !Number.isFinite(source.signedBuffer) ||
      Math.abs(source.btcPrice - source.target - source.signedBuffer) > 1e-6 ||
      now.getTime() - source.evaluatedAt.getTime() < 0 ||
      now.getTime() - source.evaluatedAt.getTime() > FRESHNESS_MS ||
      (previous && previous.evaluatedAt > source.evaluatedAt)) {
    return { evaluationId: null, reason: "live_v13_feed_evidence_missing_or_stale" };
  }
  const strategy = evaluateV13Strategy({
    marketTicker: position.marketTicker, btcPrice: source.btcPrice, target: source.target,
    previousBuffer: previous?.signedBuffer ?? null,
    velocity: source.velocity, upOffer: source.upOffer, downOffer: source.downOffer,
    freshness: "current",
    position: { status: "open", direction: position.side === "UP" ? "up" : "down" },
  });
  if ((strategy.signal !== "CONFIRM" || !strategy.qualifyingTrigger) &&
      strategy.signal !== "EXIT") {
    return { evaluationId: null, reason: "live_v13_no_qualifying_action" };
  }
  if (strategy.signal === "EXIT" && rows.some((row) => row.action === "buy" &&
      (row.positionId ?? `position:${row.marketTicker}:${row.crossingKey}`) === positionId &&
      ["pending", "unknown", "partial"].includes(row.status) && row.remainingContracts > 0)) {
    return { evaluationId: null, reason: "live_exit_entry_still_open" };
  }
  if (strategy.direction !== position.side ||
      !rows.some((row) => row.action === "buy" &&
        (row.positionId ?? `position:${row.marketTicker}:${row.crossingKey}`) === positionId &&
        row.crossingKey === source.crossingKey)) {
    return { evaluationId: null, reason: "live_v13_position_identity_mismatch" };
  }
  const id = `live-${createHash("sha256").update(
    `${positionId}\u001f${source.id}\u001f${strategy.signal}`).digest("hex")}`;
  await db.insert(forwardTestEvaluationTable).values({
    ...source, id, evaluatedAt: now, strategyVersion: "V1.3",
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    signedBuffer: strategy.buffer!, absoluteBuffer: strategy.separation!,
    freshCross: strategy.freshCross, crossingConsumed: true,
    signal: strategy.signal, direction: strategy.direction,
    qualifyingTrigger: true, reason: strategy.reason,
    entryOffer: strategy.signal === "CONFIRM" ? strategy.candidateOffer : null,
    positionWasOpen: true, evaluationSource: "micro_live",
    livePositionId: positionId, sourcePaperEvaluationId: source.id,
    createdAt: now,
  }).onConflictDoNothing();
  return { evaluationId: id, reason: "qualified_live_v13_position_action" };
}

function clearPrimaryCashPreflightProof(): void {
  primaryCashPreflightProof = null;
}

function readinessIsCurrent(now = Date.now()) {
  if (boundedRunRestartRecoveryId) {
    clearPrimaryCashPreflightProof();
    return false;
  }
  if (startupReadiness.ready && now - startupReadiness.checkedAt > RECONCILIATION_MS) {
    startupReadiness = { ready: false, checkedAt: 0, reason: "startup_reconciliation_stale" };
    clearPrimaryCashPreflightProof();
  }
  if (!startupReadiness.ready) clearPrimaryCashPreflightProof();
  return startupReadiness.ready;
}

/** Read-only process-local readiness check for the last-mile order guard. */
export function isMicroLiveReadinessCurrent(now = Date.now()): boolean {
  return readinessIsCurrent(now);
}

export function isMicroLiveCashPreflightCurrent(
  identity: Pick<PrimaryCashPreflightProof, "orderId" | "runId" |
    "marketTicker" | "baselineDigest" | "baselineMicros" | "baselineAt">,
  now = Date.now(),
): boolean {
  const proof = primaryCashPreflightProof;
  if (!proof || !Number.isSafeInteger(now) || now < proof.checkedAt ||
      now - proof.checkedAt > FRESHNESS_MS) {
    clearPrimaryCashPreflightProof();
    return false;
  }
  return proof.orderId === identity.orderId &&
    proof.runId === identity.runId &&
    proof.marketTicker === identity.marketTicker &&
    proof.baselineDigest === identity.baselineDigest &&
    proof.baselineMicros === identity.baselineMicros &&
    proof.baselineAt === identity.baselineAt;
}

export function invalidateMicroLiveReadiness(reason: string): void {
  clearPrimaryCashPreflightProof();
  startupReadiness = { ready: false, checkedAt: 0, reason };
}

function ledgerFingerprint(
  orders: Array<typeof microLiveOrderTable.$inferSelect>,
  fills: Array<typeof microLiveFillTable.$inferSelect>,
) {
  return createHash("sha256").update(JSON.stringify({
    orders: [...orders].sort((left, right) => left.id.localeCompare(right.id)),
    fills: [...fills].sort((left, right) => left.id.localeCompare(right.id)),
  })).digest("hex");
}

function mergeStartupFills(
  current: KalshiAccountSnapshot["fills"],
  historical: KalshiAccountSnapshot["fills"],
): KalshiAccountSnapshot["fills"] | null {
  const byId = new Map<string, KalshiAccountSnapshot["fills"][number]>();
  for (const fill of [...current, ...historical]) {
    const previous = byId.get(fill.id);
    if (!previous) {
      byId.set(fill.id, fill);
      continue;
    }
    const immutableMatches = previous.orderId === fill.orderId &&
      previous.ticker === fill.ticker && previous.side === fill.side &&
      previous.action === fill.action && Number(previous.countFp) === Number(fill.countFp) &&
      (previous.priceDollars === null || fill.priceDollars === null
        ? previous.priceDollars === fill.priceDollars
        : Number(previous.priceDollars) === Number(fill.priceDollars)) &&
      compatibleOptionalDirection(previous, fill) &&
      compatibleOptionalPrice(previous.yesPriceDollars, fill.yesPriceDollars) &&
      compatibleOptionalPrice(previous.noPriceDollars, fill.noPriceDollars) &&
      previous.createdAt === fill.createdAt;
    if (!immutableMatches ||
        (previous.feeCostDollars != null && fill.feeCostDollars != null &&
          Number(previous.feeCostDollars) !== Number(fill.feeCostDollars))) return null;
    byId.set(fill.id, {
      ...mergeDirectionAndPrices(previous, fill),
      feeCostDollars: previous.feeCostDollars ?? fill.feeCostDollars ?? null,
    });
  }
  return [...byId.values()];
}

function dedicatedPairActivityIdentityProblem(
  activity: KalshiAccountActivity,
  subaccountNumber: number,
  nowMs: number,
): string | null {
  if (activity.selectedSubaccount !== subaccountNumber ||
      activity.keyRestrictionVerified !== true ||
      activity.tradePermissionVerified !== true) {
    return "dedicated_pair_activity_key_or_subaccount_unverified";
  }
  if (!activity.available || activity.truncated || activity.orderOverlapConflicts?.length) {
    return "dedicated_pair_activity_incomplete_or_conflicting";
  }
  const startedAt = Date.parse(activity.scanStartedAt ?? "");
  const finishedAt = Date.parse(activity.scanFinishedAt ?? "");
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) ||
      startedAt > finishedAt || finishedAt > nowMs ||
      nowMs - startedAt > 5_000 || finishedAt - startedAt > 15_000) {
    return "dedicated_pair_activity_stale";
  }
  if (activity.orders.some((order) => order.exchangeIndex !== DEDICATED_EXCHANGE_INDEX) ||
      activity.fills.some((fill) => fill.exchangeIndex !== DEDICATED_EXCHANGE_INDEX)) {
    return "dedicated_pair_activity_exchange_index_unproven";
  }
  return null;
}

function dedicatedPairSnapshotIdentityProblem(
  snapshot: KalshiAccountSnapshot,
): string | null {
  if (snapshot.openOrders.some((order) => order.exchangeIndex !== DEDICATED_EXCHANGE_INDEX) ||
      snapshot.positions.some((position) => position.exchangeIndex !== DEDICATED_EXCHANGE_INDEX) ||
      snapshot.fills.some((fill) => fill.exchangeIndex !== DEDICATED_EXCHANGE_INDEX)) {
    return "dedicated_pair_snapshot_exchange_index_unproven";
  }
  return null;
}

/**
 * Link an ID-less durable reservation only when a complete authenticated
 * account-history scan finds one exact shard-2 order by the persisted client
 * order ID. An empty result is deliberately not treated as proof that a POST
 * did not reach Kalshi; the one-entry claim remains consumed.
 */
async function linkDedicatedPairRestartReservations(
  config: typeof microLiveConfigTable.$inferSelect,
  rows: Array<typeof microLiveOrderTable.$inferSelect>,
  activity: KalshiAccountActivity,
): Promise<string | null> {
  const keyProblem = dedicatedPairActivityIdentityProblem(
    activity, config.microLiveSelectedSubaccount ?? -1, Date.now(),
  );
  if (keyProblem) return keyProblem;
  const exchangeIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const item of activity.orders) {
    if (!item.id || !item.clientOrderId || exchangeIds.has(item.id) ||
        clientIds.has(item.clientOrderId)) {
      return "dedicated_pair_activity_order_identity_conflict";
    }
    exchangeIds.add(item.id);
    clientIds.add(item.clientOrderId);
  }
  const pending = rows.filter((row) => !row.exchangeOrderId &&
    row.status !== "rejected" &&
    (["pending", "unknown", "partial", "filled", "canceled"].includes(row.status) ||
      row.filledContracts > 0 || row.reservedRiskCents > 0));
  if (!pending.length) return null;
  const links: Array<{ row: typeof microLiveOrderTable.$inferSelect; exchangeId: string }> = [];
  for (const row of pending) {
    if (row.microLiveRunId !== config.microLiveRunId) {
      return "dedicated_pair_restart_local_run_identity_mismatch";
    }
    const matches = activity.orders.filter((order) =>
      order.clientOrderId === row.clientOrderId);
    if (matches.length !== 1) {
      return matches.length
        ? "dedicated_pair_restart_client_order_id_conflict"
        : "dedicated_pair_restart_submission_identity_unresolved";
    }
    const order = matches[0]!;
    if (order.ticker !== row.marketTicker ||
        order.side !== (row.side === "UP" ? "yes" : "no") ||
        order.action !== row.action || order.type !== "limit" ||
        Number(order.initialCount) !== row.requestedContracts ||
        order.exchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
        rows.some((other) => other.id !== row.id &&
          other.exchangeOrderId === order.id) ||
        links.some((link) => link.exchangeId === order.id)) {
      return "dedicated_pair_restart_submission_identity_mismatch";
    }
    links.push({ row, exchangeId: order.id });
  }

  try {
    return await db.transaction(async (tx) => {
      const [lockedConfig] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      if (!lockedConfig || lockedConfig.microLiveRunId !== config.microLiveRunId ||
          lockedConfig.microLiveSelectedSubaccount !== config.microLiveSelectedSubaccount ||
          lockedConfig.microLiveSelectedExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
          !lockedConfig.manualKillSwitch || lockedConfig.microLiveProductionEnabled ||
          lockedConfig.liveExecutionEnabled ||
          !dedicatedShardTwoIdentityMatchesConfig(lockedConfig)) {
        return "dedicated_pair_restart_identity_changed";
      }
      for (const link of links) {
        const [current] = await tx.select().from(microLiveOrderTable)
          .where(eq(microLiveOrderTable.id, link.row.id)).for("update").limit(1);
        if (!current || current.exchangeOrderId ||
            JSON.stringify(current) !== JSON.stringify(link.row)) {
          return "dedicated_pair_restart_local_reservation_changed";
        }
        const [updated] = await tx.update(microLiveOrderTable).set({
          exchangeOrderId: link.exchangeId,
        }).where(and(
          eq(microLiveOrderTable.id, link.row.id),
          isNull(microLiveOrderTable.exchangeOrderId),
        )).returning({ id: microLiveOrderTable.id });
        if (!updated) return "dedicated_pair_restart_local_reservation_changed";
      }
      return null;
    });
  } catch {
    return "dedicated_pair_restart_identity_persistence_failed";
  }
}

class StartupRecoveryAbort extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Startup-only live-account recovery. It never submits/cancels orders. The
 * process-local barrier deliberately resets on every module/process start.
 */
export async function reconcileMicroLiveAtStartup(
  dependencies: Pick<MicroLiveDependencies,
    "readAccount" | "readAccountActivity" | "readHistoricalFills" | "readSettlements" | "readOrderStatus" |
    "now" | "afterRecoveryWrites" | "frozenExitReconciliation" |
    "dedicatedPairRecovery" | "readOnlyAudit" |
    "readDedicatedPairEvidenceForTest"> = {},
): Promise<{ ready: boolean; reason: string }> {
  const invocationNow = (dependencies.now?.() ?? new Date()).getTime();
  const readinessWasCurrentAtInvocation = startupReadiness.ready &&
    invocationNow - startupReadiness.checkedAt >= 0 &&
    invocationNow - startupReadiness.checkedAt <= RECONCILIATION_MS &&
    !boundedRunRestartRecoveryId;
  clearPrimaryCashPreflightProof();
  const auditOnly = dependencies.readOnlyAudit === true;
  const auditRun = auditOnly ? ++readOnlyAuditRun : 0;
  let auditEvidence = emptyReadOnlyAuditEvidence();
  if (!auditOnly) {
    startupReadiness = { ready: false, checkedAt: 0, reason: "startup_reconciliation_not_run" };
  } else {
    readOnlyAudit = { status: "not_run", checkedAt: 0, reason: null, ...auditEvidence };
  }
  let gatesEligible = false;
  let primaryModeForRun = false;
  let dedicatedModeForRun = false;
  let sameProcessDedicatedExitOnly = false;
  let capMismatchForRun = false;
  const freeze = async (reason: string) => {
    if (!auditOnly && primaryModeForRun && isAccountingUnresolvedReason(reason)) {
      try {
        await markPrimaryAccountingUnresolved(reason);
      } catch {
        reason = "primary_accounting_unresolved_state_write_failed";
      }
    }
    if (auditOnly) {
      if (auditRun !== readOnlyAuditRun) return { ready: false, reason: "read_only_audit_superseded" };
      readOnlyAudit = {
        status: "blocked", checkedAt: (dependencies.now?.() ?? new Date()).getTime(),
        reason, ...auditEvidence,
      };
    } else {
      startupReadiness = { ready: false, checkedAt: 0, reason };
    }
    if (gatesEligible && !auditOnly) {
      await db.update(microLiveConfigTable).set({
        manualKillSwitch: true,
        microLiveProductionEnabled: false,
        liveExecutionEnabled: false,
      }).where(eq(microLiveConfigTable.id, "singleton"));
    }
    return { ready: false, reason };
  };
  const flags = environmentFlags();
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!config) return freeze(!flags.microLiveProductionEnabled || !flags.liveExecutionEnabled
    ? "environment_flags_not_both_true" : "micro_live_configuration_absent");
  primaryModeForRun = config.microLiveAccountMode === "primary_nonexclusive" ||
    (config.microLiveAccountMode === null &&
      configuredMicroLiveAccountBinding()?.mode === "primary_nonexclusive");
  dedicatedModeForRun = isDedicatedShardTwoRun(config);
  if (!auditOnly && !dependencies.frozenExitReconciliation &&
      !dependencies.dedicatedPairRecovery && dedicatedModeForRun &&
      config.microLiveRunId && config.microLiveRunPhase === "EXIT_ONLY" &&
      boundedRunOperationId === config.microLiveRunId &&
      readinessWasCurrentAtInvocation && localWorkerLeaseOwner) {
    const leaseNow = dependencies.now?.() ?? new Date();
    const lease = await currentLease(leaseNow);
    sameProcessDedicatedExitOnly = lease.owner === localWorkerLeaseOwner &&
      workerLeaseIsLocalAndCurrent(lease, leaseNow);
  }
  capMismatchForRun = Boolean((primaryModeForRun || dedicatedModeForRun) && config.microLiveRunId &&
    !await currentRunCapMatchesAudit(config));
  if (capMismatchForRun && !auditOnly && !dependencies.frozenExitReconciliation) {
    await freezeBoundedRun(config.microLiveRunId!, "bounded_run_cap_audit_mismatch");
    // A changed cap can never grant execution readiness, but must not hide
    // late exchange fills from the permanently frozen GET-only recovery.
    return reconcileMicroLiveAtStartup({ ...dependencies, frozenExitReconciliation: true });
  }
  if (!auditOnly && !dependencies.frozenExitReconciliation && primaryModeForRun &&
      knownBoundedRunPhase(config.microLiveRunPhase) &&
      ["PREPARING", "ENTRY_OPEN", "EXIT_ONLY"].includes(config.microLiveRunPhase) &&
      (!config.microLiveRunId || boundedRunOperationId !== config.microLiveRunId) &&
      boundedRunRestartRecoveryId !== config.microLiveRunId) {
    if (config.microLiveRunId && config.microLiveRunPhase === "ENTRY_OPEN" &&
        pristineUnusedEntryRunMatches(config, config.microLiveRunId)) {
      startupReadiness = {
        ready: false,
        checkedAt: 0,
        reason: "restart_entry_requires_get_only_reconciliation_and_fresh_fee_evidence",
      };
      return {
        ready: false,
        reason: "restart_entry_requires_get_only_reconciliation_and_fresh_fee_evidence",
      };
    }
    const runId = config.microLiveRunId;
    if (runId) await freezeBoundedRun(runId, "process_restart_requires_explicit_exit_resume");
    return reconcileMicroLiveAtStartup({
      ...dependencies, frozenExitReconciliation: true,
    });
  }
  if (!accountBindingMatchesConfig(config)) {
    if (!auditOnly && primaryModeForRun) {
      await markPrimaryAccountingUnresolved("account_mode_or_subaccount_changed");
    }
    return freeze("account_mode_or_subaccount_changed");
  }
  if (dedicatedModeForRun) {
    if (dependencies.dedicatedPairRecovery &&
        !dependencies.frozenExitReconciliation) {
      return freeze("dedicated_pair_recovery_requires_frozen_mode");
    }
    if (!dedicatedShardTwoCashAnchorMatchesConfig(config)) {
      return freeze("dedicated_pair_funding_anchor_or_cash_baseline_incomplete");
    }
    if (config.microLiveAccountActivityCheckpointRunId !== config.microLiveRunId ||
        config.microLiveAccountActivityCheckpointSubaccount !==
          config.microLiveSelectedSubaccount ||
        config.microLiveAccountActivityCheckpointExchangeIndex !== DEDICATED_EXCHANGE_INDEX ||
        !config.microLiveAccountActivityCheckpointCursor?.trim() ||
        !config.microLiveAccountActivityCheckpointAt ||
        !/^[0-9a-f]{64}$/.test(
          config.microLiveAccountActivityCheckpointEvidenceDigest ?? "",
        )) {
      return freeze("dedicated_pair_activity_checkpoint_incomplete");
    }
    // Any process restart of an activity-bearing dedicated run is first
    // fenced into GET-only recovery. This path never resumes entries, posts
    // replacement exits, or retries an uncertain cancellation.
    if (!dependencies.dedicatedPairRecovery && !sameProcessDedicatedExitOnly) {
      if (config.microLiveRunId) {
        await freezeDedicatedPairRunForRestart(config.microLiveRunId);
      } else {
        await emergencyStopMicroLive();
      }
      return reconcileMicroLiveAtStartup({
        ...dependencies,
        frozenExitReconciliation: true,
        dedicatedPairRecovery: true,
      });
    }
    const [latestOrder] = await db.select().from(microLiveOrderTable)
      .orderBy(desc(microLiveOrderTable.createdAt)).limit(1);
    const [latestPaperEvaluation] = await db.select().from(forwardTestEvaluationTable)
      .where(eq(forwardTestEvaluationTable.evaluationSource, "paper"))
      .orderBy(desc(forwardTestEvaluationTable.evaluatedAt)).limit(1);
    const marketTicker = latestOrder?.marketTicker ?? latestPaperEvaluation?.marketTicker;
    if (!marketTicker || !config.microLiveRunId ||
        !config.microLiveSelectedSubaccount) {
      return freeze("dedicated_pair_startup_market_identity_unavailable");
    }
    // The final persisted-boundary/collateral verifier runs after this
    // read-only pass has committed newly observed fills and order state.
    // Verifying before recovery would reject precisely the late-fill and
    // uncertain-submit cases this path must reconcile.
  }
  if (auditOnly && (dependencies.frozenExitReconciliation ||
      flags.microLiveProductionEnabled || flags.liveExecutionEnabled ||
      config.microLiveProductionEnabled || config.liveExecutionEnabled ||
      !config.manualKillSwitch)) return freeze("read_only_audit_requires_frozen_gates");
  if (auditOnly) {
    const exits = await db.select().from(microLiveOrderTable);
    if (exits.some((row) => row.action === "sell" &&
        ["pending", "partial", "unknown"].includes(row.status))) {
      return freeze("read_only_audit_outstanding_exit_requires_review");
    }
  }
  if (!auditOnly && !dependencies.frozenExitReconciliation) {
    const exits = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.action, "sell"));
    const outstanding = exits.filter((row) =>
      ["pending", "partial", "unknown"].includes(row.status));
    // A linked/uncertain or still-outstanding IOC exit cannot regain POST
    // readiness just because the flags were manually flipped after a crash.
    // A claimed cancellation remains a permanent review boundary even if the
    // exchange later reports the order terminal.
    const claimed = exits.some((row) => row.cancellationAttemptedAt);
    if (claimed) {
      await emergencyStopMicroLive();
      // The durable claim prohibits another DELETE, not authenticated GETs or
      // committing newly verified fills after the first DELETE was ambiguous.
      return reconcileMicroLiveAtStartup({
        ...dependencies, frozenExitReconciliation: true,
      });
    }
    if (primaryModeForRun && outstanding.length) {
      await emergencyStopMicroLive();
      return reconcileMicroLiveAtStartup({
        ...dependencies, frozenExitReconciliation: true,
      });
    }
    if (exits.length &&
        (!config.manualKillSwitch || config.microLiveProductionEnabled ||
          config.liveExecutionEnabled)) {
      await emergencyStopMicroLive();
      if (outstanding.some((row) => !row.exchangeOrderId)) {
        return freeze("reserved_submission_missing_exchange_id");
      }
      // Recover verified exchange fills and status, but never turn the
      // process-local POST barrier back on after any exit in this one-run plan.
      return reconcileMicroLiveAtStartup({
        ...dependencies, frozenExitReconciliation: true,
      });
    }
    if (exits.length && !outstanding.length && config.manualKillSwitch &&
        !config.microLiveProductionEnabled && !config.liveExecutionEnabled) {
      // An IOC can be terminal without a cancellation claim. Its final fills
      // may arrive after the first snapshot, so keep auditing in frozen mode
      // on later restarts rather than leaving an outdated position in the DB.
      return reconcileMicroLiveAtStartup({
        ...dependencies, frozenExitReconciliation: true,
      });
    }
  }
  if (!auditOnly && !dependencies.frozenExitReconciliation && config.manualKillSwitch &&
      !config.microLiveProductionEnabled && !config.liveExecutionEnabled) {
    const exits = await db.select().from(microLiveOrderTable);
    const outstanding = exits.filter((row) => row.action === "sell" &&
      ["pending", "partial", "unknown"].includes(row.status));
    if (outstanding.length === 1 && outstanding[0]!.exchangeOrderId) {
      try {
        const account = await (dependencies.readAccount ?? readKalshiAccount)();
        if (!accountIsComplete(account)) return freeze("account_snapshot_truncated");
        const activity = await (dependencies.readAccountActivity ?? readKalshiAccountActivity)();
        const proof = proveAccountActivity({
          activity, snapshot: account, localOrders: exits,
          boundaryMs: Math.min(config.createdAt.getTime(),
            ...exits.map((row) => row.createdAt.getTime())),
        });
        if (proof.reason) return freeze(proof.reason);
      } catch {
        return freeze("account_history_read_failed");
      }
      return cancelAndVerifyMicroLiveExit(outstanding[0]!.id, dependencies);
    }
    if (outstanding.length) return freeze("frozen_exit_identity_unproven");
  }
  if (!auditOnly && !dependencies.frozenExitReconciliation &&
      (!flags.microLiveProductionEnabled || !flags.liveExecutionEnabled)) {
    return freeze("environment_flags_not_both_true");
  }
  if (!auditOnly && !dependencies.frozenExitReconciliation &&
      (!config.microLiveProductionEnabled || !config.liveExecutionEnabled)) {
    return freeze("database_flags_not_both_enabled");
  }
  if (!auditOnly && (dependencies.frozenExitReconciliation
    ? !config.manualKillSwitch || config.microLiveProductionEnabled || config.liveExecutionEnabled
    : config.manualKillSwitch)) return freeze("micro_live_kill_switch_on");
  gatesEligible = !auditOnly && !dependencies.frozenExitReconciliation;

  try {
    // Capture identity before any potentially long paginated exchange GET.
    let rows = await db.select().from(microLiveOrderTable);
    const fills = await db.select().from(microLiveFillTable);
    const settlements = await db.select().from(microLiveSettlementTable);
    let authenticatedActivity: KalshiAccountActivity | null = null;
    let primarySettlementEvidence: PrimaryCashSettlementEvidence[] = [];
    let primarySettlementOwnershipProven = false;
    let baselineToPersist: {
      micros: string; runId: string; capturedAt: Date; evidenceDigest: string;
    } | null = null;
    let activityCheckpointToPersist: PrimaryCashActivityCheckpoint | null = null;
    if (config.microLiveAccountMode === null && rows.length &&
        configuredMicroLiveAccountBinding()?.mode !== "exclusive") {
      return freeze("unbound_account_mode_with_existing_orders");
    }
    let dedicatedPairActivity: KalshiAccountActivity | null = null;
    if (dedicatedModeForRun) {
      try {
        dedicatedPairActivity = await (dependencies.readAccountActivity ??
          readKalshiAccountActivity)();
      } catch {
        return freeze("dedicated_pair_account_activity_read_failed");
      }
      const identityProblem = dedicatedPairActivityIdentityProblem(
        dedicatedPairActivity,
        config.microLiveSelectedSubaccount ?? -1,
        (dependencies.now?.() ?? new Date()).getTime(),
      );
      if (identityProblem) return freeze(identityProblem);
      const linkProblem = await linkDedicatedPairRestartReservations(
        config, rows, dedicatedPairActivity,
      );
      if (linkProblem) return freeze(linkProblem);
      rows = await db.select().from(microLiveOrderTable);
    }
    // An unlinked reservation may already have reached the exchange. Do not
    // infer ownership or absence from a history scan in place of its identity.
    if (rows.some((row) => !row.exchangeOrderId &&
        (["pending", "unknown", "partial"].includes(row.status) ||
          (["filled", "canceled"].includes(row.status) &&
            (row.filledContracts > 0 || row.reservedRiskCents > 0))))) {
      return freeze("reserved_submission_missing_exchange_id");
    }
    const startingFingerprint = ledgerFingerprint(rows, fills) + JSON.stringify(settlements);
    // The config must have existed before any bot submission. If a known bot
    // order predates the current config (e.g. config was recreated), use the
    // earlier date. This is a classification boundary, NOT proof of ownership.
    const boundaryMs = auditOnly
      ? Math.min(config.createdAt.getTime(), ...rows.map((row) => row.createdAt.getTime()))
      : 0;
    if (auditOnly) {
      if (!Number.isFinite(boundaryMs)) return freeze("read_only_audit_time_boundary_invalid");
      auditEvidence.boundaryAt = new Date(boundaryMs).toISOString();
    }
    let account = await (dependencies.readAccount ?? readKalshiAccount)();
    const historicalTickers = [...new Set(rows
      .filter((row) => row.exchangeOrderId)
      .map((row) => row.marketTicker))];
    if (historicalTickers.length) {
      const historical = await (dependencies.readHistoricalFills ?? readKalshiHistoricalFills)(
        historicalTickers,
      );
      // A 404 is not evidence of zero fills. Current fills may still prove
      // every locally stored fill; authoritative order totals are checked
      // below before readiness is granted.
      if (!historical.available && fills.some((local) =>
          !account.fills.some((current) => current.id === local.exchangeFillId))) {
        return freeze("historical_fill_snapshot_unavailable");
      }
      if (historical.truncated) return freeze("historical_fill_snapshot_truncated");
      if (dedicatedModeForRun && historical.fills.some((fill) =>
        fill.exchangeIndex !== DEDICATED_EXCHANGE_INDEX)) {
        return freeze("dedicated_pair_historical_fill_exchange_index_unproven");
      }
      const mergedFills = mergeStartupFills(account.fills, historical.fills);
      if (!mergedFills) return freeze("historical_fill_overlap_conflict");
      account = { ...account, fills: mergedFills };
    }
    if (dedicatedModeForRun) {
      const identityProblem = dedicatedPairSnapshotIdentityProblem(account);
      if (identityProblem) return freeze(identityProblem);
    }
    if (!accountIsComplete(account)) return freeze("account_snapshot_truncated");
    if (!accountPositionTickersAreUnique(account)) return freeze("exchange_position_duplicate_ticker");
    if (boundedRunRestartRecoveryId === config.microLiveRunId &&
        (account.openOrders.length > 0 || account.fills.length > 0 ||
         account.positions.some((position) => {
           const net = Number(position.positionFp);
           return !Number.isFinite(net) || Math.abs(net) > 0.0001;
         }))) {
      return freeze("pristine_entry_restart_account_not_flat");
    }
    if (!auditOnly || primaryModeForRun) {
      const activity = dedicatedPairActivity ??
        await (dependencies.readAccountActivity ?? readKalshiAccountActivity)();
      if (dedicatedModeForRun) {
        const identityProblem = dedicatedPairActivityIdentityProblem(
          activity,
          config.microLiveSelectedSubaccount ?? -1,
          (dependencies.now?.() ?? new Date()).getTime(),
        );
        if (identityProblem) return freeze(identityProblem);
      }
      authenticatedActivity = activity;
      const proof = dedicatedModeForRun
        ? diagnoseMicroLiveAccountActivity({
          activity, snapshot: account, localOrders: rows,
          boundaryMs: Math.min(config.createdAt.getTime(),
            ...rows.map((row) => row.createdAt.getTime())),
          nowMs: (dependencies.now?.() ?? new Date()).getTime(),
          configuredSubaccount: config.microLiveSelectedSubaccount ?? -1,
        })
        : proveAccountActivity({
        activity, snapshot: account, localOrders: rows,
        boundaryMs: Math.min(config.createdAt.getTime(),
          ...rows.map((row) => row.createdAt.getTime())),
        mode: configuredMicroLiveAccountBinding()?.mode,
        });
      if (proof.reason) {
        if (!auditOnly && primaryModeForRun &&
            isAccountingUnresolvedReason(proof.reason)) {
          await markPrimaryAccountingUnresolved(proof.reason);
        }
        return freeze(proof.reason);
      }
      if (auditOnly) {
        const exchangeIds = new Set(rows.flatMap((row) =>
          row.exchangeOrderId ? [row.exchangeOrderId] : []));
        auditEvidence = {
          ...auditEvidence,
          knownBotFills: proof.botFills.length,
          historicalUnattributedFills: activity.fills.filter((fill) =>
            !fill.orderId || !exchangeIds.has(fill.orderId)).filter((fill) =>
            fill.createdAt && Date.parse(fill.createdAt) < boundaryMs).length,
          unexplainedFills: 0,
        };
      }
      account = { ...account, fills: proof.botFills };
    }
    if (settlements.length) {
      let exchange: KalshiSettlementsSnapshot;
      try {
        exchange = await (dependencies.readSettlements ?? readKalshiSettlements)();
      } catch {
        return freeze("exchange_settlement_read_failed");
      }
      if (exchange.truncated) return freeze("exchange_settlement_snapshot_truncated");
      if (dedicatedModeForRun && exchange.settlements.some((item) =>
        item.exchangeIndex !== DEDICATED_EXCHANGE_INDEX)) {
        return freeze("dedicated_pair_settlement_exchange_index_unproven");
      }
      const settledMarkets = new Set<string>();
      for (const local of settlements) {
        const matches = exchange.settlements.filter((item) => item.ticker === local.marketTicker);
        const actual = matches[0];
        if (primaryModeForRun) {
          const sideCountText = local.side === "UP" ? actual?.yesCountFp : actual?.noCountFp;
          const oppositeCountText = local.side === "UP" ? actual?.noCountFp : actual?.yesCountFp;
          const countIsExact = (value: string | undefined): bigint | null => {
            if (!value || !/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(value)) return null;
            return BigInt(value.split(".")[0]!);
          };
          const sideCount = countIsExact(sideCountText);
          const oppositeCount = countIsExact(oppositeCountText);
          const revenueCents = actual && /^(0|[1-9][0-9]*)$/.test(actual.revenueCents)
            ? BigInt(actual.revenueCents) : null;
          const feeMicros = actual ? dollarsToMicros(actual.feeCostDollars) : null;
          if (matches.length !== 1 || !actual || settledMarkets.has(local.marketTicker) ||
              actual.marketResult !== local.marketResult ||
              sideCount !== BigInt(local.contracts) || oppositeCount !== 0n ||
              revenueCents === null || revenueCents * 10_000n !== BigInt(local.payoutMicros) ||
              local.feeMicros === null || feeMicros === null || feeMicros !== local.feeMicros ||
              Date.parse(actual.settledAt) !== local.settledAt.getTime()) {
            await markPrimaryAccountingUnresolved("primary_cash_settlement_attribution_unresolved");
            return freeze("primary_cash_settlement_attribution_unresolved");
          }
          settledMarkets.add(local.marketTicker);
          primarySettlementEvidence.push({
            id: `${actual.ticker}:${actual.settledAt}`,
            ticker: actual.ticker,
            revenueCents: actual.revenueCents,
            feeCostDollars: actual.feeCostDollars,
          });
          continue;
        }
        const sideCount = Number(local.side === "UP" ? actual?.yesCountFp : actual?.noCountFp);
        const oppositeCount = Number(local.side === "UP" ? actual?.noCountFp : actual?.yesCountFp);
        if (matches.length !== 1 || !actual || actual.marketResult !== local.marketResult ||
            sideCount !== local.contracts || oppositeCount !== 0 ||
            Number(actual.revenueCents) * 10_000 !== local.payoutMicros ||
            dollarsToMicros(actual.feeCostDollars) !== local.feeMicros ||
            Date.parse(actual.settledAt) !== local.settledAt.getTime()) {
          return freeze("exchange_settlement_discrepancy");
        }
      }
      if (primaryModeForRun) primarySettlementOwnershipProven = true;
      // Accounting may be complete, but the entry/exit dispatcher has not
      // been approved to resume after a settled live position.
      if (!primaryModeForRun && !dedicatedModeForRun) {
        return freeze("settlement_requires_manual_reactivation_review");
      }
    }
    const byExchangeId = new Map(rows.flatMap((row) =>
      row.exchangeOrderId ? [[row.exchangeOrderId, row] as const] : []));
    if (byExchangeId.size !== rows.filter((row) => row.exchangeOrderId).length) {
      return freeze("duplicate_local_exchange_order_id");
    }
    const exchangeIds = new Set(rows.flatMap((row) =>
      row.exchangeOrderId ? [row.exchangeOrderId] : []));
    if (auditOnly && !primaryModeForRun) {
      const known = account.fills.filter((fill) => fill.orderId && exchangeIds.has(fill.orderId));
      const other = account.fills.filter((fill) => !fill.orderId || !exchangeIds.has(fill.orderId));
      const historical = other.filter((fill) => fill.createdAt &&
        Number.isFinite(Date.parse(fill.createdAt)) && Date.parse(fill.createdAt) < boundaryMs);
      const unexplained = other.length - historical.length;
      auditEvidence = {
        ...auditEvidence,
        knownBotFills: known.length,
        historicalUnattributedFills: historical.length,
        unexplainedFills: unexplained,
      };
      if (unexplained) return freeze("read_only_new_unexplained_fill_requires_review");
      // Older account activity may be unrelated, but mixing it with bot
      // evidence on the same market could conceal inventory/settlement issues.
      if (historical.some((fill) => rows.some((row) => row.marketTicker === fill.ticker))) {
        return freeze("read_only_historical_market_overlap_requires_review");
      }
      account = { ...account, fills: known };
    }

    if (fills.some((fill) => !account.fills.some((exchangeFill) =>
      exchangeFill.id === fill.exchangeFillId))) {
      return freeze("local_fill_missing_from_exchange_snapshot");
    }
    if (account.fills.some((fill) => !fill.orderId || !exchangeIds.has(fill.orderId))) {
      return freeze("exchange_fill_discrepancy");
    }
    if (account.openOrders.some((exchangeOrder) => {
      const local = byExchangeId.get(exchangeOrder.id);
      if (primaryModeForRun && !local &&
          !rows.some((row) => row.marketTicker === exchangeOrder.ticker)) return false;
      return !local || local.marketTicker !== exchangeOrder.ticker ||
        (local.side === "UP" ? "yes" : "no") !== exchangeOrder.side ||
        exchangeOrder.action !== local.action;
    })) return freeze("exchange_open_order_discrepancy");
    if (account.fills.some((fill) => {
      const local = byExchangeId.get(fill.orderId!);
      return !local || local.marketTicker !== fill.ticker ||
        fill.action !== local.action;
    })) return freeze("exchange_fill_discrepancy");

    const statusReader = dependencies.readOrderStatus ?? ((id: string) =>
      createMicroLiveTradingClient().getOrder(id));
    const statuses = new Map<string, KalshiOrder>();
    for (const row of rows) {
      if (!row.exchangeOrderId) {
        if (row.status !== "rejected") return freeze("reserved_submission_missing_exchange_id");
        continue;
      }
      const status = await statusReader(row.exchangeOrderId);
      if (status.orderId !== row.exchangeOrderId || status.ticker !== row.marketTicker ||
          status.side !== (row.side === "UP" ? "yes" : "no") || status.action !== row.action) {
        return freeze("exchange_order_identity_discrepancy");
      }
      const authoritativeFilled = status.filledCount === null
        ? Number.NaN : Number(status.filledCount);
      if (!Number.isSafeInteger(authoritativeFilled) || authoritativeFilled < 0) {
        return freeze("exchange_order_fill_count_unavailable");
      }
      if (authoritativeFilled > row.requestedContracts) {
        return freeze("exchange_order_fill_count_exceeds_reserved_order");
      }
      statuses.set(row.id, status);
    }
    if (account.fills.some((fill) => {
      const row = byExchangeId.get(fill.orderId!);
      const status = row && statuses.get(row.id);
      return !status || microLiveOrderLegFillPrice(fill, {
        id: status.orderId, ticker: status.ticker, side: status.side,
        action: status.action, outcomeSide: status.outcomeSide,
        bookSide: status.bookSide,
      }) === null;
    })) return freeze("exchange_fill_discrepancy");

    const fillCounts = new Map<string, number>();
    const fillCosts = new Map<string, number>();
    const exchangeFillIds = new Set<string>();
    const precisionPromotions: Array<{
      id: string; orderId: string; tradeMicros: number;
      feeMicros: number | null; feeCents: number; feeKnown: boolean;
    }> = [];
    const additions: Array<{
      id: string; orderId: string; exchangeFillId: string; exchangeOrderId: string;
      filledAt: Date; contracts: number; fillPrice: number; costCents: number;
      tradeMicros: number; feeMicros: number | null; feeCents: number; feeKnown: boolean;
      action: string; positionId: string | null; proceedsCents: number | null;
      costBasisCents: number | null;
    }> = [];
    for (const fill of account.fills.slice().sort((a, b) =>
      Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "") ||
      a.id.localeCompare(b.id))) {
      if (exchangeFillIds.has(fill.id)) return freeze("exchange_duplicate_fill_id");
      exchangeFillIds.add(fill.id);
      const row = byExchangeId.get(fill.orderId!);
      const count = Number(fill.countFp);
      const status = row && statuses.get(row.id);
      const legPrice = status ? microLiveOrderLegFillPrice(fill, {
        id: status.orderId, ticker: status.ticker, side: status.side,
        action: status.action, outcomeSide: status.outcomeSide,
        bookSide: status.bookSide,
      }) : null;
      const price = Number(legPrice);
      const tradeMicros = fillTradeMicros(count, legPrice);
      const feeMicros = dollarsToMicros(fill.feeCostDollars);
      if (!row || legPrice === null || !Number.isSafeInteger(count) || count <= 0 ||
          !Number.isFinite(price) || price <= 0 || price > 1 ||
          tradeMicros === null ||
          (fill.feeCostDollars != null && feeMicros === null) ||
          (row.action === "buy" ? price > row.requestedLimitPrice + 0.0001 :
            price < row.requestedLimitPrice - 0.0001) ||
          !fill.createdAt || !Number.isFinite(Date.parse(fill.createdAt))) {
        return freeze("exchange_fill_invalid");
      }
      fillCounts.set(row.id, (fillCounts.get(row.id) ?? 0) + count);
      const costCents = row.action === "buy" ? centsForContracts(count, price) : 0;
      fillCosts.set(row.id, (fillCosts.get(row.id) ?? 0) + costCents);
      const existing = fills.find((localFill) => localFill.exchangeFillId === fill.id);
      if (existing && (existing.orderId !== row.id || existing.contracts !== count ||
          existing.exchangeOrderId !== fill.orderId || existing.costCents !== costCents ||
          existing.action !== row.action ||
           existing.fillPrice !== price ||
           existing.filledAt.getTime() !== Date.parse(fill.createdAt!) ||
            (existing.tradeMicros !== null && existing.tradeMicros !== tradeMicros) ||
            (existing.feeKnown && feeMicros !== null && existing.feeMicros !== feeMicros) ||
          (row.action === "sell" &&
            existing.proceedsCents !== centsForContracts(count, price)))) {
        return freeze("local_exchange_fill_mismatch");
      }
      if (existing && (existing.tradeMicros === null ||
          (!existing.feeKnown && feeMicros !== null))) {
        const positionId = row.action === "sell" ? row.exitPositionId :
          row.positionId ?? `position:${row.marketTicker}:${row.crossingKey}`;
        if (existing.feeKnown || existing.feeMicros !== null ||
            rows.some((order) => order.action === "sell" && order.exitPositionId === positionId)) {
          return freeze("historical_fill_precision_requires_manual_review");
        }
        precisionPromotions.push({
          id: existing.id, orderId: row.id, tradeMicros,
          feeMicros, feeCents: feeMicros === null ? 0 : microsToRoundedCents(feeMicros),
          feeKnown: feeMicros !== null,
        });
      }
      if (!existing) {
        const positionId = row.action === "sell" ? row.exitPositionId :
          row.positionId ?? `position:${row.marketTicker}:${row.crossingKey}`;
        let basis: number | null = null;
        if (row.action === "sell") {
          const available = [...fills.map((candidate) => {
            const parent = rows.find((order) => order.id === candidate.orderId);
            return {
              ...candidate,
              positionId: candidate.positionId ??
                (parent?.action === "sell" ? parent.exitPositionId :
                  parent?.positionId ??
                  (parent ? `position:${parent.marketTicker}:${parent.crossingKey}` : null)),
            };
          }), ...additions].filter((candidate) =>
            candidate.positionId === positionId &&
            candidate.filledAt.getTime() <= Date.parse(fill.createdAt!));
          basis = fifoExitCostBasis(
            available.filter((candidate) => candidate.action === "buy").map((candidate) => ({
              ...candidate, feeCents: "feeCents" in candidate ? Number(candidate.feeCents) : 0,
              feeKnown: "feeKnown" in candidate ? Boolean(candidate.feeKnown) : false,
              proceedsCents: null, costBasisCents: null,
            })),
            available.filter((candidate) => candidate.action === "sell").map((candidate) => ({
              ...candidate, feeCents: "feeCents" in candidate ? Number(candidate.feeCents) : 0,
              feeKnown: "feeKnown" in candidate ? Boolean(candidate.feeKnown) : false,
              proceedsCents: candidate.proceedsCents ?? null,
              costBasisCents: candidate.costBasisCents ?? null,
            })), count,
          );
          if (basis === null) return freeze("exchange_sell_basis_unproven");
        }
        additions.push({
          id: randomUUID(), orderId: row.id, exchangeFillId: fill.id,
          exchangeOrderId: fill.orderId!, filledAt: new Date(fill.createdAt),
          contracts: count, fillPrice: price, costCents, action: row.action,
          tradeMicros, feeMicros, feeCents: feeMicros === null ? 0 : microsToRoundedCents(feeMicros),
          feeKnown: feeMicros !== null,
          positionId, proceedsCents: row.action === "sell" ? centsForContracts(count, price) : null,
          costBasisCents: basis,
        });
      }
    }

    const recoveredOrders: Array<{
      id: string; status: "pending" | "partial" | "filled" | "canceled";
      filledContracts: number; remainingContracts: number; reservedRiskCents: number;
    }> = [];
    for (const row of rows) {
      const status = statuses.get(row.id);
      if (!status) continue;
      const open = account.openOrders.find((order) => order.id === row.exchangeOrderId);
      const filled = fillCounts.get(row.id) ?? 0;
      if (filled > row.requestedContracts) return freeze("exchange_fill_exceeds_reserved_order");
      if (Number(status.filledCount) !== filled) {
        return freeze("exchange_order_fill_count_discrepancy");
      }
      if (open) {
        const remaining = Number(open.remainingCount);
        const openPrice = Number(open.priceDollars);
        if (status.status !== "resting" || !Number.isSafeInteger(remaining) || remaining < 0 ||
            Number(status.remainingCount) !== remaining ||
            (Number.isFinite(openPrice) &&
              Math.abs(openPrice - row.requestedLimitPrice) > 0.0001) ||
            filled + remaining !== row.requestedContracts) {
          return freeze("exchange_open_order_discrepancy");
        }
        recoveredOrders.push({
          id: row.id, status: filled > 0 ? "partial" : "pending",
          filledContracts: filled, remainingContracts: remaining,
          reservedRiskCents: row.action === "buy"
            ? (fillCosts.get(row.id) ?? 0) +
              centsForContracts(remaining, row.requestedLimitPrice) : 0,
        });
      } else if (status.status === "executed") {
        if ((filled !== row.requestedContracts && row.action !== "sell") ||
            Number(status.remainingCount) !== 0) {
          return freeze("executed_order_fill_discrepancy");
        }
        recoveredOrders.push({
          id: row.id, status: filled === row.requestedContracts ? "filled" : "canceled",
          filledContracts: filled, remainingContracts: 0,
          reservedRiskCents: row.action === "buy" ? fillCosts.get(row.id) ?? 0 : 0,
        });
      } else if (status.status === "canceled") {
        if (Number(status.remainingCount) !== 0) return freeze("exchange_canceled_order_discrepancy");
        recoveredOrders.push({
          id: row.id, status: "canceled", filledContracts: filled, remainingContracts: 0,
          reservedRiskCents: row.action === "buy" ? fillCosts.get(row.id) ?? 0 : 0,
        });
      } else {
        return freeze("local_order_exchange_discrepancy");
      }
    }

    // Frozen exit recovery must commit authoritative GET-only fill/status
    // evidence even when cash eligibility cannot currently be proven. It never
    // grants readiness; the ordinary recovery/preflight path checks cash
    // before execution can resume.
    if (!auditOnly && primaryModeForRun && !dependencies.frozenExitReconciliation) {
      const cashFailure = async (reason: string) => {
        await markPrimaryAccountingUnresolved(reason);
        return freeze(reason);
      };
      if (!config.microLiveRunId || !authenticatedActivity) {
        return cashFailure("primary_cash_run_or_activity_missing");
      }
      const availableCashMicros = dollarsToMicros(account.balance.availableCashDollars);
      if (availableCashMicros === null) {
        return cashFailure("primary_cash_available_balance_precision_unproven");
      }
      const activity = authenticatedActivity;
      const botOrderIds = rows.flatMap((row) =>
        row.exchangeOrderId ? [row.exchangeOrderId] : []);
      const botOrderIdSet = new Set(botOrderIds);
      const normalizedCashFills = activity.fills.map((fill) => {
        const local = fill.orderId ? byExchangeId.get(fill.orderId) : undefined;
        if (!local) return fill;
        const status = statuses.get(local.id);
        const priceDollars = status ? microLiveOrderLegFillPrice(fill, {
          id: status.orderId, ticker: status.ticker, side: status.side,
          action: status.action, outcomeSide: status.outcomeSide,
          bookSide: status.bookSide,
        }) : null;
        return { ...fill, priceDollars };
      });
      const currentRunActivity = {
        authenticated: activity.available,
        complete: activity.available && !activity.truncated,
        selectedSubaccount: activity.selectedSubaccount ?? -1,
        scanFinishedAt: activity.scanFinishedAt ?? "",
        allCashComponentsKnown: account.openOrders.length === 0 &&
          !activity.orders.some((order) => order.status === "resting"),
        fills: normalizedCashFills,
        settlements: primarySettlementEvidence,
        botOrderIds,
        nonBotOrderIds: activity.orders.map((order) => order.id)
          .filter((id) => !botOrderIdSet.has(id)),
        botSettlementIds: primarySettlementEvidence.map((item) => item.id),
        nonBotSettlementIds: [],
        botSettlementOwnershipProven: primarySettlementOwnershipProven,
      };
      if (config.microLivePrimaryCashBaselineMicros === null) {
        if (process.env.NODE_ENV !== "development") {
          return cashFailure("primary_cash_baseline_development_only");
        }
        const pristinePreparingRun = config.microLiveRunPhase === "PREPARING" &&
          !dependencies.frozenExitReconciliation &&
          !config.microLiveEntryAttempted && !config.microLiveExitAttempted &&
          config.microLiveReservedMicros === 0 && rows.length === 0 &&
          fills.length === 0 && settlements.length === 0 &&
          account.openOrders.length === 0 &&
          account.positions.every((position) => {
            const net = Number(position.positionFp);
            return Number.isFinite(net) && Math.abs(net) <= 0.0001;
          });
        if (!pristinePreparingRun) {
          return cashFailure("primary_cash_baseline_missing_not_pristine_preparing");
        }
        const capturedAt = new Date(Date.parse(activity.scanFinishedAt!));
        const evidenceDigest = createHash("sha256").update(JSON.stringify({
          subaccount: 0,
          availableCashDollars: account.balance.availableCashDollars,
          account,
          activity,
        })).digest("hex");
        baselineToPersist = {
          micros: String(availableCashMicros),
          runId: config.microLiveRunId,
          capturedAt,
          evidenceDigest,
        };
      } else {
        if (config.microLivePrimaryCashBaselineRunId !== config.microLiveRunId ||
            config.microLivePrimaryCashBaselineAt === null ||
            config.microLivePrimaryCashBaselineEvidenceDigest === null) {
          return cashFailure("primary_cash_baseline_identity_invalid");
        }
        const cashResult = computeBotAttributableAvailableCashDelta({
          baseline: {
            availableCashMicros: config.microLivePrimaryCashBaselineMicros,
            runId: config.microLivePrimaryCashBaselineRunId,
            capturedAt: config.microLivePrimaryCashBaselineAt.toISOString(),
            evidenceDigest: config.microLivePrimaryCashBaselineEvidenceDigest,
          },
          currentRunId: config.microLiveRunId,
          currentAvailableCashDollars: account.balance.availableCashDollars,
          activity: currentRunActivity,
          nowMs: (dependencies.now?.() ?? new Date()).getTime(),
        });
        if (!cashResult.ok) return cashFailure(cashResult.reason);
      }
      const baseline: PrimaryCashBaseline = baselineToPersist ? {
        availableCashMicros: baselineToPersist.micros,
        runId: baselineToPersist.runId,
        capturedAt: baselineToPersist.capturedAt.toISOString(),
        evidenceDigest: baselineToPersist.evidenceDigest,
      } : {
        availableCashMicros: config.microLivePrimaryCashBaselineMicros!,
        runId: config.microLivePrimaryCashBaselineRunId!,
        capturedAt: config.microLivePrimaryCashBaselineAt!.toISOString(),
        evidenceDigest: config.microLivePrimaryCashBaselineEvidenceDigest!,
      };
      const checkpoint = await verifyPrimaryActivityCheckpoint(
        config, baseline, dependencies, (dependencies.now?.() ?? new Date()).getTime(),
      );
      if ("reason" in checkpoint) return cashFailure(checkpoint.reason);
      activityCheckpointToPersist = checkpoint.checkpoint;
    }

    if (!auditOnly && primaryModeForRun && settlements.length) {
      return freeze("settlement_requires_manual_reactivation_review");
    }

    if (auditOnly) {
      // A diagnostic is not a recovery: compare every authenticated snapshot in
      // memory, but do not update the ledger, cancel an exit, or set readiness.
      const latestConfig = await db.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
      const latestFlags = environmentFlags();
      if (!latestConfig[0]?.manualKillSwitch ||
          latestConfig[0].createdAt.getTime() !== config.createdAt.getTime() ||
          latestConfig[0].microLiveProductionEnabled || latestConfig[0].liveExecutionEnabled ||
          latestFlags.microLiveProductionEnabled || latestFlags.liveExecutionEnabled) {
        return freeze("read_only_audit_gates_changed");
      }
      const currentOrders = await db.select().from(microLiveOrderTable);
      const currentFills = await db.select().from(microLiveFillTable);
      const currentSettlements = await db.select().from(microLiveSettlementTable);
      if (ledgerFingerprint(currentOrders, currentFills) + JSON.stringify(currentSettlements) !== startingFingerprint) {
        return freeze("startup_ledger_changed_during_exchange_snapshot");
      }
      const expectedPositions = new Map<string, number>();
      for (const fill of [...fills, ...additions]) {
        const row = rows.find((candidate) => candidate.id === fill.orderId);
        if (!row || fill.action !== row.action || !fill.exchangeOrderId) {
          return freeze("startup_ledger_fill_identity_mismatch");
        }
        expectedPositions.set(row.marketTicker,
          (expectedPositions.get(row.marketTicker) ?? 0) +
          (row.side === "UP" ? 1 : -1) * (row.action === "buy" ? 1 : -1) * fill.contracts);
      }
      for (const settlement of settlements) {
        expectedPositions.set(settlement.marketTicker,
          (expectedPositions.get(settlement.marketTicker) ?? 0) -
          (settlement.side === "UP" ? 1 : -1) * settlement.contracts);
      }
      const actualPositions = new Map(account.positions.map((position) =>
        [position.ticker, Number(position.positionFp)] as const));
      const positionTickers = primaryModeForRun
        ? new Set(rows.map((row) => row.marketTicker))
        : new Set([...expectedPositions.keys(), ...actualPositions.keys()]);
      auditEvidence.positionDiscrepancies =
        [...positionTickers].filter((market) =>
        !Number.isFinite(actualPositions.get(market) ?? 0) ||
        Math.abs((expectedPositions.get(market) ?? 0) -
          (actualPositions.get(market) ?? 0)) > 0.0001).length;
      if (auditEvidence.positionDiscrepancies) {
        return freeze("exchange_position_discrepancy");
      }
      if (additions.length || precisionPromotions.length ||
          recoveredOrders.some((recovered) => {
            const row = rows.find((item) => item.id === recovered.id)!;
            return row.status !== recovered.status ||
              row.filledContracts !== recovered.filledContracts ||
              row.remainingContracts !== recovered.remainingContracts ||
              row.reservedRiskCents !== recovered.reservedRiskCents;
          })) return freeze("read_only_recovery_writes_required");
      const ledger = reconstructMicroLivePositions({ orders: rows, fills, settlements });
      if (ledger.anomalies.length) {
        return freeze(`startup_ledger_anomaly_${ledger.anomalies[0]!.code}`);
      }
      if (capMismatchForRun) return freeze("bounded_run_cap_audit_mismatch");
      // Exclusive mode's current snapshot cannot prove the absence of aged-out
      // orders. Primary mode has checked complete account activity above, but
      // neither diagnostic can grant execution readiness.
      if (auditRun !== readOnlyAuditRun) return { ready: false, reason: "read_only_audit_superseded" };
      const reason = primaryModeForRun
        ? "read_only_primary_history_verified"
        : "read_only_current_snapshot_matches_history_unproven";
      readOnlyAudit = {
        status: "observed", checkedAt: (dependencies.now?.() ?? new Date()).getTime(),
        reason,
        ...auditEvidence,
      };
      return { ready: false, reason };
    }
    const committed = await db.transaction(async (tx) => {
      // Match the final POST / stop interlock. Do not hold this lock over GETs.
      const [lockedConfig] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const latestFlags = environmentFlags();
      const dedicatedPairIdentityChanged = dedicatedModeForRun && (
        !lockedConfig || !dedicatedShardTwoCashAnchorMatchesConfig(lockedConfig) ||
        lockedConfig.microLiveRunId !== config.microLiveRunId ||
        lockedConfig.microLiveSelectedExchangeIndex !==
          config.microLiveSelectedExchangeIndex ||
        lockedConfig.microLiveRestrictedApiKeyId !== config.microLiveRestrictedApiKeyId ||
        lockedConfig.microLiveRestrictedKeyFingerprint !==
          config.microLiveRestrictedKeyFingerprint ||
        lockedConfig.microLiveFundingAnchorSubaccount !==
          config.microLiveFundingAnchorSubaccount ||
        lockedConfig.microLiveFundingAnchorExchangeIndex !==
          config.microLiveFundingAnchorExchangeIndex ||
        lockedConfig.microLiveFundingAnchorTransferId !==
          config.microLiveFundingAnchorTransferId ||
        lockedConfig.microLiveFundingAnchorTransferAt?.getTime() !==
          config.microLiveFundingAnchorTransferAt?.getTime() ||
        lockedConfig.microLivePairCashBaselineMicros !==
          config.microLivePairCashBaselineMicros ||
        lockedConfig.microLivePairCashBaselineRunId !==
          config.microLivePairCashBaselineRunId ||
        lockedConfig.microLivePairCashBaselineAt?.getTime() !==
          config.microLivePairCashBaselineAt?.getTime() ||
        lockedConfig.microLivePairCashBaselineEvidenceDigest !==
          config.microLivePairCashBaselineEvidenceDigest ||
        lockedConfig.microLiveAccountActivityCheckpointRunId !==
          config.microLiveAccountActivityCheckpointRunId ||
        lockedConfig.microLiveAccountActivityCheckpointCursor !==
          config.microLiveAccountActivityCheckpointCursor ||
        lockedConfig.microLiveAccountActivityCheckpointAt?.getTime() !==
          config.microLiveAccountActivityCheckpointAt?.getTime() ||
        lockedConfig.microLiveAccountActivityCheckpointEvidenceDigest !==
          config.microLiveAccountActivityCheckpointEvidenceDigest ||
        lockedConfig.microLiveAccountActivityCheckpointSubaccount !==
          config.microLiveAccountActivityCheckpointSubaccount ||
        lockedConfig.microLiveAccountActivityCheckpointExchangeIndex !==
          config.microLiveAccountActivityCheckpointExchangeIndex);
        if (!lockedConfig || !accountBindingMatchesConfig(lockedConfig) ||
            dedicatedPairIdentityChanged ||
            lockedConfig.microLiveAccountMode !== config.microLiveAccountMode ||
            lockedConfig.microLiveSelectedSubaccount !== config.microLiveSelectedSubaccount ||
             lockedConfig.microLivePrimaryCashBaselineMicros !==
               config.microLivePrimaryCashBaselineMicros ||
             lockedConfig.microLivePrimaryCashBaselineRunId !==
               config.microLivePrimaryCashBaselineRunId ||
             lockedConfig.microLivePrimaryCashBaselineAt?.getTime() !==
               config.microLivePrimaryCashBaselineAt?.getTime() ||
             lockedConfig.microLivePrimaryCashBaselineEvidenceDigest !==
               config.microLivePrimaryCashBaselineEvidenceDigest ||
              lockedConfig.microLivePrimaryActivityCheckpointRunId !==
                config.microLivePrimaryActivityCheckpointRunId ||
              lockedConfig.microLivePrimaryActivityCheckpointCursor !==
                config.microLivePrimaryActivityCheckpointCursor ||
              lockedConfig.microLivePrimaryActivityCheckpointAt?.getTime() !==
                config.microLivePrimaryActivityCheckpointAt?.getTime() ||
              lockedConfig.microLivePrimaryActivityCheckpointEvidenceDigest !==
                config.microLivePrimaryActivityCheckpointEvidenceDigest ||
            (dependencies.frozenExitReconciliation
         ? !lockedConfig.manualKillSwitch || lockedConfig.microLiveProductionEnabled ||
           lockedConfig.liveExecutionEnabled
         : lockedConfig.manualKillSwitch || !lockedConfig.microLiveProductionEnabled ||
           !lockedConfig.liveExecutionEnabled ||
            !latestFlags.microLiveProductionEnabled || !latestFlags.liveExecutionEnabled) ||
            lockedConfig.createdAt.getTime() !== config.createdAt.getTime()) {
        return { ready: false, reason: "startup_recovery_gates_changed" };
      }
      const lockedCapMismatch = Boolean(primaryModeForRun && lockedConfig.microLiveRunId &&
        !runCapMatchesAudit(lockedConfig,
          await tx.select({
            priorRunId: microLiveRunArchiveTable.priorRunId,
            successorRunId: microLiveRunArchiveTable.successorRunId,
          }).from(microLiveRunArchiveTable)));
      if (lockedCapMismatch && !dependencies.frozenExitReconciliation) {
        return { ready: false, reason: "bounded_run_cap_audit_mismatch" };
      }
      capMismatchForRun ||= lockedCapMismatch;

      // The config lock fences reservation and POST paths; table locks also
      // fence existing reconciliation writes that update ledger rows directly.
      await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable}, ${microLiveSettlementTable}
        IN SHARE ROW EXCLUSIVE MODE`);
      const currentOrders = await tx.select().from(microLiveOrderTable);
      const currentFills = await tx.select().from(microLiveFillTable);
      const currentSettlements = await tx.select().from(microLiveSettlementTable);
      if (ledgerFingerprint(currentOrders, currentFills) + JSON.stringify(currentSettlements) !== startingFingerprint) {
        return { ready: false, reason: "startup_ledger_changed_during_exchange_snapshot" };
      }
      if (baselineToPersist) {
        if (lockedConfig.microLiveRunId !== baselineToPersist.runId ||
            lockedConfig.microLiveRunPhase !== "PREPARING" ||
            lockedConfig.microLivePrimaryCashBaselineMicros !== null ||
            lockedConfig.microLivePrimaryCashBaselineRunId !== null ||
            lockedConfig.microLivePrimaryCashBaselineAt !== null ||
            lockedConfig.microLivePrimaryCashBaselineEvidenceDigest !== null ||
            lockedConfig.microLiveEntryAttempted || lockedConfig.microLiveExitAttempted ||
            lockedConfig.microLiveReservedMicros !== 0 || currentOrders.length ||
            currentFills.length || currentSettlements.length) {
          return { ready: false, reason: "primary_cash_baseline_state_changed" };
        }
        await tx.update(microLiveConfigTable).set({
          microLivePrimaryCashBaselineMicros: baselineToPersist.micros,
          microLivePrimaryCashBaselineRunId: baselineToPersist.runId,
          microLivePrimaryCashBaselineAt: baselineToPersist.capturedAt,
          microLivePrimaryCashBaselineEvidenceDigest: baselineToPersist.evidenceDigest,
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }
      if (activityCheckpointToPersist) {
        await tx.update(microLiveConfigTable).set({
          microLivePrimaryActivityCheckpointRunId: activityCheckpointToPersist.runId,
          microLivePrimaryActivityCheckpointCursor: activityCheckpointToPersist.cursor,
          microLivePrimaryActivityCheckpointAt: new Date(activityCheckpointToPersist.capturedAt),
          microLivePrimaryActivityCheckpointEvidenceDigest: activityCheckpointToPersist.evidenceDigest,
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }
      const binding = configuredMicroLiveAccountBinding();
      if (binding?.mode === "exclusive" && lockedConfig.microLiveAccountMode === null &&
          (lockedConfig.microLiveEntryAttempted || lockedConfig.microLiveExitAttempted || rows.length)) {
        await tx.update(microLiveConfigTable).set({
          microLiveAccountMode: binding.mode,
          microLiveSelectedSubaccount: binding.subaccount,
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }

      for (const promotion of precisionPromotions) {
        await tx.update(microLiveFillTable).set({
          tradeMicros: promotion.tradeMicros, feeMicros: promotion.feeMicros,
          feeCents: promotion.feeCents, feeKnown: promotion.feeKnown,
        }).where(eq(microLiveFillTable.id, promotion.id));
        const order = rows.find((row) => row.id === promotion.orderId)!;
        await tx.insert(microLiveDecisionTable).values({
          id: randomUUID(), orderId: order.id, evaluationId: order.sourceEvaluationId,
          status: "ALLOW", reason: `startup_fill_precision_promoted;local_fill_id=${promotion.id}`,
        });
      }
      for (const addition of additions) {
        await tx.insert(microLiveFillTable).values(addition);
      }
      for (const recovered of recoveredOrders) {
        await tx.update(microLiveOrderTable).set({
          status: recovered.status,
          filledContracts: recovered.filledContracts,
          remainingContracts: recovered.remainingContracts,
          reservedRiskCents: recovered.reservedRiskCents,
          lastReconciledAt: dependencies.now?.() ?? new Date(),
          ...(recovered.status === "filled" ? { filledAt: dependencies.now?.() ?? new Date() } : {}),
          ...(recovered.status === "canceled" ? { canceledAt: dependencies.now?.() ?? new Date() } : {}),
        }).where(eq(microLiveOrderTable.id, recovered.id));
      }
      await dependencies.afterRecoveryWrites?.();

      const committedOrders = await tx.select().from(microLiveOrderTable);
      const committedFills = await tx.select().from(microLiveFillTable);
      const recoveredLedger = reconstructMicroLivePositions({
        orders: committedOrders,
        fills: committedFills,
        settlements: currentSettlements,
      });
      if (recoveredLedger.anomalies.length) {
        throw new StartupRecoveryAbort(`startup_ledger_anomaly_${recoveredLedger.anomalies[0]!.code}`);
      }
      const ordersById = new Map(committedOrders.map((row) => [row.id, row]));
      const expectedPositions = new Map<string, number>();
      for (const fill of committedFills) {
        const row = ordersById.get(fill.orderId);
        if (!row || fill.action !== row.action || !fill.exchangeOrderId) {
          throw new StartupRecoveryAbort("startup_ledger_fill_identity_mismatch");
        }
        expectedPositions.set(row.marketTicker,
          (expectedPositions.get(row.marketTicker) ?? 0) +
          (row.side === "UP" ? 1 : -1) * (row.action === "buy" ? 1 : -1) * fill.contracts);
      }
      if (primaryModeForRun) {
        for (const row of committedOrders) {
          if (!expectedPositions.has(row.marketTicker)) expectedPositions.set(row.marketTicker, 0);
        }
      }
      for (const settlement of currentSettlements) {
        expectedPositions.set(settlement.marketTicker,
          (expectedPositions.get(settlement.marketTicker) ?? 0) -
          (settlement.side === "UP" ? 1 : -1) * settlement.contracts);
      }
      const actualPositions = new Map(account.positions.map((position) =>
        [position.ticker, Number(position.positionFp)] as const));
      const positionTickers = primaryModeForRun
        ? new Set(expectedPositions.keys())
        : new Set([...expectedPositions.keys(), ...actualPositions.keys()]);
      if ([...positionTickers].some((market) =>
        !Number.isFinite(actualPositions.get(market) ?? 0) ||
        Math.abs((expectedPositions.get(market) ?? 0) -
          (actualPositions.get(market) ?? 0)) > 0.0001)) {
        throw new StartupRecoveryAbort("exchange_position_discrepancy");
      }
      return { ready: true, reason: "startup_reconciliation_current" };
    });
    if (!committed.ready) {
      if (committed.reason === "bounded_run_cap_audit_mismatch" &&
          !auditOnly && !dependencies.frozenExitReconciliation &&
          primaryModeForRun && config.microLiveRunId) {
        // The cap may change during the exchange GETs. Fence execution under
        // the singleton lock, then repeat the GET-only reconciliation so a
        // late fill is not lost with the aborted transaction.
        await freezeBoundedRun(config.microLiveRunId, committed.reason);
        return reconcileMicroLiveAtStartup({ ...dependencies, frozenExitReconciliation: true });
      }
      return freeze(committed.reason);
    }
    // This is intentionally after the transaction commit. A crash between the
    // commit and here leaves the process-local barrier false.
     if (capMismatchForRun) {
       startupReadiness = { ready: false, checkedAt: 0, reason: "bounded_run_cap_audit_mismatch" };
       return { ready: false, reason: "bounded_run_cap_audit_mismatch" };
     }
        if (dedicatedModeForRun &&
            (dependencies.dedicatedPairRecovery || sameProcessDedicatedExitOnly)) {
        const [latestOrder] = await db.select().from(microLiveOrderTable)
          .orderBy(desc(microLiveOrderTable.createdAt)).limit(1);
        const [latestPaperEvaluation] = await db.select()
          .from(forwardTestEvaluationTable)
          .where(eq(forwardTestEvaluationTable.evaluationSource, "paper"))
          .orderBy(desc(forwardTestEvaluationTable.evaluatedAt)).limit(1);
        const ticker = latestOrder?.marketTicker ?? latestPaperEvaluation?.marketTicker;
        if (!ticker || !config.microLiveRunId ||
            !config.microLiveSelectedSubaccount) {
          return freeze("dedicated_pair_startup_market_identity_unavailable");
        }
        const pairProofMode = sameProcessDedicatedExitOnly
          ? { kind: "final_post" as const, action: "exit" as const, phase: "EXIT_ONLY" as const }
          : { kind: "recovery_get" as const };
        if (pairProofMode.kind === "recovery_get" &&
            config.microLiveRunPhase !== "FROZEN") {
          return freeze("dedicated_pair_recovery_requires_frozen_mode");
        }
         const pairVerification = await readDedicatedPairCollateralProof(config, ticker, {
           ...pairProofMode,
         }, dependencies);
         if (pairVerification.status !== "verified" ||
              pairVerification.mode?.kind !== pairProofMode.kind ||
              pairProofMode.kind === "final_post" &&
                (pairVerification.mode?.kind !== "final_post" ||
                 pairVerification.mode.action !== "exit" ||
                 pairVerification.mode.phase !== "EXIT_ONLY") ||
             pairVerification.runId !== config.microLiveRunId ||
              (dependencies.now?.() ?? new Date()).getTime() -
                pairVerification.checkedAt < 0 ||
              (dependencies.now?.() ?? new Date()).getTime() -
                pairVerification.checkedAt > 5_000 ||
             !/^[0-9a-f]{64}$/.test(pairVerification.evidenceDigest ?? "")) {
           return freeze(pairVerification.reason ??
             "dedicated_pair_restart_collateral_verification_blocked");
         }
        const recoveredOrders = await db.select().from(microLiveOrderTable);
        const outstandingExit = recoveredOrders.some((row) =>
          row.action === "sell" && ["pending", "partial", "unknown"].includes(row.status));
        const outstandingEntry = recoveredOrders.some((row) =>
          row.action === "buy" && ["pending", "partial", "unknown"].includes(row.status));
         const hasExitClaim = config.microLiveExitAttempted ||
           recoveredOrders.some((row) => row.action === "sell");
        const reason = outstandingExit
          ? "dedicated_pair_outstanding_exit_recovered_get_only"
          : outstandingEntry
            ? "dedicated_pair_outstanding_entry_recovered_get_only"
            : "dedicated_pair_activity_recovered_get_only";
         if (dependencies.dedicatedPairRecovery || !sameProcessDedicatedExitOnly ||
             hasExitClaim || outstandingExit || outstandingEntry) {
           startupReadiness = { ready: false, checkedAt: 0, reason };
           return { ready: false, reason };
         }
         const [latestConfig] = await db.select().from(microLiveConfigTable)
           .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
         const leaseNow = dependencies.now?.() ?? new Date();
         const latestLease = await currentLease(leaseNow);
         if (!latestConfig ||
             latestConfig.microLiveRunId !== config.microLiveRunId ||
             latestConfig.microLiveRunPhase !== "EXIT_ONLY" ||
             latestConfig.microLiveExitAttempted ||
             dedicatedPairConfigIdentityFingerprint(latestConfig) !==
               dedicatedPairConfigIdentityFingerprint(config) ||
             latestLease.owner !== localWorkerLeaseOwner ||
             !workerLeaseIsLocalAndCurrent(latestLease, leaseNow)) {
           return freeze("dedicated_pair_exit_reconciliation_process_state_changed");
         }
      }
     if (dependencies.frozenExitReconciliation) {
       const exitRows = (await db.select().from(microLiveOrderTable))
         .filter((row) => row.action === "sell");
       const reason = exitRows.some((row) => row.cancellationAttemptedAt)
         ? "exit_cancellation_requires_manual_reactivation_review"
         : exitRows.some((row) => ["pending", "partial", "unknown"].includes(row.status))
           ? "outstanding_exit_requires_frozen_reconciliation"
           : "exit_canceled_requires_manual_review";
       startupReadiness = { ready: false, checkedAt: 0, reason };
       return { ready: false, reason };
     }
     startupReadiness = { ready: true, checkedAt: (dependencies.now?.() ?? new Date()).getTime(), reason: null };
     return committed;
  } catch (error) {
     const reason = error instanceof StartupRecoveryAbort
       ? error.reason : "startup_exchange_reconciliation_failed";
     if (!auditOnly && primaryModeForRun &&
         isAccountingUnresolvedReason(reason)) {
       await markPrimaryAccountingUnresolved(reason);
     }
     return freeze(reason);
  }
}

/** GET-only exchange evidence audit. Never grants the execution readiness barrier. */
export async function auditMicroLiveReadOnly(
  dependencies: Pick<MicroLiveDependencies,
    "readAccount" | "readAccountActivity" | "readHistoricalFills" | "readSettlements" |
    "readOrderStatus" | "now"> = {},
): Promise<{ ready: boolean; reason: string }> {
  return reconcileMicroLiveAtStartup({ ...dependencies, readOnlyAudit: true });
}

type AccountingResolutionDependencies = Pick<MicroLiveDependencies,
  "readAccount" | "readAccountActivity" | "readHistoricalFills" | "readSettlements" |
  "readOrderStatus" | "now"> & {
    /** Isolated test interlocks only; application callers never supply them. */
    afterAudit?: () => Promise<void>;
    afterLedgerLock?: () => Promise<void>;
  };

/**
 * Administrative correction of one stale startup error, not a recovery or an
 * authorization to trade. Exchange operations are GET-only. No prior attempt
 * can be excused by a clean account snapshot.
 */
export async function resolveStalePrimaryAccounting(
  input: { actorId: string; expectedUnresolvedReason: string; resolutionReason: string },
  dependencies: AccountingResolutionDependencies = {},
): Promise<{ status: "blocked" | "resolved"; reason: string; decisionId?: string }> {
  const blocked = (reason: string) => ({ status: "blocked" as const, reason });
  const reason = input.resolutionReason.trim();
  if (process.env.NODE_ENV !== "development") return blocked("accounting_resolution_development_only");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.actorId) ||
      reason.length < 16 || reason.length > 512 ||
      input.expectedUnresolvedReason !== "startup_exchange_reconciliation_failed") {
    return blocked("accounting_resolution_invalid_request");
  }
  const frozen = (config: typeof microLiveConfigTable.$inferSelect) =>
    config.manualKillSwitch && !config.microLiveProductionEnabled && !config.liveExecutionEnabled &&
    !environmentFlags().microLiveProductionEnabled && !environmentFlags().liveExecutionEnabled;
  const emptyRun = (config: typeof microLiveConfigTable.$inferSelect) =>
    !config.microLiveEntryAttempted && !config.microLiveExitAttempted &&
    config.microLiveRunId === null && config.microLiveReservedMicros === 0;
  const binding = configuredMicroLiveAccountBinding();
  if (binding?.mode !== "primary_nonexclusive" || binding.subaccount !== 0) {
    return blocked("accounting_resolution_primary_account_required");
  }
  const [snapshot] = await db.select({
    ...getTableColumns(microLiveConfigTable), revision: sql<string>`xmin::text`,
  }).from(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!snapshot) {
    return blocked("accounting_resolution_account_binding_changed");
  }
  if (!snapshot.microLiveAccountingUnresolved ||
      snapshot.microLiveAccountingUnresolvedReason !== input.expectedUnresolvedReason) {
    return blocked("accounting_resolution_wrong_unresolved_reason");
  }
  if (!frozen(snapshot)) return blocked("accounting_resolution_requires_frozen_gates");
  if (!emptyRun(snapshot)) return blocked("accounting_resolution_prior_attempt_or_reservation");
  if (!accountBindingMatchesConfig(snapshot, binding)) {
    return blocked("accounting_resolution_account_binding_changed");
  }
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const ledgerEmpty = async () =>
    !(await db.select({ id: microLiveOrderTable.id }).from(microLiveOrderTable).limit(1)).length &&
    !(await db.select({ id: microLiveFillTable.id }).from(microLiveFillTable).limit(1)).length &&
    !(await db.select({ id: microLiveSettlementTable.positionId }).from(microLiveSettlementTable).limit(1)).length;
  if (!(await ledgerEmpty())) return blocked("accounting_resolution_local_ledger_not_empty");
  const decisionsBefore = await db.select().from(microLiveDecisionTable);
  if (decisionsBefore.some((decision) => ["ALLOW", "ERROR"].includes(decision.status))) {
    return blocked("accounting_resolution_prior_attempt_or_reservation");
  }
  const decisionsFingerprint = hash([...decisionsBefore].sort((a, b) => a.id.localeCompare(b.id)));

  let accountDigest: string | null = null;
  let activityDigest: string | null = null;
  type ActivityCounts = { orders: number; fills: number; selectedSubaccount: number;
    scanStartedAt: string | null; scanFinishedAt: string | null };
  let activityCounts: ActivityCounts | null = null;
  const expectedAuditRun = readOnlyAuditRun + 1;
  const audit = await auditMicroLiveReadOnly({
    ...dependencies,
    readAccount: async () => {
      const account = await (dependencies.readAccount ?? readKalshiAccount)();
      accountDigest = hash(account);
      return account;
    },
    readAccountActivity: async () => {
      const activity = await (dependencies.readAccountActivity ?? readKalshiAccountActivity)();
      activityDigest = hash(activity);
      activityCounts = {
        orders: activity.orders.length, fills: activity.fills.length,
        selectedSubaccount: activity.selectedSubaccount ?? -1,
        scanStartedAt: activity.scanStartedAt ?? null,
        scanFinishedAt: activity.scanFinishedAt ?? null,
      };
      return activity;
    },
  });
  const observedActivity = activityCounts as ActivityCounts | null;
  if (audit.reason !== "read_only_primary_history_verified" ||
      readOnlyAuditRun !== expectedAuditRun || readOnlyAudit.status !== "observed" ||
      !accountDigest || !activityDigest || !observedActivity ||
      observedActivity.selectedSubaccount !== 0 ||
      readOnlyAudit.knownBotFills !== 0 || readOnlyAudit.unexplainedFills !== 0 ||
      readOnlyAudit.positionDiscrepancies !== 0) {
    return blocked("accounting_resolution_audit_failed");
  }
  const evidence = {
    auditReason: audit.reason, checkedAt: new Date(readOnlyAudit.checkedAt).toISOString(),
    boundaryAt: readOnlyAudit.boundaryAt,
    knownBotFills: readOnlyAudit.knownBotFills,
    unrelatedFills: readOnlyAudit.historicalUnattributedFills,
    unexplainedFills: readOnlyAudit.unexplainedFills,
    positionDiscrepancies: readOnlyAudit.positionDiscrepancies,
    accountDigest, activityDigest, activityCounts: observedActivity,
  };
  await dependencies.afterAudit?.();
  const decisionId = randomUUID();
  const committed = await db.transaction(async (tx) => {
    const [current] = await tx.select({
      ...getTableColumns(microLiveConfigTable), revision: sql<string>`xmin::text`,
    }).from(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton"))
      .for("update").limit(1);
    if (!current || current.revision !== snapshot.revision ||
        JSON.stringify(current) !== JSON.stringify(snapshot) ||
        !accountBindingMatchesConfig(current, binding) ||
        current.microLiveAccountingUnresolvedReason !== input.expectedUnresolvedReason ||
        !frozen(current) || !emptyRun(current) ||
        readOnlyAuditRun !== expectedAuditRun ||
        Date.now() - readOnlyAudit.checkedAt > RECONCILIATION_MS ||
        Date.now() < readOnlyAudit.checkedAt - 5_000) return false;
    // Fence even writers that do not take the config row lock, including
    // reconciliation and administrative ledger writes, before final checks.
    await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
      ${microLiveSettlementTable}, ${microLiveDecisionTable} IN SHARE ROW EXCLUSIVE MODE`);
    await dependencies.afterLedgerLock?.();
    const lockedDecisions = await tx.select().from(microLiveDecisionTable);
    const finalNow = (dependencies.now?.() ?? new Date()).getTime();
    const currentBinding = configuredMicroLiveAccountBinding();
    if ((await tx.select({ id: microLiveOrderTable.id }).from(microLiveOrderTable).limit(1)).length ||
        (await tx.select({ id: microLiveFillTable.id }).from(microLiveFillTable).limit(1)).length ||
        (await tx.select({ id: microLiveSettlementTable.positionId }).from(microLiveSettlementTable).limit(1)).length ||
        hash([...lockedDecisions].sort((a, b) => a.id.localeCompare(b.id))) !== decisionsFingerprint ||
        process.env.NODE_ENV !== "development" || !frozen(current) ||
        currentBinding?.mode !== binding.mode || currentBinding.subaccount !== binding.subaccount ||
        readOnlyAuditRun !== expectedAuditRun ||
        finalNow - readOnlyAudit.checkedAt > RECONCILIATION_MS ||
        finalNow < readOnlyAudit.checkedAt - 5_000) return false;
    const record = {
      kind: "primary_accounting_resolution", actorId: input.actorId,
      expectedUnresolvedReason: input.expectedUnresolvedReason,
      resolutionReason: reason, evidence,
      evidenceSha256: hash(evidence),
      decision: "clear_stale_accounting_flag_only",
    };
    // BLOCK denotes that this administrative decision never authorizes a
    // trading action; the structured reason is the durable audit record.
    await tx.insert(microLiveDecisionTable).values({
      id: decisionId, status: "BLOCK", reason: JSON.stringify(record),
    });
    // Raw update intentionally bypasses the table's automatic updatedAt hook:
    // only these two accounting fields change on the config row.
    await tx.execute(sql`UPDATE ${microLiveConfigTable}
      SET micro_live_accounting_unresolved = false,
          micro_live_accounting_unresolved_reason = NULL
      WHERE id = 'singleton'`);
    return true;
  });
  if (!committed) return blocked("accounting_resolution_state_changed");
  invalidateMicroLiveReadiness("accounting_resolution_requires_startup_reconciliation");
  return { status: "resolved", reason: "stale_startup_accounting_resolved", decisionId };
}

function environmentFlags() {
  return {
    microLiveProductionEnabled: process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true",
    liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED === "true",
  };
}

async function currentApprovedFeeSession(
  dependencies: MicroLiveDependencies = {},
): Promise<StandingFeePolicyApproval | null> {
  if (isIsolatedFeeTest(dependencies) && dependencies.approvedFeeSessionForTest) {
    const fixture = dependencies.approvedFeeSessionForTest();
    if (!fixture) return null;
    return {
      id: fixture.id,
      digest: fixture.digest,
      approvedAt: fixture.approvedAt,
      policyVersion: fixture.policyVersion ?? MICRO_LIVE_STANDING_FEE_POLICY_VERSION,
      maximumExposureMicros: fixture.maximumExposureMicros ?? LIVE_TEST_CAP_MICROS * 5,
      approvedRunCapMicros: fixture.approvedRunCapMicros ?? LIVE_TEST_CAP_MICROS * 5,
      approvedBy: fixture.approvedBy ?? "isolated-test-administrator",
    };
  }
  return await approvedFeeSession();
}

function isIsolatedFeeTest(dependencies: MicroLiveDependencies = {}): boolean {
  return process.env.NODE_ENV === "development" &&
    /^micro_live_test_[a-f0-9]{24}$/.test(process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "") &&
    Boolean(dependencies.submitOrder);
}

function feeApprovalAllowsRun(
  approval: StandingFeePolicyApproval | null,
  configuredRunCapMicros: number,
  dependencies: MicroLiveDependencies = {},
): approval is StandingFeePolicyApproval {
  const injected = Boolean(dependencies.approvedFeeSessionForTest &&
    isIsolatedFeeTest(dependencies));
  const persistedShapeValid: boolean =
    standingFeePolicyApprovalIsValid(approval, configuredRunCapMicros);
  if (persistedShapeValid) return true;
  // Test-only fixture IDs/digests are intentionally not accepted by the
  // persistent production policy reader or the fee-terms reader.
  return injected && Boolean(approval &&
    approval.id.length > 0 && approval.digest.length > 0 &&
    Number.isSafeInteger(approval.approvedAt) && approval.approvedAt > 0 &&
    approval.policyVersion === MICRO_LIVE_STANDING_FEE_POLICY_VERSION &&
    Number.isSafeInteger(approval.maximumExposureMicros) &&
    approval.maximumExposureMicros > 0 &&
    approval.maximumExposureMicros <= LIVE_TEST_CAP_MICROS * 5 &&
    Number.isSafeInteger(approval.approvedRunCapMicros) &&
    approval.approvedRunCapMicros > 0 &&
    approval.approvedRunCapMicros <= approval.maximumExposureMicros &&
    approval.approvedRunCapMicros >= configuredRunCapMicros &&
    typeof approval.approvedBy === "string" && approval.approvedBy.length > 0);
}

function sameFeeApproval(
  left: StandingFeePolicyApproval | null,
  right: StandingFeePolicyApproval | null,
): boolean {
  return Boolean(left && right && left.id === right.id && left.digest === right.digest &&
    left.approvedAt === right.approvedAt && left.policyVersion === right.policyVersion &&
    left.maximumExposureMicros === right.maximumExposureMicros &&
    left.approvedRunCapMicros === right.approvedRunCapMicros &&
    left.approvedBy === right.approvedBy);
}

function feeApprovalFromConfig(
  config: typeof microLiveConfigTable.$inferSelect | null | undefined,
): StandingFeePolicyApproval | null {
  if (!config || !config.microLiveFeeApprovalApproved ||
      config.microLiveFeeApprovalInvalidated ||
      !config.microLiveFeeApprovalId || !config.microLiveFeeApprovalDigest ||
      !config.microLiveFeeApprovalApprovedAt || !config.microLiveFeePolicyVersion ||
      config.microLiveFeeMaximumExposureMicros === null ||
      config.microLiveFeeMaximumExposureMicros === undefined ||
      config.microLiveFeeApprovedRunCapMicros === null ||
      config.microLiveFeeApprovedRunCapMicros === undefined || !config.microLiveFeeApprovedBy) {
    return null;
  }
  const approval: StandingFeePolicyApproval = {
    id: config.microLiveFeeApprovalId,
    digest: config.microLiveFeeApprovalDigest,
    approvedAt: config.microLiveFeeApprovalApprovedAt.getTime(),
    policyVersion: config.microLiveFeePolicyVersion,
    maximumExposureMicros: config.microLiveFeeMaximumExposureMicros,
    approvedRunCapMicros: config.microLiveFeeApprovedRunCapMicros,
    approvedBy: config.microLiveFeeApprovedBy,
  };
  return standingFeePolicyApprovalIsValid(approval, config.microLiveRunCapMicros)
    ? approval : null;
}

async function feeApprovalAtBarrier(
  config: typeof microLiveConfigTable.$inferSelect | null | undefined,
  dependencies: MicroLiveDependencies,
  tx?: FeeVerificationTransaction,
  evidence?: { fingerprint: string; verifiedAt: number },
): Promise<StandingFeePolicyApproval | null> {
  const persisted = feeApprovalFromConfig(config);
  if (persisted) {
    if (tx) {
      if (!evidence) return null;
      if (config?.microLiveSelectedExchangeIndex === DEDICATED_EXCHANGE_INDEX) {
        const [verification] = await tx.select().from(microLiveFeeVerificationTable)
          .where(eq(microLiveFeeVerificationTable.approvalId, persisted.id))
          .for("update").limit(1);
        const now = (dependencies.now?.() ?? new Date()).getTime();
        const verifiedAt = verification?.checkedAt?.getTime() ?? NaN;
        const termsVerifiedAt = evidence.verifiedAt;
        const identityMatches = verification?.approvalDigest === persisted.digest &&
          verification.policyVersion === persisted.policyVersion &&
          verification.sourceUrl === (config.microLiveFeeApprovalSourceUrl ?? "") &&
          verification.formulaVersion === (config.microLiveFeeFormulaVersion ?? "");
        return verification?.status === "verified" &&
          verification.attemptId === null && identityMatches &&
          verification.feeEvidenceFingerprint === evidence.fingerprint &&
          Number.isFinite(verifiedAt) && Number.isFinite(termsVerifiedAt) &&
          now - verifiedAt >= 0 && now - verifiedAt <= 15_000 &&
          now - termsVerifiedAt >= 0 && now - termsVerifiedAt <= 15_000
          ? persisted : null;
      }
      const gateLocked = await lockFeeVerificationForPost(tx, {
        approvalId: persisted.id,
        approvalDigest: persisted.digest,
        policyVersion: persisted.policyVersion,
        sourceUrl: config?.microLiveFeeApprovalSourceUrl ?? "",
        formulaVersion: config?.microLiveFeeFormulaVersion ?? "",
      }, evidence.fingerprint, evidence.verifiedAt);
      return gateLocked ? persisted : null;
    }
    // A locked configuration row proves the approval identity. Check the
    // separate durable fee-verification gate with DB reads only; live series,
    // event, and scheduled-change metadata is fetched before this locked
    // barrier, never by a PDF or network reader inside the transaction.
    const verified = await approvedFeeSession();
    return sameFeeApproval(persisted, verified) ? persisted : null;
  }
  if (isIsolatedFeeTest(dependencies) && dependencies.approvedFeeSessionForTest) {
    return await currentApprovedFeeSession(dependencies);
  }
  return null;
}

function knownBoundedRunPhase(value: unknown): value is BoundedRunPhase {
  return typeof value === "string" && (BOUNDED_RUN_PHASES as readonly string[]).includes(value);
}

function boundedRunView(config: typeof microLiveConfigTable.$inferSelect | undefined) {
  const phase = config && knownBoundedRunPhase(config.microLiveRunPhase)
    ? config.microLiveRunPhase : null;
  return {
    phase,
    entryDeadlineAt: phase ? config?.microLiveRunDeadline?.toISOString() ?? null : null,
    armedAt: phase ? config?.microLiveRunArmedAt?.toISOString() ?? null : null,
    runId: phase ? config?.microLiveRunId ?? null : null,
    entryAttempted: config?.microLiveEntryAttempted ?? false,
    exitAttempted: config?.microLiveExitAttempted ?? false,
    freezeReason: config?.microLiveRunFreezeReason ?? null,
    capMicros: config?.microLiveRunCapMicros ?? LIVE_TEST_CAP_MICROS,
  };
}

function isPrimaryRun(config: typeof microLiveConfigTable.$inferSelect | undefined) {
  return config?.microLiveAccountMode === "primary_nonexclusive" ||
    (config?.microLiveAccountMode == null &&
      configuredMicroLiveAccountBinding()?.mode === "primary_nonexclusive");
}

function isDedicatedShardTwoRun(
  config: typeof microLiveConfigTable.$inferSelect | undefined,
): boolean {
  return config?.microLiveSelectedExchangeIndex === DEDICATED_EXCHANGE_INDEX;
}

type ArchivedRunIdentity = Pick<typeof microLiveRunArchiveTable.$inferSelect,
  "priorRunId" | "successorRunId">;

function runCapMatchesAudit(
  config: typeof microLiveConfigTable.$inferSelect,
  archivedRuns: ArchivedRunIdentity[],
  pairBoundary?: typeof microLivePairBoundaryTable.$inferSelect,
): boolean {
  if (isDedicatedShardTwoRun(config)) {
    return config.microLiveRunCapMicros === LIVE_TEST_CAP_MICROS &&
      dedicatedPairInitializedRunMatchesAudit(config, pairBoundary, archivedRuns);
  }
  if (!config.microLiveRunId ||
      archivedRuns.some((row) => row.priorRunId === config.microLiveRunId)) return false;
  const successors = archivedRuns.filter((row) => row.successorRunId === config.microLiveRunId);
  return successors.length === 1
    ? config.microLiveRunCapMicros === PREPARED_BOUNDED_RUN_CAP_MICROS
    : config.microLiveRunCapMicros === LIVE_TEST_CAP_MICROS;
}

function dedicatedPairInitializedRunMatchesAudit(
  config: typeof microLiveConfigTable.$inferSelect,
  boundary: typeof microLivePairBoundaryTable.$inferSelect | undefined,
  archivedRuns: ArchivedRunIdentity[],
): boolean {
  const runId = config.microLiveRunId;
  return Boolean(runId && config.microLiveRunCapMicros === LIVE_TEST_CAP_MICROS &&
    isDedicatedShardTwoRun(config) && dedicatedShardTwoCashAnchorMatchesConfig(config) &&
    dedicatedShardTwoIdentityMatchesConfig(config) &&
    boundary?.state === "initialized" && !boundary.ambiguityFrozenAt &&
    boundary.initializedRunId === runId &&
    boundary.subaccountNumber === config.microLiveSelectedSubaccount &&
    boundary.exchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    boundary.restrictedApiKeyId === config.microLiveRestrictedApiKeyId &&
    boundary.restrictedKeyFingerprint === config.microLiveRestrictedKeyFingerprint &&
    boundary.cleanBalanceMicros === "0" &&
    boundary.cleanBalanceSemantics === "available_cash" &&
    boundary.cleanSnapshotAuthenticated &&
    boundary.cleanOrderCount === 0 && boundary.cleanFillCount === 0 &&
    boundary.cleanPositionCount === 0 && boundary.cleanSettlementCount === 0 &&
    /^[0-9a-f]{64}$/.test(boundary.cleanBoundaryEvidenceDigest ?? "") &&
    boundary.fundingTransferId === config.microLiveFundingAnchorTransferId &&
    boundary.fundingAmountCents === 2500 &&
    boundary.fundingTransferredAt?.getTime() ===
      config.microLiveFundingAnchorTransferAt?.getTime() &&
    boundary.postFundingBalanceMicros === "25000000" &&
    boundary.postFundingBalanceSemantics === "available_cash" &&
    boundary.postFundingSnapshotAuthenticated === true &&
    boundary.postFundingSnapshotAt?.getTime() ===
      config.microLivePairCashBaselineAt?.getTime() &&
    boundary.postFundingEvidenceDigest ===
      config.microLivePairCashBaselineEvidenceDigest &&
    boundary.initializedAt !== null &&
    boundary.activityCheckpointCursor ===
      config.microLiveAccountActivityCheckpointCursor &&
    boundary.activityCheckpointAt?.getTime() ===
      config.microLiveAccountActivityCheckpointAt?.getTime() &&
    boundary.activityCheckpointDigest ===
      config.microLiveAccountActivityCheckpointEvidenceDigest &&
    config.microLiveAccountActivityCheckpointRunId === runId &&
    config.microLiveAccountActivityCheckpointSubaccount ===
      config.microLiveSelectedSubaccount &&
    config.microLiveAccountActivityCheckpointExchangeIndex === DEDICATED_EXCHANGE_INDEX &&
    !archivedRuns.some((row) =>
      row.priorRunId === runId || row.successorRunId === runId));
}

async function currentRunCapMatchesAudit(
  config: typeof microLiveConfigTable.$inferSelect,
): Promise<boolean> {
  const archivedRuns = await db.select({
    priorRunId: microLiveRunArchiveTable.priorRunId,
    successorRunId: microLiveRunArchiveTable.successorRunId,
  }).from(microLiveRunArchiveTable);
  const [pairBoundary] = isDedicatedShardTwoRun(config) &&
      config.microLiveSelectedSubaccount
    ? await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber,
        config.microLiveSelectedSubaccount)).limit(1)
    : [];
  return runCapMatchesAudit(config, archivedRuns, pairBoundary);
}

function boundedEntryReservationMatchesRun(
  config: typeof microLiveConfigTable.$inferSelect,
  buy: typeof microLiveOrderTable.$inferSelect,
): boolean {
  return buy.action === "buy" && buy.microLiveRunId === config.microLiveRunId &&
    config.microLiveEntryAttempted && config.microLiveReservedMicros > 0 &&
    config.microLiveReservedMicros <= config.microLiveRunCapMicros &&
    buy.reservedEntryFeeMicros !== null && buy.reservedExitFeeMicros !== null &&
    Number.isSafeInteger(buy.reservedEntryFeeMicros) &&
    Number.isSafeInteger(buy.reservedExitFeeMicros) &&
    buy.requestedStakeCents * 10_000 + buy.reservedEntryFeeMicros +
      buy.reservedExitFeeMicros === config.microLiveReservedMicros &&
    Boolean(buy.feeEvidenceFingerprint && config.microLiveRunApprovalId &&
      config.microLiveRunApprovalDigest &&
      feeEvidenceMatchesApproval(buy.feeEvidenceFingerprint, {
        id: config.microLiveRunApprovalId,
        digest: config.microLiveRunApprovalDigest,
      }));
}

function orderFeeProofMatches(
  order: typeof microLiveOrderTable.$inferSelect | undefined,
  expected: {
    runId: string | null;
    entryFeeMicros: number | null;
    exitFeeMicros: number | null;
    fingerprint: string | null;
    verifiedAt: number | null;
  },
): boolean {
  return Boolean(order && expected.runId && expected.runId.trim() &&
    Number.isSafeInteger(expected.entryFeeMicros) && expected.entryFeeMicros! >= 0 &&
    Number.isSafeInteger(expected.exitFeeMicros) && expected.exitFeeMicros! >= 0 &&
    expected.fingerprint?.trim() && Number.isSafeInteger(expected.verifiedAt) &&
    expected.verifiedAt! >= 0 &&
    order.microLiveRunId === expected.runId &&
    order.reservedEntryFeeMicros === expected.entryFeeMicros &&
    order.reservedExitFeeMicros === expected.exitFeeMicros &&
    order.feeEvidenceFingerprint === expected.fingerprint &&
    order.feeEvidenceVerifiedAt?.getTime() === expected.verifiedAt);
}

function activeOrder(row: { status: string; filledContracts?: number }) {
  return ["pending", "unknown", "partial"].includes(row.status) ||
    (row.status === "filled" && (row.filledContracts ?? 0) > 0) ||
    (row.status === "canceled" && (row.filledContracts ?? 0) > 0);
}

function decision(
  evaluationId: string | null,
  reason: string,
  status: MicroLiveDecision["status"] = "blocked",
  now = new Date(),
): MicroLiveDecision {
  return { evaluationId, status, reason, decidedAt: now.toISOString() };
}

async function currentLease(now: Date) {
  const [engine] = await db.select({
    enabled: forwardTestEngineTable.enabled,
    strategyVersion: forwardTestEngineTable.strategyVersion,
    leaseOwner: forwardTestEngineTable.leaseOwner,
    leaseExpiresAt: forwardTestEngineTable.leaseExpiresAt,
  }).from(forwardTestEngineTable).where(eq(forwardTestEngineTable.id, FORWARD_TEST_ENGINE_ID)).limit(1);
  const held = Boolean(engine?.enabled && engine.strategyVersion === "V1.3" &&
    engine.leaseOwner && engine.leaseExpiresAt && engine.leaseExpiresAt.getTime() > now.getTime());
  return {
    held,
    owner: engine?.leaseOwner ?? null,
    expiresAt: engine?.leaseExpiresAt?.toISOString() ?? null,
  };
}

/** Disposable-schema fixture only: simulate a worker observing its own seeded lease. */
export async function observeMicroLiveWorkerLeaseForIsolatedTest(): Promise<void> {
  const schema = process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ??
    process.env.SHADOW_TEST_ISOLATED_SCHEMA ?? "";
  if (process.env.NODE_ENV !== "development" ||
      !/^(?:micro_live_test|shadow_test)_[a-f0-9]{24}$/.test(schema)) {
    throw new Error("isolated_micro_live_lease_test_only");
  }
  const observedAt = new Date();
  const lease = await currentLease(observedAt);
  if (!lease.held || !lease.owner || !lease.expiresAt ||
      lease.owner !== localWorkerLeaseOwner) {
    throw new Error("isolated_worker_lease_identity_mismatch");
  }
  boundedWorkerLeaseEvidence = {
    owner: lease.owner, expiresAt: Date.parse(lease.expiresAt),
    observedAt: observedAt.getTime(),
  };
}

function workerLeaseIsLocalAndCurrent(lease: Awaited<ReturnType<typeof currentLease>>, now: Date) {
  return Boolean(lease.held && lease.owner && boundedWorkerLeaseEvidence &&
    boundedWorkerLeaseEvidence.owner === lease.owner &&
    boundedWorkerLeaseEvidence.expiresAt > now.getTime() &&
    now.getTime() - boundedWorkerLeaseEvidence.observedAt <= FRESHNESS_MS);
}

async function freezeBoundedRun(runId: string, reason: string) {
  await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config || config.microLiveRunId !== runId || !isPrimaryRun(config) ||
        config.microLiveRunPhase === "FROZEN" &&
          config.microLiveRunFreezeReason === "emergency_stop") return;
    await tx.update(microLiveConfigTable).set({
      microLiveRunPhase: "FROZEN",
      microLiveRunFreezeReason: reason.slice(0, 256),
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
      manualKillSwitch: true,
    }).where(eq(microLiveConfigTable.id, "singleton"));
  });
  invalidateMicroLiveReadiness(reason);
}

async function freezeDedicatedPairRunForRestart(runId: string) {
  await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config || config.microLiveRunId !== runId ||
        !isDedicatedShardTwoRun(config) ||
        !["ENTRY_OPEN", "EXIT_ONLY", "PREPARING"].includes(config.microLiveRunPhase ?? "")) return;
    await tx.update(microLiveConfigTable).set({
      microLiveRunPhase: "FROZEN",
      microLiveRunFreezeReason: "process_restart_requires_explicit_exit_resume",
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
      manualKillSwitch: true,
    }).where(eq(microLiveConfigTable.id, "singleton"));
  });
  invalidateMicroLiveReadiness("process_restart_requires_explicit_exit_resume");
}

function pristineUnusedEntryRunMatches(
  config: typeof microLiveConfigTable.$inferSelect | null | undefined,
  runId: string,
): boolean {
  return Boolean(config && config.microLiveRunId === runId &&
    config.microLiveRunPhase === "ENTRY_OPEN" &&
    config.microLiveRunCapMicros === LIVE_TEST_CAP_MICROS &&
    config.microLiveRunArmedAt && !config.microLiveRunFreezeReason &&
    !config.microLiveEntryAttempted && !config.microLiveExitAttempted &&
    config.microLiveReservedMicros === 0 && !config.microLiveAccountingUnresolved &&
    config.microLiveAccountMode === "primary_nonexclusive" &&
    config.microLiveSelectedSubaccount === 0 &&
    config.microLiveProductionEnabled && config.liveExecutionEnabled &&
    !config.manualKillSwitch && config.microLiveRunApprovalId &&
    config.microLiveRunApprovalDigest &&
    config.microLiveFeeApprovalId === config.microLiveRunApprovalId &&
    config.microLiveFeeApprovalDigest === config.microLiveRunApprovalDigest &&
    config.microLiveFeeApprovalApproved && !config.microLiveFeeApprovalInvalidated &&
    config.microLiveFeeArtifactStatus === "verified" &&
    config.microLiveFeeApprovalSourceUrl === CANONICAL_FEE_SCHEDULE_URL &&
    config.microLiveFeeFormulaVersion === STANDARD_QUADRATIC_FEE_FORMULA_VERSION &&
    config.microLiveFeeApprovedBy?.trim() &&
    config.microLiveFeeApprovedRunCapMicros === LIVE_TEST_CAP_MICROS);
}

async function recoverPristineBoundedRunAfterRestart(
  runId: string,
  source: typeof forwardTestEvaluationTable.$inferSelect,
  dependencies: MicroLiveDependencies,
): Promise<boolean> {
  const failClosed = async (reason: string): Promise<false> => {
    boundedRunRestartRecoveryId = null;
    boundedRunOperationId = null;
    const freezeReason = `process_restart_requires_explicit_exit_resume:${reason}`;
    startupReadiness = { ready: false, checkedAt: 0, reason: freezeReason };
    try { await freezeBoundedRun(runId, freezeReason); } catch { /* remain blocked */ }
    try {
      await reconcileMicroLiveAtStartup({
        ...dependencies, frozenExitReconciliation: true,
      });
    } catch { /* no recovery evidence means the run remains frozen */ }
    return false;
  };
  try {
    const now = dependencies.now?.() ?? new Date();
    const [config] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    const flags = environmentFlags();
    const binding = configuredMicroLiveAccountBinding();
    if (!pristineUnusedEntryRunMatches(config, runId) ||
        !flags.microLiveProductionEnabled || !flags.liveExecutionEnabled ||
        !binding || binding.mode !== "primary_nonexclusive" || binding.subaccount !== 0 ||
        !accountBindingMatchesConfig(config!, binding) ||
        dependencies.approvedFeeSessionForTest || dependencies.readEntryFeeTerms ||
        source.evaluationSource !== "paper" || source.feedFreshness !== "current" ||
        now.getTime() - source.evaluatedAt.getTime() < 0 ||
        now.getTime() - source.evaluatedAt.getTime() > FRESHNESS_MS ||
        source.evaluatedAt.getTime() <= config!.microLiveRunArmedAt!.getTime()) {
      return await failClosed("pristine_run_or_current_signal_invalid");
    }

    const [orders] = await db.select().from(microLiveOrderTable).limit(1);
    const [fills] = await db.select().from(microLiveFillTable).limit(1);
    const [settlements] = await db.select().from(microLiveSettlementTable).limit(1);
    if (orders || fills || settlements ||
        !await currentRunCapMatchesAudit(config!)) {
      return await failClosed("local_run_ledger_or_cap_audit_not_pristine");
    }

    const lease = await currentLease(now);
    if (!workerLeaseIsLocalAndCurrent(lease, now)) {
      return await failClosed("restart_worker_lease_not_owned");
    }
    const originalLeaseOwner = lease.owner;
    const persistedApproval = feeApprovalFromConfig(config);
    const approval = await approvedFeeSession();
    if (!approval || !persistedApproval ||
        !feeApprovalAllowsRun(approval, LIVE_TEST_CAP_MICROS) ||
        !sameFeeApproval(approval, persistedApproval) ||
        approval.id !== config!.microLiveRunApprovalId ||
        approval.digest !== config!.microLiveRunApprovalDigest ||
        approval.sourceUrl !== CANONICAL_FEE_SCHEDULE_URL ||
        approval.formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION ||
        config!.microLiveFeeApprovalSourceUrl !== CANONICAL_FEE_SCHEDULE_URL ||
        config!.microLiveFeeFormulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION ||
        config!.microLiveFeeApprovedBy !== approval.approvedBy) {
      return await failClosed("official_fee_approval_missing_or_changed");
    }

    boundedRunRestartRecoveryId = runId;
    startupReadiness = {
      ready: false, checkedAt: 0, reason: "pristine_entry_restart_recovery_in_progress",
    };
    const reconciled = await reconcileMicroLiveAtStartup(dependencies);
    if (!reconciled.ready) return await failClosed(reconciled.reason);
    // Keep POST readiness suppressed until every restart-specific final check
    // and its durable audit record have committed.
    startupReadiness = {
      ready: false, checkedAt: 0, reason: "pristine_entry_restart_recovery_in_progress",
    };

    const [latestConfig] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    const [latestOrder] = await db.select().from(microLiveOrderTable).limit(1);
    const [latestFill] = await db.select().from(microLiveFillTable).limit(1);
    const [latestSettlement] = await db.select().from(microLiveSettlementTable).limit(1);
    const latestFlags = environmentFlags();
    const latestNow = dependencies.now?.() ?? new Date();
    const latestLease = await currentLease(latestNow);
    const latestApproval = await approvedFeeSession();
    if (!pristineUnusedEntryRunMatches(latestConfig, runId) ||
        !latestFlags.microLiveProductionEnabled || !latestFlags.liveExecutionEnabled ||
        !accountBindingMatchesConfig(latestConfig!, binding) ||
        latestOrder || latestFill || latestSettlement ||
        !latestApproval || !feeApprovalAllowsRun(latestApproval, LIVE_TEST_CAP_MICROS) ||
        !sameFeeApproval(latestApproval, approval) ||
        latestApproval.id !== latestConfig!.microLiveRunApprovalId ||
        latestApproval.digest !== latestConfig!.microLiveRunApprovalDigest ||
        latestApproval.sourceUrl !== approval.sourceUrl ||
        latestApproval.formulaVersion !== approval.formulaVersion ||
        !workerLeaseIsLocalAndCurrent(latestLease, latestNow) ||
        latestLease.owner !== originalLeaseOwner) {
      return await failClosed("restart_final_identity_or_gate_changed");
    }

    const feeTerms = await readCurrentEntryFeeTerms(
      source.marketTicker, globalThis.fetch, latestApproval,
    );
    const feeVerifiedAt = dependencies.now?.() ?? new Date();
    if (!feeTerms || feeTerms.ticker !== source.marketTicker ||
        !feeEvidenceMatchesApproval(feeTerms.fingerprint, latestApproval) ||
        !Number.isFinite(feeTerms.verifiedAt) ||
        feeVerifiedAt.getTime() - feeTerms.verifiedAt < 0 ||
        feeVerifiedAt.getTime() - feeTerms.verifiedAt > FRESHNESS_MS ||
        !feeTerms.maximumExitCashDebitPerContractMicros) {
      return await failClosed("current_market_fee_evidence_missing_or_stale");
    }
    const finalApproval = await approvedFeeSession();
    const finalNow = dependencies.now?.() ?? new Date();
    const finalLease = await currentLease(finalNow);
    if (!finalApproval || !sameFeeApproval(finalApproval, latestApproval) ||
        finalApproval.sourceUrl !== CANONICAL_FEE_SCHEDULE_URL ||
        finalApproval.formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION ||
        !workerLeaseIsLocalAndCurrent(finalLease, finalNow) ||
        finalLease.owner !== originalLeaseOwner ||
        source.feedFreshness !== "current" ||
        finalNow.getTime() - source.evaluatedAt.getTime() < 0 ||
        finalNow.getTime() - source.evaluatedAt.getTime() > FRESHNESS_MS ||
        finalNow.getTime() - feeTerms.verifiedAt < 0 ||
        finalNow.getTime() - feeTerms.verifiedAt > FRESHNESS_MS) {
      return await failClosed("restart_final_approval_lease_or_fee_evidence_stale");
    }

    const auditReason = JSON.stringify({
      type: "pristine_unused_entry_restart_reconciled",
      runId,
      paperEvaluationId: source.id,
      marketTicker: source.marketTicker,
      leaseOwner: latestLease.owner,
      feeEvidenceFingerprint: feeTerms.fingerprint,
      feeEvidenceVerifiedAt: new Date(feeTerms.verifiedAt).toISOString(),
      approvalId: latestApproval.id,
      approvalDigest: latestApproval.digest,
      approvalSourceUrl: latestApproval.sourceUrl,
      approvalFormulaVersion: latestApproval.formulaVersion,
      approvalApprover: latestApproval.approvedBy,
    });
    const committed = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const lockedFlags = environmentFlags();
      if (!pristineUnusedEntryRunMatches(locked, runId) ||
          !lockedFlags.microLiveProductionEnabled || !lockedFlags.liveExecutionEnabled ||
          !accountBindingMatchesConfig(locked!, binding) ||
          locked!.microLiveRunApprovalId !== finalApproval.id ||
          locked!.microLiveRunApprovalDigest !== finalApproval.digest ||
          locked!.microLiveFeeApprovalId !== finalApproval.id ||
          locked!.microLiveFeeApprovalDigest !== finalApproval.digest ||
          locked!.microLiveFeeApprovalSourceUrl !== finalApproval.sourceUrl ||
          locked!.microLiveFeeFormulaVersion !== finalApproval.formulaVersion ||
          locked!.microLiveFeeApprovedBy !== finalApproval.approvedBy) return false;
      await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
        ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
      const [order] = await tx.select({ id: microLiveOrderTable.id })
        .from(microLiveOrderTable).limit(1);
      const [fill] = await tx.select({ id: microLiveFillTable.id })
        .from(microLiveFillTable).limit(1);
      const [settlement] = await tx.select({ id: microLiveSettlementTable.positionId })
        .from(microLiveSettlementTable).limit(1);
      if (order || fill || settlement ||
          !runCapMatchesAudit(locked!,
            await tx.select({
              priorRunId: microLiveRunArchiveTable.priorRunId,
              successorRunId: microLiveRunArchiveTable.successorRunId,
            }).from(microLiveRunArchiveTable))) return false;
      await tx.insert(microLiveDecisionTable).values({
        id: randomUUID(), status: "BLOCK", reason: auditReason,
        evaluationId: source.id, decidedAt: finalNow,
      });
      return true;
    });
    if (!committed) return await failClosed("restart_audit_final_barrier_failed");

    boundedRunOperationId = runId;
    startupReadiness = {
      ready: true, checkedAt: (dependencies.now?.() ?? new Date()).getTime(), reason: null,
    };
    boundedRunRestartRecoveryId = null;
    return true;
  } catch {
    return await failClosed("restart_reconciliation_or_audit_failed");
  } finally {
    if (boundedRunRestartRecoveryId === runId) boundedRunRestartRecoveryId = null;
  }
}

export async function prepareNextBoundedMicroLiveRun(input: {
  actorId: string;
  priorRunId: string;
  reason: string;
}): Promise<{ status: "prepared" | "blocked"; reason: string }> {
  const blocked = (reason: string) => ({ status: "blocked" as const, reason });
  if (process.env.NODE_ENV !== "development") {
    return blocked("micro_live_development_only");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.actorId) ||
      !/^[0-9a-f-]{36}$/i.test(input.priorRunId) ||
      input.reason.trim().length < 16 || input.reason.trim().length > 512) {
    return blocked("bounded_run_transition_invalid_request");
  }
  const binding = configuredMicroLiveAccountBinding();
  if (!binding ||
      !((binding.mode === "primary_nonexclusive" && binding.subaccount === 0) ||
        (binding.mode === "exclusive" && binding.subaccount >= 1))) {
    return blocked("account_mode_or_subaccount_unverified");
  }
  const successorRunId = randomUUID();
  const now = new Date();
  try {
    const result = await db.transaction(async (tx) => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      if (!config) return blocked("micro_live_configuration_absent");
      const [archived] = await tx.select().from(microLiveRunArchiveTable)
        .where(eq(microLiveRunArchiveTable.priorRunId, input.priorRunId)).limit(1);
      if (archived) {
        return archived.actorId === input.actorId &&
            archived.transitionReason === input.reason.trim() &&
            config.microLiveRunId === archived.successorRunId &&
            config.microLiveRunPhase === "UNARMED" &&
            config.microLiveRunCapMicros === PREPARED_BOUNDED_RUN_CAP_MICROS
          ? {
            status: "prepared" as const,
            reason: "bounded_run_next_slot_already_prepared",
          }
          : blocked("bounded_run_prior_already_archived");
      }
      const [order] = await tx.select({ id: microLiveOrderTable.id })
        .from(microLiveOrderTable).limit(1);
      const [fill] = await tx.select({ id: microLiveFillTable.id })
        .from(microLiveFillTable).limit(1);
      const [settlement] = await tx.select({ id: microLiveSettlementTable.positionId })
        .from(microLiveSettlementTable).limit(1);
      // The original policy must already be revoked before its $1 cap can
      // be replaced by a new $5 slot. Its immutable identity remains on the
      // row for the append-only archive; a revoked policy cannot authorize
      // any new order.
      if (config.microLiveFeeApprovalApproved ||
          !config.microLiveFeeApprovalInvalidated ||
          !config.microLiveFeeApprovalApprovedAt ||
          config.microLiveFeePolicyVersion !== MICRO_LIVE_STANDING_FEE_POLICY_VERSION ||
           config.microLiveFeeMaximumExposureMicros === null ||
           config.microLiveFeeMaximumExposureMicros === undefined ||
          config.microLiveFeeApprovedRunCapMicros !== config.microLiveRunCapMicros ||
          config.microLiveFeeMaximumExposureMicros < config.microLiveRunCapMicros ||
          config.microLiveFeeApprovalId !== config.microLiveRunApprovalId ||
          config.microLiveFeeApprovalDigest !== config.microLiveRunApprovalDigest ||
          !/^[a-f0-9]{64}$/.test(config.microLiveFeeApprovalDigest ?? "") ||
          config.microLiveFeeApprovalSourceUrl !== CANONICAL_FEE_SCHEDULE_URL ||
          config.microLiveFeeFormulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION ||
          !config.microLiveFeeApprovedBy?.trim()) {
        return blocked("bounded_run_original_fee_approval_metadata_missing");
      }
      const reason = frozenUnusedRunBlockReason({
        phase: config.microLiveRunPhase,
        runId: config.microLiveRunId,
        requestedPriorRunId: input.priorRunId,
        freezeReason: config.microLiveRunFreezeReason,
        armedAt: config.microLiveRunArmedAt,
        approvalId: config.microLiveRunApprovalId,
        approvalDigest: config.microLiveRunApprovalDigest,
        capMicros: config.microLiveRunCapMicros,
        reservedMicros: config.microLiveReservedMicros,
        entryAttempted: config.microLiveEntryAttempted,
        exitAttempted: config.microLiveExitAttempted,
        accountMode: config.microLiveAccountMode,
        selectedSubaccount: config.microLiveSelectedSubaccount,
        selectedExchangeIndex: config.microLiveSelectedExchangeIndex,
        restrictedApiKeyId: config.microLiveRestrictedApiKeyId,
        restrictedKeyFingerprint: config.microLiveRestrictedKeyFingerprint,
        fundingAnchor: {
          subaccountNumber: config.microLiveFundingAnchorSubaccount,
          exchangeIndex: config.microLiveFundingAnchorExchangeIndex,
          transferId: config.microLiveFundingAnchorTransferId,
          transferAt: config.microLiveFundingAnchorTransferAt,
          amountCents: config.microLiveFundingAnchorAmountCents,
        },
        pairCashBaseline: {
          subaccountNumber: config.microLiveSelectedSubaccount,
          exchangeIndex: config.microLiveSelectedExchangeIndex,
          runId: config.microLivePairCashBaselineRunId,
          availableCashMicros: config.microLivePairCashBaselineMicros,
          capturedAt: config.microLivePairCashBaselineAt,
          evidenceDigest: config.microLivePairCashBaselineEvidenceDigest,
        },
        activityCheckpoint: {
          subaccountNumber: config.microLiveAccountActivityCheckpointSubaccount,
          exchangeIndex: config.microLiveAccountActivityCheckpointExchangeIndex,
          runId: config.microLiveAccountActivityCheckpointRunId,
          cursor: config.microLiveAccountActivityCheckpointCursor,
          capturedAt: config.microLiveAccountActivityCheckpointAt,
          evidenceDigest: config.microLiveAccountActivityCheckpointEvidenceDigest,
        },
        accountingUnresolved: config.microLiveAccountingUnresolved,
        databaseMicroLiveEnabled: config.microLiveProductionEnabled,
        databaseExecutionEnabled: config.liveExecutionEnabled,
        killSwitchOn: config.manualKillSwitch,
        bindingMatches: accountBindingMatchesConfig(config, binding),
        orderCount: order ? 1 : 0,
        fillCount: fill ? 1 : 0,
        settlementCount: settlement ? 1 : 0,
      });
      if (reason) return blocked(reason);
      const [idCollision] = await tx.select({ priorRunId: microLiveRunArchiveTable.priorRunId })
        .from(microLiveRunArchiveTable)
        .where(eq(microLiveRunArchiveTable.priorRunId, successorRunId)).limit(1);
      if (idCollision) return blocked("bounded_run_successor_id_conflict");
      await tx.insert(microLiveRunArchiveTable).values({
        priorRunId: input.priorRunId,
        successorRunId,
        phase: config.microLiveRunPhase,
        armedAt: config.microLiveRunArmedAt!,
        // Retain only a legacy deadline if one exists; omitted means unbounded.
        ...(config.microLiveRunDeadline
          ? { deadlineAt: config.microLiveRunDeadline } : {}),
        approvalId: config.microLiveRunApprovalId!,
        approvalDigest: config.microLiveRunApprovalDigest!,
        approvalSourceUrl: config.microLiveFeeApprovalSourceUrl!,
        approvalFormulaVersion: config.microLiveFeeFormulaVersion!,
        approvalApprover: config.microLiveFeeApprovedBy!,
        freezeReason: config.microLiveRunFreezeReason!,
        capMicros: config.microLiveRunCapMicros,
        reservedMicros: config.microLiveReservedMicros,
        entryAttempted: config.microLiveEntryAttempted,
        exitAttempted: config.microLiveExitAttempted,
        accountMode: config.microLiveAccountMode!,
        selectedSubaccount: config.microLiveSelectedSubaccount!,
        selectedExchangeIndex: config.microLiveSelectedExchangeIndex,
        restrictedApiKeyId: config.microLiveRestrictedApiKeyId,
        restrictedKeyFingerprint: config.microLiveRestrictedKeyFingerprint,
        fundingAnchorSubaccount: config.microLiveFundingAnchorSubaccount,
        fundingAnchorExchangeIndex: config.microLiveFundingAnchorExchangeIndex,
        fundingAnchorTransferId: config.microLiveFundingAnchorTransferId,
        fundingAnchorTransferAt: config.microLiveFundingAnchorTransferAt,
        fundingAnchorAmountCents: config.microLiveFundingAnchorAmountCents,
        pairCashBaselineMicros: config.microLivePairCashBaselineMicros,
        pairCashBaselineRunId: config.microLivePairCashBaselineRunId,
        pairCashBaselineAt: config.microLivePairCashBaselineAt,
        pairCashBaselineEvidenceDigest: config.microLivePairCashBaselineEvidenceDigest,
        accountActivityCheckpointSubaccount:
          config.microLiveAccountActivityCheckpointSubaccount,
        accountActivityCheckpointExchangeIndex:
          config.microLiveAccountActivityCheckpointExchangeIndex,
        accountActivityCheckpointRunId:
          config.microLiveAccountActivityCheckpointRunId,
        accountActivityCheckpointCursor:
          config.microLiveAccountActivityCheckpointCursor,
        accountActivityCheckpointAt:
          config.microLiveAccountActivityCheckpointAt,
        accountActivityCheckpointEvidenceDigest:
          config.microLiveAccountActivityCheckpointEvidenceDigest,
        maxLiveBankrollCents: config.maxLiveBankrollCents,
        maxSingleOrderRiskCents: config.maxSingleOrderRiskCents,
        maxCumulativeReservedCents: config.maxCumulativeReservedCents,
        maxScoutStakeCents: config.maxScoutStakeCents,
        maxConfirmAdditionalStakeCents: config.maxConfirmAdditionalStakeCents,
        actorId: input.actorId,
        transitionReason: input.reason.trim(),
        archivedAt: now,
      });
      await tx.update(microLiveConfigTable).set({
        microLiveRunId: successorRunId,
        microLiveRunPhase: "UNARMED",
        // A new, independently reviewed run must establish its own cash anchor.
        // The prior run's baseline must never silently authorize a successor.
        microLivePrimaryCashBaselineMicros: null,
        microLivePrimaryCashBaselineRunId: null,
        microLivePrimaryCashBaselineAt: null,
        microLivePrimaryCashBaselineEvidenceDigest: null,
        microLivePrimaryActivityCheckpointRunId: null,
        microLivePrimaryActivityCheckpointCursor: null,
        microLivePrimaryActivityCheckpointAt: null,
        microLivePrimaryActivityCheckpointEvidenceDigest: null,
        // Pair-specific funding is run-bound and must be independently
        // re-established for a successor; only the immutable (N, 2) key
        // identity remains attached to the account binding.
        microLiveFundingAnchorSubaccount: null,
        microLiveFundingAnchorExchangeIndex: null,
        microLiveFundingAnchorTransferId: null,
        microLiveFundingAnchorTransferAt: null,
        microLiveFundingAnchorAmountCents: null,
        microLivePairCashBaselineMicros: null,
        microLivePairCashBaselineRunId: null,
        microLivePairCashBaselineAt: null,
        microLivePairCashBaselineEvidenceDigest: null,
        microLiveAccountActivityCheckpointSubaccount: null,
        microLiveAccountActivityCheckpointExchangeIndex: null,
        microLiveAccountActivityCheckpointRunId: null,
        microLiveAccountActivityCheckpointCursor: null,
        microLiveAccountActivityCheckpointAt: null,
        microLiveAccountActivityCheckpointEvidenceDigest: null,
        microLiveRunArmedAt: null,
        microLiveRunDeadline: null,
        microLiveRunApprovalId: null,
        microLiveRunApprovalDigest: null,
        microLiveRunFreezeReason: null,
        microLiveRunCapMicros: PREPARED_BOUNDED_RUN_CAP_MICROS,
        maxLiveBankrollCents: 500,
        maxSingleOrderRiskCents: 500,
        maxCumulativeReservedCents: 500,
        maxScoutStakeCents: 500,
        maxConfirmAdditionalStakeCents: 500,
      }).where(eq(microLiveConfigTable.id, "singleton"));
      return { status: "prepared" as const, reason: "bounded_run_next_slot_prepared" };
    });
    if (result.status === "prepared") {
      boundedRunOperationId = null;
      invalidateMicroLiveReadiness("new_bounded_run_requires_explicit_arming_reconciliation");
    }
    return result;
  } catch {
    return blocked("bounded_run_transition_failed");
  }
}

export async function armBoundedMicroLiveRun(
  dependencies: MicroLiveDependencies = {},
): Promise<BoundedRunResult> {
  const blocked = (reason: string): BoundedRunResult => ({ status: "blocked", reason });
  if (process.env.NODE_ENV !== "development") return blocked("micro_live_development_only");
  const flags = environmentFlags();
  if (!flags.microLiveProductionEnabled || !flags.liveExecutionEnabled) {
    return blocked("environment_flags_not_both_true");
  }
  const now = dependencies.now?.() ?? new Date();
  const approval = await currentApprovedFeeSession(dependencies);
  if (!feeApprovalAllowsRun(approval, LIVE_TEST_CAP_MICROS, dependencies)) {
    return blocked("standing_fee_policy_unavailable_or_incompatible");
  }
  const binding = configuredMicroLiveAccountBinding();
  if (!binding) return blocked("account_mode_or_subaccount_unverified");
  const [boundConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const dedicatedPairRun = Boolean(boundConfig && isDedicatedShardTwoRun(boundConfig));
  let dedicatedPairArmProof: MicroLivePairCollateralProof | null = null;
  if (boundConfig && dedicatedPairRun) {
    if (!dedicatedShardTwoCashAnchorMatchesConfig(boundConfig)) {
      return blocked("dedicated_pair_funding_anchor_or_cash_baseline_incomplete");
    }
    if (boundConfig.microLiveAccountActivityCheckpointRunId !== boundConfig.microLiveRunId ||
        boundConfig.microLiveAccountActivityCheckpointSubaccount !==
          boundConfig.microLiveSelectedSubaccount ||
        boundConfig.microLiveAccountActivityCheckpointExchangeIndex !==
          DEDICATED_EXCHANGE_INDEX ||
        !boundConfig.microLiveAccountActivityCheckpointCursor?.trim() ||
        !boundConfig.microLiveAccountActivityCheckpointAt ||
        !/^[0-9a-f]{64}$/.test(
          boundConfig.microLiveAccountActivityCheckpointEvidenceDigest ?? "",
        )) {
      return blocked("dedicated_pair_activity_checkpoint_incomplete");
    }
    const [paperEvaluation] = await db.select()
      .from(forwardTestEvaluationTable)
      .where(eq(forwardTestEvaluationTable.evaluationSource, "paper"))
      .orderBy(desc(forwardTestEvaluationTable.evaluatedAt)).limit(1);
    if (!paperEvaluation?.marketTicker) {
      return blocked("dedicated_pair_startup_market_identity_unavailable");
    }
    dedicatedPairArmProof = await readDedicatedPairCollateralProof(
      boundConfig, paperEvaluation.marketTicker, { kind: "preentry" }, dependencies,
    );
    if (dedicatedPairArmProof.status !== "verified" ||
        dedicatedPairArmProof.mode?.kind !== "preentry" ||
        dedicatedPairArmProof.runId !== boundConfig.microLiveRunId ||
        !/^[0-9a-f]{64}$/.test(dedicatedPairArmProof.evidenceDigest ?? "") ||
        (dependencies.now?.() ?? new Date()).getTime() - dedicatedPairArmProof.checkedAt < 0 ||
        (dependencies.now?.() ?? new Date()).getTime() - dedicatedPairArmProof.checkedAt > 5_000) {
      return blocked(dedicatedPairArmProof.reason ??
        "dedicated_pair_preentry_collateral_proof_unavailable");
    }
  }
  const lease = await currentLease(now);
  if (!workerLeaseIsLocalAndCurrent(lease, now)) {
    return blocked("v13_worker_lease_not_owned_by_this_process");
  }

  let runId: string = randomUUID();
  try {
    const prepared = await db.transaction(async (tx) => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      if (!config) return "micro_live_configuration_absent";
      if (!knownBoundedRunPhase(config.microLiveRunPhase) ||
          config.microLiveRunPhase !== "UNARMED") return "bounded_run_state_not_pristine";
      const dedicatedPairRun = isDedicatedShardTwoRun(config);
      if (!isPrimaryRun(config) && !dedicatedPairRun) {
        return "bounded_run_requires_primary_or_verified_dedicated_pair_mode";
      }
      if (!accountBindingMatchesConfig(config, binding)) return "account_mode_or_subaccount_changed";
      if (dedicatedPairRun) {
        if (!dedicatedShardTwoCashAnchorMatchesConfig(config)) {
          return "dedicated_pair_funding_anchor_or_cash_baseline_incomplete";
        }
        if (config.microLiveAccountActivityCheckpointRunId !== config.microLiveRunId ||
            config.microLiveAccountActivityCheckpointSubaccount !==
              config.microLiveSelectedSubaccount ||
            config.microLiveAccountActivityCheckpointExchangeIndex !==
              DEDICATED_EXCHANGE_INDEX ||
            !config.microLiveAccountActivityCheckpointCursor?.trim() ||
            !config.microLiveAccountActivityCheckpointAt ||
            !/^[0-9a-f]{64}$/.test(
              config.microLiveAccountActivityCheckpointEvidenceDigest ?? "",
            )) {
          return "dedicated_pair_activity_checkpoint_incomplete";
        }
        if (!dedicatedPairArmProof ||
            dedicatedPairArmProof.status !== "verified" ||
            dedicatedPairArmProof.mode?.kind !== "preentry" ||
            dedicatedPairArmProof.runId !== config.microLiveRunId ||
            dedicatedPairBoundaryIdentityFingerprint(config) !==
              dedicatedPairBoundaryIdentityFingerprint(boundConfig!) ||
            (dependencies.now?.() ?? new Date()).getTime() -
              dedicatedPairArmProof.checkedAt < 0 ||
            (dependencies.now?.() ?? new Date()).getTime() -
              dedicatedPairArmProof.checkedAt > 5_000) {
          return "dedicated_pair_preentry_collateral_proof_stale_or_changed";
        }
      }
      if (config.microLiveProductionEnabled || config.liveExecutionEnabled ||
          !config.manualKillSwitch) return "arming_requires_frozen_database_gates";
      if (config.microLiveEntryAttempted || config.microLiveExitAttempted ||
          config.microLiveReservedMicros !== 0) {
        return "bounded_run_already_attempted_or_reserved";
      }
      const archivedRuns = await tx.select({
        priorRunId: microLiveRunArchiveTable.priorRunId,
        successorRunId: microLiveRunArchiveTable.successorRunId,
      }).from(microLiveRunArchiveTable);
      if (config.microLiveRunId !== null) {
        if (dedicatedPairRun) {
          const [boundary] = await tx.select().from(microLivePairBoundaryTable)
            .where(eq(
              microLivePairBoundaryTable.subaccountNumber,
              config.microLiveSelectedSubaccount!,
            )).for("update").limit(1);
          if (!dedicatedPairInitializedRunMatchesAudit(config, boundary, archivedRuns)) {
            return "bounded_run_preparation_audit_missing";
          }
        } else if (config.microLiveRunCapMicros !== PREPARED_BOUNDED_RUN_CAP_MICROS ||
            !runCapMatchesAudit(config, archivedRuns)) {
          return "bounded_run_preparation_audit_missing";
        }
        // Isolated mocks cover local exit and recovery logic, not real
        // reduce-only IOC behavior or operational handling of partial exits.
        // Keep the separately prepared slot unavailable to the live arming
        // path until that evidence has been independently accepted.
        const isolatedFixture = dependencies.isolatedTestFeeCapFixture === true &&
          dependencies.submitOrder !== undefined &&
          /^micro_live_test_[a-f0-9]{24}$/.test(
            process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "",
          );
        if (!isolatedFixture) return "prepared_run_exit_recovery_proof_required";
        runId = config.microLiveRunId;
      } else {
        if (config.microLiveRunCapMicros !== LIVE_TEST_CAP_MICROS) {
          return "bounded_run_state_not_pristine";
        }
        if (archivedRuns.some((row) =>
          row.priorRunId === runId || row.successorRunId === runId)) {
          return "bounded_run_id_already_archived";
        }
      }
      if (config.microLiveAccountingUnresolved) return "primary_accounting_unresolved";
      const [existingOrder] = await tx.select({ id: microLiveOrderTable.id })
        .from(microLiveOrderTable).limit(1);
      const [existingFill] = await tx.select({ id: microLiveFillTable.id })
        .from(microLiveFillTable).limit(1);
      const [settlement] = await tx.select({ id: microLiveSettlementTable.positionId })
        .from(microLiveSettlementTable).limit(1);
      if (existingOrder || existingFill || settlement) return "preexisting_micro_live_ledger";
      const currentApproval = await feeApprovalAtBarrier(config, dependencies);
      if (!feeApprovalAllowsRun(currentApproval, config.microLiveRunCapMicros, dependencies) ||
          !sameFeeApproval(currentApproval, approval)) {
        return "standing_fee_policy_changed_or_incompatible";
      }
      await tx.update(microLiveConfigTable).set({
        microLiveRunId: runId,
        microLiveRunPhase: dedicatedPairRun ? "ENTRY_OPEN" : "PREPARING",
        microLiveRunArmedAt: now,
        // Null denotes condition-based validity; retain the nullable column
        // only for compatibility with historic archive records.
        microLiveRunDeadline: null,
        microLiveRunApprovalId: approval.id,
        microLiveRunApprovalDigest: approval.digest,
        microLiveRunFreezeReason: null,
        microLiveAccountMode: binding.mode,
        microLiveSelectedSubaccount: binding.subaccount,
        microLiveProductionEnabled: true,
        liveExecutionEnabled: true,
        manualKillSwitch: false,
      }).where(eq(microLiveConfigTable.id, "singleton"));
      return null;
    });
    if (prepared) return blocked(prepared);
    boundedRunOperationId = runId;
    invalidateMicroLiveReadiness("bounded_run_preparing_reconciliation");

    if (dedicatedPairRun) {
      const checkedAt = (dependencies.now?.() ?? new Date()).getTime();
      if (!dedicatedPairArmProof || dedicatedPairArmProof.status !== "verified" ||
          dedicatedPairArmProof.runId !== runId ||
          checkedAt - dedicatedPairArmProof.checkedAt < 0 ||
          checkedAt - dedicatedPairArmProof.checkedAt > 5_000) {
        await freezeBoundedRun(runId, "dedicated_pair_preentry_proof_expired");
        return blocked("dedicated_pair_preentry_proof_expired");
      }
      startupReadiness = {
        ready: true, checkedAt: dedicatedPairArmProof.checkedAt, reason: null,
      };
    } else {
      const reconciled = await reconcileMicroLiveAtStartup(dependencies);
      if (!reconciled.ready) {
        await freezeBoundedRun(runId, `arming_reconciliation_${reconciled.reason}`);
        return blocked(`arming_reconciliation_${reconciled.reason}`);
      }
    }
    const latestNow = dependencies.now?.() ?? new Date();
    const freshApproval = await currentApprovedFeeSession(dependencies);
    const latestLease = await currentLease(latestNow);
    if (!feeApprovalAllowsRun(freshApproval, LIVE_TEST_CAP_MICROS, dependencies) ||
        !sameFeeApproval(freshApproval, approval) ||
        !workerLeaseIsLocalAndCurrent(latestLease, latestNow) ||
        latestLease.owner !== lease.owner ||
        !environmentFlags().microLiveProductionEnabled ||
        !environmentFlags().liveExecutionEnabled) {
      await freezeBoundedRun(runId, "arming_evidence_expired_or_changed");
      boundedRunOperationId = null;
      return blocked("arming_evidence_expired_or_changed");
    }
    const opened = await db.transaction(async (tx) => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const checkedAt = dependencies.now?.() ?? new Date();
      if (!config || config.microLiveRunId !== runId ||
          config.microLiveRunPhase !== (dedicatedPairRun ? "ENTRY_OPEN" : "PREPARING") ||
          config.microLiveRunApprovalId !== approval.id ||
          config.microLiveRunApprovalDigest !== approval.digest ||
          config.manualKillSwitch || !config.microLiveProductionEnabled ||
          !config.liveExecutionEnabled || !readinessIsCurrent(checkedAt.getTime()) ||
          dedicatedPairRun &&
            (!dedicatedPairArmProof ||
             checkedAt.getTime() - dedicatedPairArmProof.checkedAt < 0 ||
             checkedAt.getTime() - dedicatedPairArmProof.checkedAt > 5_000 ||
             dedicatedPairBoundaryIdentityFingerprint(config) !==
               dedicatedPairBoundaryIdentityFingerprint(boundConfig!))) return false;
      if (!dedicatedPairRun) {
        await tx.update(microLiveConfigTable).set({
          microLiveRunPhase: "ENTRY_OPEN",
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }
      return true;
    });
    if (!opened) {
      await freezeBoundedRun(runId, "arming_final_barrier_failed");
      boundedRunOperationId = null;
      return blocked("arming_final_barrier_failed");
    }
    return { status: "armed", reason: "bounded_run_entry_window_open" };
  } catch (error) {
    try { await freezeBoundedRun(runId, "arming_failed_frozen"); } catch { /* gates remain fail closed */ }
    boundedRunOperationId = null;
    return blocked(error instanceof Error ? `arming_failed:${error.message}` : "arming_failed");
  }
}

async function resumeDedicatedPairExitOnlyAfterGetRecovery(
  dependencies: MicroLiveDependencies,
  binding: { mode: MicroLiveAccountMode; subaccount: number },
  lease: Awaited<ReturnType<typeof currentLease>>,
): Promise<BoundedRunResult> {
  const blocked = (reason: string): BoundedRunResult => ({ status: "blocked", reason });
  let runId: string | null = null;
  const prepared = await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config || config.microLiveRunPhase !== "FROZEN" ||
        !config.microLiveRunId ||
        !(config.microLiveRunFreezeReason?.startsWith(
          "process_restart_requires_explicit_exit_resume",
        ) || config.microLiveRunFreezeReason === "emergency_stop")) {
      return "dedicated_pair_run_not_exit_resumable_frozen";
    }
    if (!isDedicatedShardTwoRun(config) ||
        config.microLiveAccountMode !== binding.mode ||
        config.microLiveSelectedSubaccount !== binding.subaccount ||
        !accountBindingMatchesConfig(config, binding) ||
        !dedicatedShardTwoIdentityMatchesConfig(config) ||
        config.microLiveAccountingUnresolved) {
      return "dedicated_pair_restart_identity_or_accounting_unproven";
    }
    if (!config.microLiveEntryAttempted || config.microLiveExitAttempted ||
        config.microLiveReservedMicros < 1 ||
        config.microLiveReservedMicros > config.microLiveRunCapMicros ||
        config.microLiveProductionEnabled || config.liveExecutionEnabled ||
        !config.manualKillSwitch) {
      return "dedicated_pair_restart_attempt_or_frozen_state_invalid";
    }
    const archivedRuns = await tx.select({
      priorRunId: microLiveRunArchiveTable.priorRunId,
      successorRunId: microLiveRunArchiveTable.successorRunId,
    }).from(microLiveRunArchiveTable);
    const [boundary] = await tx.select().from(microLivePairBoundaryTable)
      .where(eq(
        microLivePairBoundaryTable.subaccountNumber,
        config.microLiveSelectedSubaccount!,
      )).for("update").limit(1);
    if (!dedicatedPairInitializedRunMatchesAudit(config, boundary, archivedRuns)) {
      return "dedicated_pair_run_cap_or_boundary_audit_mismatch";
    }
    const orders = await tx.select().from(microLiveOrderTable);
    if (orders.some((row) => row.action === "sell") ||
        orders.filter((row) => row.action === "buy" &&
          row.microLiveRunId === config.microLiveRunId).length !== 1) {
      return "dedicated_pair_exit_resume_order_identity_invalid";
    }
    runId = config.microLiveRunId;
    return null;
  });
  if (prepared) return blocked(prepared);
  if (!runId) return blocked("dedicated_pair_restart_run_id_missing");

  invalidateMicroLiveReadiness("dedicated_pair_restart_requires_get_recovery");
  const recovered = await reconcileMicroLiveAtStartup({
    ...dependencies,
    frozenExitReconciliation: true,
    dedicatedPairRecovery: true,
  });
  if (recovered.reason !== "dedicated_pair_activity_recovered_get_only") {
    return blocked(`dedicated_pair_get_recovery_${recovered.reason}`);
  }

  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const orders = await db.select().from(microLiveOrderTable);
  const fills = await db.select().from(microLiveFillTable);
  const settlements = await db.select().from(microLiveSettlementTable);
  if (!config || config.microLiveRunId !== runId ||
      config.microLiveRunPhase !== "FROZEN" ||
      !accountBindingMatchesConfig(config, binding)) {
    return blocked("dedicated_pair_get_recovery_config_changed");
  }
  const buyRows = orders.filter((row) => row.action === "buy" && row.microLiveRunId === runId);
  const buy = buyRows[0];
  const ledger = reconstructMicroLivePositions({ orders, fills, settlements });
  const positions = ledger.positions.filter((position) => !position.closed &&
    (position.contractsBought > position.contractsSold ||
      position.reservedBuyRiskCents > 0 || position.outstandingSellContracts > 0));
  const approvalProof = buy?.feeEvidenceFingerprint && config.microLiveRunApprovalId &&
    config.microLiveRunApprovalDigest
    ? feeEvidenceMatchesApproval(buy.feeEvidenceFingerprint, {
      id: config.microLiveRunApprovalId, digest: config.microLiveRunApprovalDigest,
    }) : false;
  const originalReservation = buy
    ? buy.requestedStakeCents * 10_000 +
      (buy.reservedEntryFeeMicros ?? -1) + (buy.reservedExitFeeMicros ?? -1)
    : -1;
  if (ledger.anomalies.length || buyRows.length !== 1 || !buy ||
      buy.microLiveRunId !== runId ||
      !["filled", "canceled", "closed"].includes(buy.status) ||
      buy.filledContracts <= 0 || buy.remainingContracts !== 0 ||
      positions.length !== 1 || positions[0]!.positionId !==
        (buy.positionId ?? `position:${buy.marketTicker}:${buy.crossingKey}`) ||
      positions[0]!.contractsBought <= positions[0]!.contractsSold ||
      !approvalProof || originalReservation !== config.microLiveReservedMicros ||
      originalReservation > config.microLiveRunCapMicros) {
    return blocked("dedicated_pair_get_recovery_position_or_fee_proof_invalid");
  }
  const proof = await readDedicatedPairCollateralProof(config, buy.marketTicker, {
    kind: "recovery_get",
  }, dependencies);
  const checkedAt = (dependencies.now?.() ?? new Date()).getTime();
  if (proof.status !== "verified" || proof.mode?.kind !== "recovery_get" ||
      proof.runId !== runId || !/^[0-9a-f]{64}$/.test(proof.evidenceDigest ?? "") ||
      checkedAt - proof.checkedAt < 0 || checkedAt - proof.checkedAt > 5_000) {
    return blocked(proof.reason ?? "dedicated_pair_restart_collateral_verification_blocked");
  }
  const configIdentity = dedicatedPairConfigIdentityFingerprint(config);
  const ledgerIdentity = dedicatedPairLedgerFingerprintFrom(orders, fills, settlements);
  const latestLease = await currentLease(dependencies.now?.() ?? new Date());
  if (!workerLeaseIsLocalAndCurrent(latestLease, dependencies.now?.() ?? new Date()) ||
      latestLease.owner !== lease.owner) {
    return blocked("dedicated_pair_exit_resume_worker_lease_changed");
  }
  const resumed = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!locked || locked.microLiveRunId !== runId ||
        locked.microLiveRunPhase !== "FROZEN" ||
         !(locked.microLiveRunFreezeReason?.startsWith(
           "process_restart_requires_explicit_exit_resume",
         ) || locked.microLiveRunFreezeReason === "emergency_stop") ||
        locked.microLiveExitAttempted || locked.manualKillSwitch !== true ||
        locked.microLiveProductionEnabled || locked.liveExecutionEnabled ||
        !accountBindingMatchesConfig(locked, binding) ||
        !dedicatedShardTwoIdentityMatchesConfig(locked) ||
        dedicatedPairConfigIdentityFingerprint(locked) !== configIdentity ||
        checkedAt - proof.checkedAt < 0 || checkedAt - proof.checkedAt > 5_000) {
      return false;
    }
    const [boundary] = await tx.select().from(microLivePairBoundaryTable)
      .where(eq(
        microLivePairBoundaryTable.subaccountNumber,
        locked.microLiveSelectedSubaccount!,
      )).for("update").limit(1);
    const archivedRuns = await tx.select({
      priorRunId: microLiveRunArchiveTable.priorRunId,
      successorRunId: microLiveRunArchiveTable.successorRunId,
    }).from(microLiveRunArchiveTable);
    if (!dedicatedPairInitializedRunMatchesAudit(locked, boundary, archivedRuns)) return false;
    await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
      ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
    const currentOrders = await tx.select().from(microLiveOrderTable);
    const currentFills = await tx.select().from(microLiveFillTable);
    const currentSettlements = await tx.select().from(microLiveSettlementTable);
    if (dedicatedPairLedgerFingerprintFrom(
      currentOrders, currentFills, currentSettlements,
    ) !== ledgerIdentity) return false;
    const currentBuys = currentOrders.filter((row) =>
      row.action === "buy" && row.microLiveRunId === runId);
    const currentBuy = currentBuys[0];
    const currentLedger = reconstructMicroLivePositions({
      orders: currentOrders, fills: currentFills, settlements: currentSettlements,
    });
    const currentPositions = currentLedger.positions.filter((position) => !position.closed &&
      (position.contractsBought > position.contractsSold ||
        position.reservedBuyRiskCents > 0 || position.outstandingSellContracts > 0));
    const currentReservation = currentBuy
      ? currentBuy.requestedStakeCents * 10_000 +
        (currentBuy.reservedEntryFeeMicros ?? -1) +
        (currentBuy.reservedExitFeeMicros ?? -1)
      : -1;
    if (currentLedger.anomalies.length || currentBuys.length !== 1 || !currentBuy ||
        currentOrders.some((row) => row.action === "sell") ||
        !["filled", "canceled", "closed"].includes(currentBuy.status) ||
        currentBuy.filledContracts <= 0 || currentBuy.remainingContracts !== 0 ||
        currentReservation !== locked.microLiveReservedMicros ||
        currentReservation > locked.microLiveRunCapMicros ||
        currentPositions.length !== 1 ||
        currentPositions[0]!.positionId !==
          (currentBuy.positionId ?? `position:${currentBuy.marketTicker}:${currentBuy.crossingKey}`) ||
        !currentBuy.feeEvidenceFingerprint ||
        !locked.microLiveRunApprovalId || !locked.microLiveRunApprovalDigest ||
        !feeEvidenceMatchesApproval(currentBuy.feeEvidenceFingerprint, {
          id: locked.microLiveRunApprovalId, digest: locked.microLiveRunApprovalDigest,
        })) return false;
    await tx.update(microLiveConfigTable).set({
      microLiveRunPhase: "EXIT_ONLY",
      microLiveRunFreezeReason: "explicit_get_recovered_exit_only_resume",
      microLiveProductionEnabled: true,
      liveExecutionEnabled: true,
      manualKillSwitch: false,
    }).where(eq(microLiveConfigTable.id, "singleton"));
    return true;
  });
  if (!resumed) return blocked("dedicated_pair_exit_resume_final_barrier_failed");
  boundedRunOperationId = runId;
  startupReadiness = {
    ready: true, checkedAt: checkedAt, reason: null,
  };
  return { status: "resumed", reason: "dedicated_pair_get_recovered_exit_only_resumed" };
}

export async function resumeBoundedMicroLiveExitOnly(
  dependencies: MicroLiveDependencies = {},
): Promise<BoundedRunResult> {
  const blocked = (reason: string): BoundedRunResult => ({ status: "blocked", reason });
  if (process.env.NODE_ENV !== "development") return blocked("micro_live_development_only");
  const flags = environmentFlags();
  if (!flags.microLiveProductionEnabled || !flags.liveExecutionEnabled) {
    return blocked("environment_flags_not_both_true");
  }
  const now = dependencies.now?.() ?? new Date();
  const binding = configuredMicroLiveAccountBinding();
  if (!binding ||
      !(binding.mode === "primary_nonexclusive" && binding.subaccount === 0) &&
      !(binding.mode === "exclusive" && binding.subaccount > 0)) {
    return blocked("account_mode_or_subaccount_unverified");
  }
  const lease = await currentLease(now);
  if (!workerLeaseIsLocalAndCurrent(lease, now)) {
    return blocked("v13_worker_lease_not_owned_by_this_process");
  }
  if (binding.mode === "exclusive") {
    try {
      return await resumeDedicatedPairExitOnlyAfterGetRecovery(
        dependencies, binding, lease,
      );
    } catch {
      return blocked("dedicated_pair_exit_resume_failed_frozen");
    }
  }
  let runId: string | null = null;
  try {
    const preparing = await db.transaction(async (tx) => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      if (!config || !knownBoundedRunPhase(config.microLiveRunPhase)) return "bounded_run_state_missing";
      if (config.microLiveRunPhase !== "FROZEN" ||
          !["process_restart_requires_explicit_exit_resume", "entry_expired_reconciliation_required"]
            .some((prefix) => config.microLiveRunFreezeReason?.startsWith(prefix))) {
        return config.microLiveRunFreezeReason === "emergency_stop"
          ? "emergency_stop_overrides_resume" : "bounded_run_not_resumable";
      }
      if (!config.microLiveRunId || !config.microLiveEntryAttempted ||
           config.microLiveExitAttempted || config.microLiveReservedMicros < 1 ||
           config.microLiveReservedMicros > config.microLiveRunCapMicros) {
         return "bounded_run_attempt_or_reservation_invalid";
       }
      if (config.microLiveAccountMode !== binding.mode ||
          config.microLiveSelectedSubaccount !== binding.subaccount ||
          !accountBindingMatchesConfig(config, binding)) return "account_mode_or_subaccount_changed";
      if (config.microLiveAccountingUnresolved) return "primary_accounting_unresolved";
      if (config.microLiveProductionEnabled || config.liveExecutionEnabled ||
          !config.manualKillSwitch) return "resume_requires_frozen_database_gates";
      if (!runCapMatchesAudit(config,
        await tx.select({
          priorRunId: microLiveRunArchiveTable.priorRunId,
          successorRunId: microLiveRunArchiveTable.successorRunId,
        }).from(microLiveRunArchiveTable))) return "bounded_run_cap_audit_mismatch";
      const orders = await tx.select().from(microLiveOrderTable);
      if (orders.some((row) => row.action === "sell") ||
          orders.filter((row) => row.action === "buy" &&
            row.microLiveRunId === config.microLiveRunId).length !== 1) {
        return "bounded_run_order_identity_or_exit_history_invalid";
      }
      runId = config.microLiveRunId;
      await tx.update(microLiveConfigTable).set({
        microLiveProductionEnabled: true,
        liveExecutionEnabled: true,
        manualKillSwitch: false,
      }).where(eq(microLiveConfigTable.id, "singleton"));
      return null;
    });
    if (preparing) return blocked(preparing);
    if (!runId) return blocked("bounded_run_id_missing");
    boundedRunOperationId = runId;
    invalidateMicroLiveReadiness("bounded_run_exit_resume_reconciliation");
    const reconciled = await reconcileMicroLiveAtStartup(dependencies);
    if (!reconciled.ready) {
      await freezeBoundedRun(runId, `entry_expired_reconciliation_required:${reconciled.reason}`);
      return blocked(`exit_resume_reconciliation_${reconciled.reason}`);
    }
    const orders = await db.select().from(microLiveOrderTable);
    const fills = await db.select().from(microLiveFillTable);
    const [config] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    const buyRows = orders.filter((row) => row.action === "buy" && row.microLiveRunId === runId);
    const buy = buyRows[0];
    const ledger = reconstructMicroLivePositions({ orders, fills });
    const positions = ledger.positions.filter((position) => !position.closed &&
      (position.contractsBought > position.contractsSold ||
        position.reservedBuyRiskCents > 0 || position.outstandingSellContracts > 0));
    const approvalProof = buy?.feeEvidenceFingerprint && config?.microLiveRunApprovalId &&
      config.microLiveRunApprovalDigest
      ? feeEvidenceMatchesApproval(buy.feeEvidenceFingerprint, {
        id: config.microLiveRunApprovalId, digest: config.microLiveRunApprovalDigest,
      }) : false;
    const originalReservation = buy
      ? buy.requestedStakeCents * 10_000 +
        (buy.reservedEntryFeeMicros ?? -1) + (buy.reservedExitFeeMicros ?? -1)
      : -1;
    if (!config || config.microLiveRunPhase !== "FROZEN" ||
        config.microLiveRunId !== runId || config.manualKillSwitch ||
        !await currentRunCapMatchesAudit(config) ||
        !accountBindingMatchesConfig(config, binding) || ledger.anomalies.length ||
        buyRows.length !== 1 || !buy || !["filled", "canceled", "closed"].includes(buy.status) ||
        buy.filledContracts <= 0 || buy.remainingContracts !== 0 ||
        positions.length !== 1 || positions[0]!.positionId !==
          (buy.positionId ?? `position:${buy.marketTicker}:${buy.crossingKey}`) ||
        !approvalProof || originalReservation !== config.microLiveReservedMicros ||
         originalReservation > config.microLiveRunCapMicros ||
        !readinessIsCurrent((dependencies.now?.() ?? new Date()).getTime())) {
      await freezeBoundedRun(runId,
        "entry_expired_reconciliation_required:exit_resume_position_or_fee_proof_invalid");
      return blocked("exit_resume_position_or_fee_proof_invalid");
    }
    const latestLease = await currentLease(dependencies.now?.() ?? new Date());
    if (!workerLeaseIsLocalAndCurrent(latestLease, dependencies.now?.() ?? new Date()) ||
        latestLease.owner !== lease.owner) {
      await freezeBoundedRun(runId,
        "entry_expired_reconciliation_required:exit_resume_worker_lease_changed");
      return blocked("exit_resume_worker_lease_changed");
    }
    const resumed = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      if (!locked || locked.microLiveRunId !== runId ||
          locked.microLiveRunPhase !== "FROZEN" ||
          locked.microLiveRunFreezeReason === "emergency_stop" ||
          locked.microLiveExitAttempted || locked.manualKillSwitch ||
          !runCapMatchesAudit(locked,
            await tx.select({
              priorRunId: microLiveRunArchiveTable.priorRunId,
              successorRunId: microLiveRunArchiveTable.successorRunId,
               }).from(microLiveRunArchiveTable)) ||
          !readinessIsCurrent((dependencies.now?.() ?? new Date()).getTime())) return false;
      await tx.update(microLiveConfigTable).set({
        microLiveRunPhase: "EXIT_ONLY",
        microLiveRunFreezeReason: "explicit_exit_only_resume",
      }).where(eq(microLiveConfigTable.id, "singleton"));
      return true;
    });
    if (!resumed) {
      await freezeBoundedRun(runId,
        "entry_expired_reconciliation_required:exit_resume_final_barrier_failed");
      return blocked("exit_resume_final_barrier_failed");
    }
    return { status: "resumed", reason: "bounded_run_exit_only_resumed" };
  } catch (error) {
    if (runId) {
      try {
        await freezeBoundedRun(runId,
          "entry_expired_reconciliation_required:exit_resume_failed_frozen");
      } catch { /* preserve fail-closed state */ }
    }
    return blocked(error instanceof Error ? `exit_resume_failed:${error.message}` : "exit_resume_failed");
  }
}

async function getMicroLiveLedger() {
  const orders = await db.select().from(microLiveOrderTable).orderBy(desc(microLiveOrderTable.updatedAt));
  const fills = await db.select().from(microLiveFillTable).orderBy(desc(microLiveFillTable.filledAt));
  return { orders, fills };
}

function apiDecision(row: typeof microLiveDecisionTable.$inferSelect): MicroLiveDecision {
  const status = row.status === "BLOCK" ? "blocked" :
    row.status === "ERROR"
      ? row.reason.includes("unknown") || row.reason.includes("ambiguous") ? "unknown" : "rejected"
      : "submitted";
  return {
    evaluationId: row.evaluationId,
    status,
    reason: row.reason,
    decidedAt: row.decidedAt.toISOString(),
    ...(row.orderId ? { orderId: row.orderId } : {}),
  };
}

async function persistDecision(value: MicroLiveDecision, orderId: string | null = null) {
  await db.insert(microLiveDecisionTable).values({
    id: randomUUID(),
    status: value.status === "blocked" ? "BLOCK" :
      value.status === "submitted" || value.status === "filled" || value.status === "partial"
        ? "ALLOW" : "ERROR",
    reason: value.reason,
    evaluationId: value.evaluationId,
    orderId,
    decidedAt: new Date(value.decidedAt),
  });
  return value;
}

export async function getMicroLiveState(): Promise<MicroLiveState> {
  const now = new Date();
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const lease = await currentLease(now);
  const { orders, fills } = await getMicroLiveLedger();
  const settlements = await db.select().from(microLiveSettlementTable);
  const ledger = reconstructMicroLivePositions({ orders, fills, settlements });
  if (ledger.anomalies.length) {
    startupReadiness = {
      ready: false,
      checkedAt: 0,
      reason: `micro_live_ledger_anomaly_${ledger.anomalies[0]!.code}`,
    };
  }
  const decisions = await db.select().from(microLiveDecisionTable)
    .orderBy(desc(microLiveDecisionTable.decidedAt)).limit(100);
  const [latestBlocked] = await db.select().from(microLiveDecisionTable)
    .where(eq(microLiveDecisionTable.status, "BLOCK"))
    .orderBy(desc(microLiveDecisionTable.decidedAt)).limit(1);
  const [latestAccepted] = await db.select().from(microLiveDecisionTable)
    .where(eq(microLiveDecisionTable.status, "ALLOW"))
    .orderBy(desc(microLiveDecisionTable.decidedAt)).limit(1);
  const [latestError] = await db.select().from(microLiveDecisionTable)
    .where(eq(microLiveDecisionTable.status, "ERROR"))
    .orderBy(desc(microLiveDecisionTable.decidedAt)).limit(1);
  const flags = environmentFlags();
  const pending = orders.filter((row) => ["pending", "unknown", "partial"].includes(row.status));
  const lastAttempted = decisions[0] ? apiDecision(decisions[0]) : null;
  const recentDecision = lastAttempted;
  const reconciliationCurrent = readinessIsCurrent(now.getTime()) &&
    ledger.anomalies.length === 0 && settlements.length === 0;
  const exposure = ledger.effectiveCommittedRiskCents;
  const [engine] = await db.select({
    signal: forwardTestEngineTable.signal,
    direction: forwardTestEngineTable.direction,
    marketTicker: forwardTestEngineTable.marketTicker,
    lastEvaluationAt: forwardTestEngineTable.lastEvaluationAt,
  }).from(forwardTestEngineTable).where(eq(forwardTestEngineTable.id, FORWARD_TEST_ENGINE_ID)).limit(1);
  const livePositions = ledger.positions.filter((position) =>
    !position.closed && (position.contractsBought > position.contractsSold ||
      position.outstandingSellContracts > 0 || position.reservedBuyRiskCents > 0));
  const current = livePositions[0];
  const maskPnl = Boolean(config?.microLiveAccountingUnresolved &&
    (config.microLiveAccountMode === "primary_nonexclusive" ||
      (config.microLiveAccountMode === null &&
        process.env.MICRO_LIVE_ACCOUNT_MODE?.trim() === "primary_nonexclusive")));
  const currentPosition = current ? {
    positionId: current.positionId,
    marketTicker: current.marketTicker,
    direction: current.side,
    lifecycle: current.state,
    contracts: Math.max(0, current.contractsBought - current.contractsSold),
    contractsBought: current.contractsBought,
    contractsSold: current.contractsSold,
    sellableContracts: current.sellableContracts,
    outstandingSellContracts: current.outstandingSellContracts,
    reservedRiskCents: ledger.effectiveCommittedRiskCents,
    openExposureCents: current.openExposureCents,
    orderIds: orders.filter((row) =>
      row.positionId === current.positionId || row.exitPositionId === current.positionId ||
      fills.some((fill) => fill.orderId === row.id && fill.positionId === current.positionId) ||
      (!row.positionId && row.action === "buy" &&
        `position:${row.marketTicker}:${row.crossingKey}` === current.positionId))
      .map((row) => row.id),
  } : null;
  return {
    enabled: Boolean(config && config.microLiveProductionEnabled &&
      config.liveExecutionEnabled && !config.manualKillSwitch &&
      !config.microLiveAccountingUnresolved &&
      flags.microLiveProductionEnabled && flags.liveExecutionEnabled &&
      lease.held && reconciliationCurrent),
    configurationExists: Boolean(config),
    accountingUnresolved: config?.microLiveAccountingUnresolved ?? false,
    accountingUnresolvedReason: config?.microLiveAccountingUnresolvedReason ?? null,
    databaseFlags: config ? {
      microLiveProductionEnabled: config.microLiveProductionEnabled,
      liveExecutionEnabled: config.liveExecutionEnabled,
    } : null,
    environmentFlags: flags,
    killSwitch: !config || config.manualKillSwitch ? "ON" : "OFF",
    lease,
    reconciliation: {
      status: reconciliationCurrent ? "current" :
        startupReadiness.reason === "startup_reconciliation_not_run" ? "not_run" : "required",
      checkedAt: startupReadiness.checkedAt
        ? new Date(startupReadiness.checkedAt).toISOString() : null,
    },
    readOnlyAudit: {
      status: readOnlyAudit.status,
      checkedAt: readOnlyAudit.checkedAt ? new Date(readOnlyAudit.checkedAt).toISOString() : null,
      reason: readOnlyAudit.reason,
      boundaryAt: readOnlyAudit.boundaryAt,
      knownBotFills: readOnlyAudit.knownBotFills,
      historicalUnattributedFills: readOnlyAudit.historicalUnattributedFills,
      unexplainedFills: readOnlyAudit.unexplainedFills,
      positionDiscrepancies: readOnlyAudit.positionDiscrepancies,
    },
    availableBankrollCents: config ? Math.max(0, config.maxLiveBankrollCents - exposure) : null,
    maxLiveBankrollCents: config?.maxLiveBankrollCents ?? null,
    // Account reads are deliberately not performed from the dashboard GET.
    availableKalshiBalance: null,
    pendingOrders: { count: pending.length, list: pending },
    fills: { count: fills.length, list: fills },
    openExposureCents: ledger.openExposureCents,
    reservedRiskCents: exposure,
    realizedPnlCents: !maskPnl && ledger.positions.some((position) =>
      position.contractsSold > 0 || settlements.some((item) => item.positionId === position.positionId))
      ? ledger.realizedPnlCents : null,
    realizedPnlMicros: !maskPnl && ledger.positions.some((position) =>
      position.contractsSold > 0 || settlements.some((item) => item.positionId === position.positionId))
      ? ledger.realizedPnlMicros : null,
    unrealizedPnlCents: maskPnl ? null : ledger.unrealizedPnlCents,
    wins: null,
    losses: null,
    currentPosition,
    lastAttempted,
    lastAccepted: latestAccepted ? apiDecision(latestAccepted) : null,
    lastRejection: latestError ? apiDecision(latestError) : null,
    latestBlockedReason: latestBlocked?.reason ?? null,
    currentV13Signal: engine ? {
      signal: engine.signal ?? "PASS",
      direction: engine.direction ?? "NONE",
      ticker: engine.marketTicker,
      evaluatedAt: engine.lastEvaluationAt?.toISOString() ?? null,
    } : null,
    openPositionCount: new Set(livePositions.map((position) => position.marketTicker)).size,
    recentDecision,
    boundedRun: boundedRunView(config),
  };
}

export async function emergencyStopMicroLive(): Promise<MicroLiveState> {
  await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config) return;
    await tx.update(microLiveConfigTable).set({
      manualKillSwitch: true,
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
      ...(isPrimaryRun(config) || isDedicatedShardTwoRun(config) ? {
        microLiveRunPhase: "FROZEN",
        microLiveRunFreezeReason: "emergency_stop",
      } : {}),
    }).where(eq(microLiveConfigTable.id, "singleton"));
  });
  return getMicroLiveState();
}

/**
 * Fail-closed exit withdrawal. Freezes POSTs before DELETE and does not reopen
 * them after verification. An unknown response or incomplete fill evidence
 * requires manual intervention, never an automatic replacement order.
 */
export async function cancelAndVerifyMicroLiveExit(
  localOrderId: string,
  dependencies: MicroLiveDependencies = {},
): Promise<{ ready: false; reason: string }> {
  await emergencyStopMicroLive();
  startupReadiness = { ready: false, checkedAt: 0, reason: "exit_cancellation_in_progress" };
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, localOrderId)).limit(1);
  if (!row || row.action !== "sell") {
    return { ready: false, reason: "frozen_exit_identity_unproven" };
  }
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const dedicatedPairMode = Boolean(config && isDedicatedShardTwoRun(config));
  if (!row.exchangeOrderId) {
    if (config?.microLiveAccountMode === "primary_nonexclusive") {
      await markPrimaryAccountingUnresolved("primary_exit_exchange_identity_missing");
    }
    return { ready: false, reason: "frozen_exit_identity_unproven" };
  }
  const exchangeOrderId = row.exchangeOrderId;
  if (row.cancellationAttemptedAt) {
    const recovered = await reconcileMicroLiveAtStartup({
      ...dependencies, frozenExitReconciliation: true,
    });
    return { ready: false, reason: recovered.reason };
  }
  if (!["pending", "partial", "unknown"].includes(row.status)) {
    return { ready: false, reason: "frozen_exit_identity_unproven" };
  }
  const rows = await db.select().from(microLiveOrderTable);
  if (dedicatedPairMode && (!config || config.microLiveRunPhase !== "FROZEN" ||
      !config.manualKillSwitch || config.microLiveProductionEnabled ||
      config.liveExecutionEnabled || !config.microLiveExitAttempted)) {
    return { ready: false, reason: "exit_cancellation_requires_frozen_dedicated_run" };
  }
  if (config?.microLiveAccountMode === "primary_nonexclusive") {
    const recovered = await reconcileMicroLiveAtStartup({
      ...dependencies, frozenExitReconciliation: true,
    });
    return { ready: false, reason: recovered.reason };
  }
  if (!config || rows.some((item) => !item.exchangeOrderId &&
      (["pending", "partial", "unknown"].includes(item.status) ||
        (["filled", "canceled"].includes(item.status) &&
          (item.filledContracts > 0 || item.reservedRiskCents > 0))))) {
    return { ready: false, reason: "frozen_exit_other_identity_unproven" };
  }
  if (!dedicatedPairMode) {
    try {
      const account = await (dependencies.readAccount ?? readKalshiAccount)();
      if (!accountIsComplete(account)) return { ready: false, reason: "account_snapshot_truncated" };
      const activity = await (dependencies.readAccountActivity ?? readKalshiAccountActivity)();
      const proof = proveAccountActivity({
        activity, snapshot: account, localOrders: rows,
        boundaryMs: Math.min(config.createdAt.getTime(),
          ...rows.map((item) => item.createdAt.getTime())),
      });
      if (proof.reason) return { ready: false, reason: proof.reason };
    } catch {
      return { ready: false, reason: "account_history_read_failed" };
    }
  }
  const readStatus = dependencies.readOrderStatus ?? ((id: string) =>
    createMicroLiveTradingClient().getOrder(id));
  const identityMatches = (order: KalshiOrder) =>
    order.orderId === exchangeOrderId &&
    order.clientOrderId === row.clientOrderId &&
    order.ticker === row.marketTicker &&
    order.type === "limit" &&
    order.action === "sell" &&
    order.side === (row.side === "UP" ? "yes" : "no");
  try {
    const before = await readStatus(exchangeOrderId);
    if (!identityMatches(before)) {
      return { ready: false, reason: "exit_cancellation_identity_unproven" };
    }
    if (before.status !== "resting" && before.status !== "executed" &&
        before.status !== "canceled") {
      return { ready: false, reason: "exit_status_unknown_after_freeze" };
    }
    if (before.status === "resting") {
      const initialRemaining = Number(before.remainingCount);
      if (!Number.isSafeInteger(initialRemaining) || initialRemaining <= 0) {
        return { ready: false, reason: "exit_cancellation_identity_unproven" };
      }

      // The account-wide proof and exact GET identity above are prerequisites,
      // but only a durable row claim makes this DELETE single-use across
      // concurrent callers and process restarts. It is intentionally never
      // cleared after a failure or an unknown exchange response.
      const claim = await db.transaction(async (tx) => {
        const [lockedConfig] = await tx.select().from(microLiveConfigTable)
          .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
        if (dedicatedPairMode && lockedConfig?.microLiveSelectedSubaccount) {
          const [boundary] = await tx.select().from(microLivePairBoundaryTable)
            .where(eq(
              microLivePairBoundaryTable.subaccountNumber,
              lockedConfig.microLiveSelectedSubaccount,
            )).for("update").limit(1);
          if (!boundary || boundary.state !== "initialized" ||
              boundary.ambiguityFrozenAt ||
              boundary.initializedRunId !== lockedConfig.microLiveRunId) {
            return "exit_cancellation_pair_boundary_changed";
          }
          await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
            ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
        }
        const [lockedOrder] = await tx.select().from(microLiveOrderTable)
          .where(eq(microLiveOrderTable.id, localOrderId)).for("update").limit(1);
        const currentRows = await tx.select().from(microLiveOrderTable)
          .orderBy(microLiveOrderTable.id).for("update");
        const initialRows = [...rows].sort((left, right) => left.id.localeCompare(right.id));
        if (!lockedConfig || !lockedConfig.manualKillSwitch ||
            lockedConfig.microLiveProductionEnabled || lockedConfig.liveExecutionEnabled ||
            lockedConfig.createdAt.getTime() !== config.createdAt.getTime()) {
          return "exit_cancellation_gates_changed";
        }
        if (!lockedOrder || lockedOrder.exchangeOrderId !== exchangeOrderId ||
            lockedOrder.action !== "sell" ||
            !["pending", "partial", "unknown"].includes(lockedOrder.status)) {
          return "exit_cancellation_local_identity_changed";
        }
        if (lockedOrder.cancellationAttemptedAt) {
          return "exit_cancellation_already_attempted";
        }
        if (JSON.stringify(lockedOrder) !== JSON.stringify(row)) {
          return "exit_cancellation_local_identity_changed";
        }
        if (JSON.stringify(currentRows) !== JSON.stringify(initialRows)) {
          return "exit_cancellation_ownership_snapshot_stale";
        }
        const [updated] = await tx.update(microLiveOrderTable).set({
          cancellationAttemptedAt: new Date(),
        }).where(and(
          eq(microLiveOrderTable.id, localOrderId),
          eq(microLiveOrderTable.exchangeOrderId, exchangeOrderId),
          isNull(microLiveOrderTable.cancellationAttemptedAt),
        )).returning({ id: microLiveOrderTable.id });
        return updated ? "claimed" : "exit_cancellation_already_attempted";
      });
      if (claim !== "claimed") return { ready: false, reason: claim };

      // The exchange can change between the pre-claim GET and the transaction.
      // Re-read after claiming; any mismatch or read failure leaves the durable
      // claim set and therefore cannot cause a retry DELETE.
      const current = await readStatus(exchangeOrderId);
      if (!identityMatches(current)) {
        return { ready: false, reason: "exit_cancellation_identity_unproven_after_claim" };
      }
      if (current.status === "resting") {
        const remaining = Number(current.remainingCount);
        if (!Number.isSafeInteger(remaining) || remaining <= 0) {
          return { ready: false, reason: "exit_cancellation_identity_unproven_after_claim" };
        }
        const pairCancellationProof = dedicatedPairMode
          ? await captureDedicatedPairCancellationProof(
            localOrderId, row.marketTicker, dependencies,
          )
          : null;
        if (dedicatedPairMode && !pairCancellationProof) {
          return { ready: false, reason: "exit_cancellation_pair_recovery_proof_unavailable" };
        }
        const leaseObservedAt = Date.now();
        const lease = await currentLease(new Date(leaseObservedAt));
        const [claimed] = await db.select().from(microLiveOrderTable)
          .where(eq(microLiveOrderTable.id, localOrderId)).limit(1);
        if (!workerLeaseIsLocalAndCurrent(lease, new Date(leaseObservedAt)) ||
            lease.owner !== localWorkerLeaseOwner || !lease.owner || !lease.expiresAt ||
            !claimed?.cancellationAttemptedAt || !claimed.microLiveRunId ||
            claimed.cancellationAuthorizedAt) {
          return { ready: false, reason: "exit_cancellation_authorization_unavailable" };
        }
        const reconciliationAt = Date.now();
        let reconciliationCurrent = true;
        const capability = await db.transaction(async (tx) =>
          authorizeKalshiCancellation(tx, {
            exchangeOrderId, localOrderId,
            clientOrderId: row.clientOrderId, runId: claimed.microLiveRunId!,
          }, {
            runId: claimed.microLiveRunId!,
            reconciled: true, reconciledAt: reconciliationAt,
            leaseOwner: lease.owner!,
            leaseObservedAt, leaseExpiresAt: Date.parse(lease.expiresAt!),
            cancellationClaimedAt: claimed.cancellationAttemptedAt!.getTime(),
            ...(pairCancellationProof ? {
              pairRecoveryProof: {
                checkedAt: pairCancellationProof.proof.checkedAt,
                evidenceDigest: pairCancellationProof.proof.evidenceDigest!,
                configStateDigest: pairCancellationProof.configStateDigest,
                boundaryStateDigest: pairCancellationProof.boundaryStateDigest,
                ledgerStateDigest: pairCancellationProof.ledgerStateDigest,
              },
            } : {}),
            isStillReconciled: () => reconciliationCurrent,
          }));
        if (!capability) {
          return { ready: false, reason: "exit_cancellation_authorization_unavailable" };
        }
        // The one-use marker has COMMITTED before either the client GET or
        // DELETE. A crash, timeout or unknown exchange response can never
        // roll it back and grant a second DELETE on restart.
        const context = {
          databaseEnabled: false, killSwitch: "ON" as const,
          leaseHeld: true, reconciled: true,
        };
        let response: { orderId: string; remainingCount: string };
        try {
          response = dependencies.cancelOrder
            ? await dependencies.cancelOrder(exchangeOrderId, context, capability)
            : await createMicroLiveTradingClient(undefined, pairCancellationProof ?? undefined)
              .cancelReduceOnlyExit(
                exchangeOrderId, row.marketTicker, current.remainingCount, context, capability,
              );
        } finally {
          reconciliationCurrent = false;
        }
        if (response.orderId !== exchangeOrderId ||
            !/^(?:0|0\.0+)$/.test(response.remainingCount)) {
          return { ready: false, reason: "exit_cancellation_response_unverifiable" };
        }
      } else if (current.status !== "executed" && current.status !== "canceled") {
        return { ready: false, reason: "exit_status_unknown_after_claim" };
      }
    }
    // This reads the order again *after* cancellation, all account fills and
    // historical fills, and verifies totals and the account position atomically
    // against the local ledger before committing any newly observed fill.
    const verified = await reconcileMicroLiveAtStartup({
      ...dependencies, frozenExitReconciliation: true,
    });
    if (verified.reason !== "exit_canceled_requires_manual_review" &&
        verified.reason !== "exit_cancellation_requires_manual_reactivation_review") {
      return { ready: false, reason: verified.reason };
    }
    const [final] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, localOrderId)).limit(1);
    if (!final || !["canceled", "filled"].includes(final.status) ||
        final.remainingContracts !== 0) {
      return { ready: false, reason: "exit_still_outstanding_after_cancellation" };
    }
    return { ready: false, reason: "exit_canceled_requires_manual_review" };
  } catch {
    return { ready: false, reason: "exit_cancellation_or_verification_failed" };
  }
}

function quotePrice(book: MicroLiveOrderbook, direction: "UP" | "DOWN") {
  return Number(direction === "UP" ? book.yesAskDollars : book.noAskDollars);
}

function executableEntryPlan(
  book: MicroLiveOrderbook,
  signal: "SCOUT" | "CONFIRM",
  direction: "UP" | "DOWN",
  stakeLimitCents: number,
  maximumPrice: number,
): { contracts: number; limitPrice: number } | null {
  const levels = direction === "UP" ? book.yesAskLevels : book.noAskLevels;
  if (levels !== undefined) {
    const planned = planV13IocEntry({
      signal,
      direction,
      referenceOffer: maximumPrice,
      maxStakeCents: stakeLimitCents,
      bestAskDollars: direction === "UP" ? book.yesAskDollars : book.noAskDollars,
      askLevels: levels,
    });
    return planned.ok
      ? { contracts: planned.plan.contracts, limitPrice: planned.plan.limitPrice }
      : null;
  }

  // Legacy mocked seams may supply only the top of book. Production reads
  // always include normalized depth and therefore use the planner above.
  const bestAsk = quotePrice(book, direction);
  const available = Number(book[
    direction === "UP" ? "yesAskAvailableContracts" : "noAskAvailableContracts"
  ]);
  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk > maximumPrice ||
      !Number.isFinite(available) || available < 0) return null;
  const contracts = Math.min(
    Math.floor(stakeLimitCents / 100 / bestAsk),
    Math.floor(available),
  );
  return contracts >= 1 ? { contracts, limitPrice: bestAsk } : null;
}

function centsForContracts(contracts: number, price: number) {
  return Math.ceil(contracts * price * 100 - 1e-8);
}

function lockedOrdersCash(orders: (typeof microLiveOrderTable.$inferSelect)[]): number {
  return orders.filter((row) => row.action === "buy" && row.status !== "rejected")
    .reduce((sum, row) => sum + row.requestedStakeCents, 0);
}

async function feeCapForEntry(
  dependencies: MicroLiveDependencies,
  orders: (typeof microLiveOrderTable.$inferSelect)[],
  committedCashCents: number,
  requestedStakeCents: number,
  input: { ticker: string; side: "yes" | "no"; count: number; priceDollars: string },
  expectedFingerprint?: string,
  capMicros = LIVE_TEST_CAP_MICROS,
): Promise<{
  fingerprint: string; entryFeeMicros: number; exitFeeMicros: number;
  allInMicros: number; approval: StandingFeePolicyApproval; verifiedAt: number;
} | null> {
  try {
    const approval = await currentApprovedFeeSession(dependencies);
    if (!feeApprovalAllowsRun(approval, capMicros, dependencies) ||
        dependencies.readEntryFeeTerms && !isIsolatedFeeTest(dependencies)) return null;
    const effectiveCapMicros = Math.min(capMicros,
      approval.maximumExposureMicros, approval.approvedRunCapMicros);
    const terms = dependencies.readEntryFeeTerms
      ? await dependencies.readEntryFeeTerms(input.ticker)
      : await readCurrentEntryFeeTerms(input.ticker, globalThis.fetch, approval);
    // Legacy state-machine fixtures use synthetic cap inputs only; require an
    // isolated disposable schema and an injected submitter so this cannot be
    // reached through the application execution path.
    const isolatedFixture = dependencies.isolatedTestFeeCapFixture === true &&
      isIsolatedFeeTest(dependencies);
    const requestedFeePerContract = terms?.feePerContractMicrosAtLimit(input.priceDollars, input.side);
    const modeledCashPerContract = terms?.entryCashDebitPerContractMicrosAtLimit?.(
      input.priceDollars, input.side,
    );
    const requestedCashDebitMicros = isolatedFixture
      ? entryCashDebitMicrosForContracts(input.priceDollars, input.count)
      : modeledCashPerContract == null
        ? null : feeBoundForContracts(modeledCashPerContract, input.count);
    if (!terms || terms.ticker !== input.ticker || !terms.fingerprint ||
        !feeEvidenceMatchesApproval(terms.fingerprint, approval) ||
        requestedFeePerContract == null ||
        !Number.isSafeInteger(requestedFeePerContract) || requestedFeePerContract <= 0 ||
        requestedCashDebitMicros === null || requestedCashDebitMicros % 10_000 !== 0 ||
        !Number.isSafeInteger(terms.verifiedAt) ||
        Date.now() - terms.verifiedAt < 0 || Date.now() - terms.verifiedAt > FRESHNESS_MS ||
        (expectedFingerprint && expectedFingerprint !== terms.fingerprint)) return null;
    // Legacy reservedExitFeeMicros stores extra net sell debit under cash-risk-v2.
    // Unknown evidence remains blocked; verified zero debit is valid.
    const maximumExitPerContract = isolatedFixture
      ? terms.exitFeePerContractMicrosAtLimit("0.0001")
      : terms.maximumExitCashDebitPerContractMicros?.(input.side);
    const exitFeeMicros = maximumExitPerContract === null
      ? null : maximumExitPerContract === undefined
        ? null : feeBoundForContracts(maximumExitPerContract, input.count);
    if (exitFeeMicros === null || exitFeeMicros < 0) return null;
    // The nominal stake is already counted as cash. The legacy entry-fee
    // column stores only the remaining cash debit from fee+rounding, not a
    // second fee on top of the fee-inclusive, per-fill aligned debit.
    const nominalCashMicros = BigInt(requestedStakeCents) * 10_000n;
    const entryTopUp = isolatedFixture
      ? feeBoundForContracts(requestedFeePerContract, input.count)
      : requestedCashDebitMicros === null ? null
        : Number(BigInt(requestedCashDebitMicros) - nominalCashMicros);
    if (entryTopUp === null || !Number.isSafeInteger(entryTopUp) || entryTopUp < 0) return null;
    const entryFeeMicros = entryTopUp;
    // Legacy rows without an immutable, verified entry+exit reservation do
    // not prove that the aggregate loss cap was respected.
    const sessionOrders = orders.filter((row) => row.action === "buy" && row.status !== "rejected");
    let committedAllInMicros = 0n;
    for (const order of sessionOrders) {
      if (order.reservedEntryFeeMicros === null || order.reservedEntryFeeMicros === undefined ||
          order.reservedExitFeeMicros === null || order.reservedExitFeeMicros === undefined ||
          !order.feeEvidenceFingerprint || !order.feeEvidenceVerifiedAt ||
          !order.microLiveRunId ||
          !feeEvidenceMatchesApproval(order.feeEvidenceFingerprint, approval)) return null;
      committedAllInMicros += BigInt(order.requestedStakeCents) * 10_000n +
        BigInt(order.reservedEntryFeeMicros) + BigInt(order.reservedExitFeeMicros);
    }
    if (committedAllInMicros > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const requestAllIn = nominalCashMicros + BigInt(entryFeeMicros) +
      BigInt(exitFeeMicros);
    const total = committedAllInMicros + requestAllIn;
    if (total > BigInt(Number.MAX_SAFE_INTEGER) ||
        !withinAllInLiveTestCap(
          committedCashCents + requestedStakeCents,
          Number(committedAllInMicros - BigInt(committedCashCents) * 10_000n) + entryFeeMicros,
          exitFeeMicros,
           effectiveCapMicros,
        )) return null;
    return {
      fingerprint: terms.fingerprint, entryFeeMicros, exitFeeMicros,
      allInMicros: Number(requestAllIn),
      approval,
      verifiedAt: terms.verifiedAt,
    };
  } catch {
    return null;
  }
}

function accountIsComplete(snapshot: KalshiAccountSnapshot) {
  return snapshot.truncated.openOrders === false &&
    snapshot.truncated.positions === false && snapshot.truncated.fills === false;
}

function accountPositionTickersAreUnique(snapshot: KalshiAccountSnapshot) {
  return new Set(snapshot.positions.map((position) => position.ticker)).size === snapshot.positions.length;
}

type MicroLiveAccountMode = "exclusive" | "primary_nonexclusive";

function configuredMicroLiveAccountBinding(): {
  mode: MicroLiveAccountMode; subaccount: number;
} | null {
  const mode = process.env.MICRO_LIVE_ACCOUNT_MODE?.trim() || "exclusive";
  if (mode !== "exclusive" && mode !== "primary_nonexclusive") return null;
  try {
    const subaccount = getConfiguredKalshiSubaccount();
    if (mode === "primary_nonexclusive" ? subaccount !== 0 : subaccount === 0) return null;
    return { mode, subaccount };
  } catch {
    return null;
  }
}

function accountBindingMatchesConfig(
  config: typeof microLiveConfigTable.$inferSelect,
  binding = configuredMicroLiveAccountBinding(),
) {
  if (!binding) return false;
  if (config.microLiveSelectedExchangeIndex !== null) {
    return config.microLiveSelectedExchangeIndex === DEDICATED_EXCHANGE_INDEX &&
      dedicatedShardTwoIdentityMatchesConfig(config, binding);
  }
  return config.microLiveAccountMode === null
    ? binding.mode === "exclusive" &&
      config.microLiveSelectedSubaccount === null &&
      !config.microLiveEntryAttempted && !config.microLiveExitAttempted
    : config.microLiveAccountMode === binding.mode &&
      config.microLiveSelectedSubaccount === binding.subaccount;
}

/** Review and record the primary binding while every database execution gate is frozen. */
export async function reviewPrimaryMicroLiveAccountBinding(input: {
  actorId: string; reason: string;
}): Promise<{ status: "recorded" | "blocked"; reason: string }> {
  const blocked = (reason: string) => ({ status: "blocked" as const, reason });
  if (process.env.NODE_ENV !== "development") return blocked("micro_live_development_only");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.actorId) ||
      input.reason.trim().length < 16 || input.reason.trim().length > 512) {
    return blocked("account_binding_review_invalid");
  }
  const binding = configuredMicroLiveAccountBinding();
  if (binding?.mode !== "primary_nonexclusive" || binding.subaccount !== 0) {
    return blocked("primary_account_binding_not_configured");
  }
  const result = await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config || config.microLiveProductionEnabled || config.liveExecutionEnabled ||
        !config.manualKillSwitch || config.microLiveRunPhase !== "UNARMED" ||
        config.microLiveRunId !== null || config.microLiveEntryAttempted ||
        config.microLiveExitAttempted || config.microLiveReservedMicros !== 0 ||
        config.microLiveSelectedExchangeIndex !== null ||
        config.microLiveAccountingUnresolved || config.microLiveAccountMode !== null ||
        config.microLiveSelectedSubaccount !== null) {
      return blocked("account_binding_requires_pristine_frozen_configuration");
    }
    const [priorOrder] = await tx.select({ id: microLiveOrderTable.id })
      .from(microLiveOrderTable).limit(1);
    const [priorFill] = await tx.select({ id: microLiveFillTable.id })
      .from(microLiveFillTable).limit(1);
    const [priorSettlement] = await tx.select({ id: microLiveSettlementTable.positionId })
      .from(microLiveSettlementTable).limit(1);
    if (priorOrder || priorFill || priorSettlement) {
      return blocked("account_binding_requires_empty_micro_live_ledger");
    }
    await tx.insert(microLiveDecisionTable).values({
      id: randomUUID(), status: "BLOCK", reason: JSON.stringify({
        kind: "primary_account_binding_review",
        actorId: input.actorId,
        reason: input.reason.trim(),
        mode: binding.mode, subaccount: binding.subaccount,
        decision: "record_binding_only_execution_remains_disabled",
      }),
    });
    await tx.update(microLiveConfigTable).set({
      microLiveAccountMode: binding.mode,
      microLiveSelectedSubaccount: binding.subaccount,
    }).where(eq(microLiveConfigTable.id, "singleton"));
    return { status: "recorded" as const, reason: "primary_account_binding_recorded" };
  });
  if (result.status === "recorded") {
    invalidateMicroLiveReadiness("primary_account_binding_reviewed");
  }
  return result;
}

function proveAccountActivity(input: {
  activity: KalshiAccountActivity;
  snapshot: KalshiAccountSnapshot;
  localOrders: (typeof microLiveOrderTable.$inferSelect)[];
  boundaryMs: number;
  nowMs?: number;
  mode?: MicroLiveAccountMode;
}) {
  const binding = configuredMicroLiveAccountBinding();
  if (!binding || (input.mode !== undefined && binding.mode !== input.mode)) {
    return { reason: "account_mode_or_subaccount_unverified", botFills: [] };
  }
  const proofInput = {
    activity: input.activity,
    snapshot: input.snapshot,
    localOrders: input.localOrders,
    boundaryMs: input.boundaryMs,
    nowMs: input.nowMs,
    configuredSubaccount: binding.subaccount,
  };
  return binding.mode === "primary_nonexclusive"
    ? diagnosePrimaryMicroLiveAccountActivity(proofInput)
    : separateMicroLiveAccountActivity(proofInput);
}

function isAccountingUnresolvedReason(reason: string): boolean {
  return /(?:account_|exchange_|historical_|local_fill|uncertain_|reserved_submission|settlement_|position_|conflict|discrepancy|snapshot_|ledger_|anomaly|unproven|not_proven)/.test(reason);
}

async function markPrimaryAccountingUnresolved(reason: string): Promise<void> {
  clearPrimaryCashPreflightProof();
  await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config) return;
    await tx.update(microLiveConfigTable).set({
      microLiveAccountingUnresolved: true,
      microLiveAccountingUnresolvedReason: reason.slice(0, 256),
      manualKillSwitch: true,
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
      ...(isPrimaryRun(config) ? {
        microLiveRunPhase: "FROZEN",
        microLiveRunFreezeReason: config.microLiveRunFreezeReason === "emergency_stop"
          ? "emergency_stop" : "primary_accounting_unresolved",
      } : {}),
    }).where(eq(microLiveConfigTable.id, "singleton"));
  });
  startupReadiness = { ready: false, checkedAt: 0, reason };
}

export async function freshOwnershipPreflight(
  reservationId: string,
  dependencies: MicroLiveDependencies,
  nowFn: () => Date,
  dedicatedPairProof?: DedicatedPairPostProof,
): Promise<string | null> {
  clearPrimaryCashPreflightProof();
  const failOwnershipPreflight = (reason: string): string => {
    clearPrimaryCashPreflightProof();
    return reason;
  };
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!config) return failOwnershipPreflight("micro_live_configuration_absent");
  if (!accountBindingMatchesConfig(config)) {
    return failOwnershipPreflight("account_mode_or_subaccount_changed");
  }
  const localOrders = await db.select().from(microLiveOrderTable);
  const reservationOrder = localOrders.find((row) => row.id === reservationId);
  if (!reservationOrder) {
    return failOwnershipPreflight("ownership_preflight_reservation_missing");
  }
  if (isDedicatedShardTwoRun(config)) {
    const valid = await dedicatedPairProofStillMatches(
      dedicatedPairProof, reservationId, config, nowFn().getTime(),
    );
    if (!valid || reservationOrder.microLiveRunId !== config.microLiveRunId ||
        reservationOrder.marketTicker !== dedicatedPairProof?.ticker ||
        reservationOrder.action !== (dedicatedPairProof?.action === "entry" ? "buy" : "sell") ||
        reservationOrder.status !== "pending" || reservationOrder.exchangeOrderId !== null ||
        reservationOrder.remainingContracts !== reservationOrder.requestedContracts) {
      return failOwnershipPreflight("dedicated_pair_collateral_proof_missing_stale_or_changed");
    }
    return null;
  }
  const boundaryMs = Math.min(config.createdAt.getTime(),
    ...localOrders.map((row) => row.createdAt.getTime()));
  const startedAt = performance.now();
  let account: KalshiAccountSnapshot;
  let activity: KalshiAccountActivity;
  try {
    account = await (dependencies.readAccount ?? readKalshiAccount)();
    activity = await (dependencies.readAccountActivity ?? readKalshiAccountActivity)();
  } catch {
    return failOwnershipPreflight("account_history_read_failed");
  }
  if (performance.now() - startedAt > 5_000) {
    return failOwnershipPreflight("account_ownership_preflight_too_slow");
  }
  if (!accountIsComplete(account)) {
    if (config.microLiveAccountMode === "primary_nonexclusive") {
      await markPrimaryAccountingUnresolved("account_snapshot_truncated");
    }
    return failOwnershipPreflight("account_snapshot_truncated");
  }
  if (!accountPositionTickersAreUnique(account)) {
    if (config.microLiveAccountMode === "primary_nonexclusive") {
      await markPrimaryAccountingUnresolved("exchange_position_duplicate_ticker");
    }
    return failOwnershipPreflight("exchange_position_duplicate_ticker");
  }
  const proof = proveAccountActivity({
    activity, snapshot: account, localOrders, boundaryMs, nowMs: nowFn().getTime(),
  });
  if (proof.reason && config.microLiveAccountMode === "primary_nonexclusive" &&
      isAccountingUnresolvedReason(proof.reason)) {
    await markPrimaryAccountingUnresolved(proof.reason);
  }
  if (proof.reason) return failOwnershipPreflight(proof.reason);
  if (config.microLiveAccountMode !== "primary_nonexclusive") return null;

  const failCashPreflight = async (reason: string): Promise<string> => {
    await markPrimaryAccountingUnresolved(reason);
    return reason;
  };
  const baselineMicrosText = config.microLivePrimaryCashBaselineMicros;
  const baselineAtMs = config.microLivePrimaryCashBaselineAt?.getTime();
  const baselineDigest = config.microLivePrimaryCashBaselineEvidenceDigest;
  if (!config.microLiveRunId ||
      reservationOrder.microLiveRunId !== config.microLiveRunId ||
      reservationOrder.marketTicker.trim() === "" ||
      typeof baselineMicrosText !== "string" ||
      !/^(0|[1-9]\d*)$/.test(baselineMicrosText) ||
      !Number.isSafeInteger(Number(baselineMicrosText)) ||
      config.microLivePrimaryCashBaselineRunId !== config.microLiveRunId ||
      !Number.isFinite(baselineAtMs) || baselineAtMs! <= 0 ||
      baselineAtMs! > nowFn().getTime() ||
      !config.microLiveRunArmedAt ||
      typeof baselineDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(baselineDigest)) {
    return failCashPreflight("primary_cash_baseline_missing_or_run_changed");
  }
  const orderStatusReader = dependencies.readOrderStatus ?? ((id: string) =>
    createMicroLiveTradingClient().getOrder(id));
  const orderStatuses = new Map<string, KalshiOrder>();
  const botOrderIds = localOrders.flatMap((row) =>
    row.exchangeOrderId ? [row.exchangeOrderId] : []);
  if (new Set(botOrderIds).size !== botOrderIds.length) {
    return failCashPreflight("primary_cash_bot_order_identity_ambiguous");
  }
  const filledByOrder = new Map<string, number>();
  for (const fill of activity.fills) {
    if (!fill.orderId || !botOrderIds.includes(fill.orderId)) continue;
    const count = Number(fill.countFp);
    const total = (filledByOrder.get(fill.orderId) ?? 0) + count;
    if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(total)) {
      return failCashPreflight("primary_cash_bot_fill_count_unproven");
    }
    filledByOrder.set(fill.orderId, total);
  }
  for (const row of localOrders) {
    if (!row.exchangeOrderId) continue;
    let status: KalshiOrder;
    try {
      status = await orderStatusReader(row.exchangeOrderId);
    } catch {
      return failCashPreflight("primary_cash_order_status_unavailable");
    }
    if (!status) return failCashPreflight("primary_cash_order_status_unavailable");
    const filled = status.filledCount === null ? Number.NaN : Number(status.filledCount);
    const activityOrder = activity.orders.find((item) => item.id === row.exchangeOrderId);
    if (status.orderId !== row.exchangeOrderId || status.clientOrderId !== row.clientOrderId ||
        status.ticker !== row.marketTicker ||
        status.side !== (row.side === "UP" ? "yes" : "no") ||
        status.action !== row.action || status.type !== "limit" ||
        !Number.isSafeInteger(filled) || filled < 0 || filled > row.requestedContracts ||
        filled !== (filledByOrder.get(row.exchangeOrderId) ?? 0) ||
        !activityOrder || activityOrder.status !== status.status) {
      return failCashPreflight("primary_cash_order_status_identity_or_fill_mismatch");
    }
    if (status.status === "resting" || activityOrder.status === "resting") {
      return failCashPreflight("primary_cash_open_order_hold_unresolved");
    }
    if ((status.status !== "executed" && status.status !== "canceled") ||
        Number(status.remainingCount) !== 0 ||
        Number(activityOrder.remainingCount) !== 0 ||
        (status.status === "executed" && filled !== row.requestedContracts &&
          row.action !== "sell")) {
      return failCashPreflight("primary_cash_order_status_unproven");
    }
    orderStatuses.set(row.exchangeOrderId, status);
  }
  if (performance.now() - startedAt > 5_000) {
    return failCashPreflight("account_ownership_preflight_too_slow");
  }

  const normalizedCashFills = activity.fills.map((fill) => {
    const row = fill.orderId
      ? localOrders.find((candidate) => candidate.exchangeOrderId === fill.orderId)
      : undefined;
    if (!row) return fill;
    const status = orderStatuses.get(row.exchangeOrderId!);
    const priceDollars = status ? microLiveOrderLegFillPrice(fill, {
      id: status.orderId, ticker: status.ticker, side: status.side,
      action: status.action, outcomeSide: status.outcomeSide,
      bookSide: status.bookSide,
    }) : null;
    if (priceDollars === null) return null;
    return { ...fill, priceDollars };
  });
  if (normalizedCashFills.some((fill) => fill === null)) {
    return failCashPreflight("primary_cash_fill_price_or_direction_unproven");
  }
  const cashFills = normalizedCashFills as typeof activity.fills;
  const localFills = await db.select().from(microLiveFillTable);
  const localSettlements = await db.select().from(microLiveSettlementTable);
  let settlementEvidence: PrimaryCashSettlementEvidence[] = [];
  let settlementOwnershipProven = false;
  if (localSettlements.length) {
    let exchange: KalshiSettlementsSnapshot;
    try {
      exchange = await (dependencies.readSettlements ?? readKalshiSettlements)();
    } catch {
      return failCashPreflight("primary_cash_settlement_read_failed");
    }
    if (exchange.truncated) return failCashPreflight("primary_cash_settlement_snapshot_truncated");
    const seenTickers = new Set<string>();
    for (const local of localSettlements) {
      const matches = exchange.settlements.filter((item) => item.ticker === local.marketTicker);
      const actual = matches[0];
      const sideCountText = local.side === "UP" ? actual?.yesCountFp : actual?.noCountFp;
      const oppositeCountText = local.side === "UP" ? actual?.noCountFp : actual?.yesCountFp;
      const wholeCount = (value: string | undefined): bigint | null => {
        if (!value || !/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(value)) return null;
        return BigInt(value.split(".")[0]!);
      };
      const sideCount = wholeCount(sideCountText);
      const oppositeCount = wholeCount(oppositeCountText);
      const revenueCents = actual && /^(0|[1-9][0-9]*)$/.test(actual.revenueCents)
        ? BigInt(actual.revenueCents) : null;
      const feeMicros = actual ? dollarsToMicros(actual.feeCostDollars) : null;
      if (matches.length !== 1 || !actual || seenTickers.has(local.marketTicker) ||
          actual.marketResult !== local.marketResult ||
          sideCount !== BigInt(local.contracts) || oppositeCount !== 0n ||
          revenueCents === null || revenueCents * 10_000n !== BigInt(local.payoutMicros) ||
          local.feeMicros === null || feeMicros === null || feeMicros !== local.feeMicros ||
          Date.parse(actual.settledAt) !== local.settledAt.getTime()) {
        return failCashPreflight("primary_cash_settlement_attribution_unresolved");
      }
      seenTickers.add(local.marketTicker);
      settlementEvidence.push({
        id: `${actual.ticker}:${actual.settledAt}`,
        ticker: actual.ticker,
        revenueCents: actual.revenueCents,
        feeCostDollars: actual.feeCostDollars,
      });
    }
    settlementOwnershipProven = true;
  }
  const botOrderIdSet = new Set(botOrderIds);
  const cashResult = computeBotAttributableAvailableCashDelta({
    baseline: {
      availableCashMicros: baselineMicrosText,
      runId: config.microLivePrimaryCashBaselineRunId!,
      capturedAt: new Date(baselineAtMs!).toISOString(),
      evidenceDigest: baselineDigest!,
    },
    currentRunId: config.microLiveRunId,
    currentAvailableCashDollars: account.balance.availableCashDollars,
    activity: {
      authenticated: activity.available,
      complete: activity.available && !activity.truncated,
      selectedSubaccount: activity.selectedSubaccount ?? -1,
      scanFinishedAt: activity.scanFinishedAt ?? "",
      allCashComponentsKnown: account.openOrders.length === 0 &&
        !activity.orders.some((order) => order.status === "resting"),
      fills: cashFills,
      settlements: settlementEvidence,
      botOrderIds,
      nonBotOrderIds: activity.orders.map((order) => order.id)
        .filter((id) => !botOrderIdSet.has(id)),
      botSettlementIds: settlementEvidence.map((item) => item.id),
      nonBotSettlementIds: [],
      botSettlementOwnershipProven: settlementOwnershipProven,
    },
    nowMs: nowFn().getTime(),
  });
  if (!cashResult.ok) return failCashPreflight(cashResult.reason);
  // Exchange-ID-linked local ledger entries must still be represented in the
  // authenticated history; the ownership proof alone does not compare every
  // persisted precision field.
  for (const localFill of localFills) {
    const localOrder = localOrders.find((order) => order.id === localFill.orderId);
    const exchangeFill = cashFills.find((item) => item.id === localFill.exchangeFillId);
    const tradeMicros = exchangeFill
      ? fillTradeMicros(localFill.contracts, exchangeFill.priceDollars) : null;
    const feeMicros = exchangeFill ? dollarsToMicros(exchangeFill.feeCostDollars) : null;
    if (!localOrder || !exchangeFill ||
        exchangeFill.orderId !== localOrder.exchangeOrderId ||
        exchangeFill.orderId !== localFill.exchangeOrderId ||
        exchangeFill.ticker !== localOrder.marketTicker ||
        exchangeFill.action !== localOrder.action ||
        Number(exchangeFill.countFp) !== localFill.contracts ||
        tradeMicros === null || localFill.tradeMicros !== tradeMicros ||
        feeMicros === null || !localFill.feeKnown || localFill.feeMicros !== feeMicros) {
      return failCashPreflight("primary_cash_local_fill_identity_or_precision_unproven");
    }
  }
  if (localSettlements.length) {
    return failCashPreflight("primary_cash_settlement_requires_manual_reactivation_review");
  }
  const checkpoint = await verifyPrimaryActivityCheckpoint(config, {
    availableCashMicros: baselineMicrosText,
    runId: config.microLiveRunId,
    capturedAt: new Date(baselineAtMs!).toISOString(),
    evidenceDigest: baselineDigest!,
  }, dependencies, nowFn().getTime());
  if ("reason" in checkpoint) return failCashPreflight(checkpoint.reason);
  const checkpointCommitted = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!locked || locked.microLiveRunId !== config.microLiveRunId ||
        locked.microLivePrimaryCashBaselineMicros !== baselineMicrosText ||
        locked.microLivePrimaryCashBaselineEvidenceDigest !== baselineDigest ||
        locked.microLivePrimaryActivityCheckpointRunId !== config.microLivePrimaryActivityCheckpointRunId ||
        locked.microLivePrimaryActivityCheckpointCursor !== config.microLivePrimaryActivityCheckpointCursor ||
        locked.microLivePrimaryActivityCheckpointAt?.getTime() !==
          config.microLivePrimaryActivityCheckpointAt?.getTime() ||
        locked.microLivePrimaryActivityCheckpointEvidenceDigest !==
          config.microLivePrimaryActivityCheckpointEvidenceDigest) return false;
    await tx.update(microLiveConfigTable).set({
      microLivePrimaryActivityCheckpointRunId: checkpoint.checkpoint.runId,
      microLivePrimaryActivityCheckpointCursor: checkpoint.checkpoint.cursor,
      microLivePrimaryActivityCheckpointAt: new Date(checkpoint.checkpoint.capturedAt),
      microLivePrimaryActivityCheckpointEvidenceDigest: checkpoint.checkpoint.evidenceDigest,
    }).where(eq(microLiveConfigTable.id, "singleton"));
    return true;
  });
  if (!checkpointCommitted) return failCashPreflight("primary_activity_checkpoint_or_gates_changed");
  const [latestConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const [latestOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, reservationId)).limit(1);
  const checkedAt = nowFn().getTime();
  if (!latestConfig || !latestOrder ||
      latestConfig.microLiveRunId !== config.microLiveRunId ||
      latestConfig.microLiveAccountMode !== "primary_nonexclusive" ||
      latestConfig.microLivePrimaryCashBaselineMicros !== baselineMicrosText ||
      latestConfig.microLivePrimaryCashBaselineRunId !== config.microLiveRunId ||
      latestConfig.microLivePrimaryCashBaselineAt?.getTime() !== baselineAtMs ||
      latestConfig.microLivePrimaryCashBaselineEvidenceDigest !== baselineDigest ||
       latestConfig.microLivePrimaryActivityCheckpointEvidenceDigest !==
         checkpoint.checkpoint.evidenceDigest ||
      latestOrder.id !== reservationOrder.id ||
      latestOrder.microLiveRunId !== config.microLiveRunId ||
      latestOrder.marketTicker !== reservationOrder.marketTicker ||
      latestOrder.clientOrderId !== reservationOrder.clientOrderId ||
      latestOrder.action !== reservationOrder.action ||
      latestOrder.status !== "pending" ||
      !Number.isSafeInteger(checkedAt) || checkedAt < baselineAtMs!) {
    return failCashPreflight("primary_cash_baseline_or_reservation_changed");
  }
  primaryCashPreflightProof = {
    orderId: latestOrder.id,
    runId: config.microLiveRunId,
    marketTicker: latestOrder.marketTicker,
    baselineDigest,
    baselineMicros: baselineMicrosText,
    baselineAt: baselineAtMs!,
    checkedAt,
  };
  return null;
}

async function executeQualifiedLiveExit(
  evaluation: typeof forwardTestEvaluationTable.$inferSelect,
  dependencies: MicroLiveDependencies,
): Promise<MicroLiveDecision> {
  const nowFn = dependencies.now ?? (() => new Date());
  const block = (reason: string) =>
    persistDecision(decision(evaluation.id, reason, "blocked", nowFn()));
  if (process.env.NODE_ENV !== "development") {
    return block("micro_live_development_only");
  }
  if (!evaluation.crossingKey || !evaluation.livePositionId ||
      (evaluation.direction !== "UP" && evaluation.direction !== "DOWN") ||
      nowFn().getTime() - evaluation.evaluatedAt.getTime() < 0 ||
      nowFn().getTime() - evaluation.evaluatedAt.getTime() > FRESHNESS_MS) {
    return block("live_exit_evaluation_invalid_or_stale");
  }
  const crossingKey = evaluation.crossingKey;
  const livePositionId = evaluation.livePositionId;
  if (!readinessIsCurrent(nowFn().getTime())) return block("startup_reconciliation_required");
  const recovery = await reconcileMicroLiveAtStartup(dependencies);
  if (!recovery.ready) return block(recovery.reason);
  if (!readinessIsCurrent(nowFn().getTime())) return block("startup_reconciliation_required");
  const lease = await currentLease(nowFn());
  if (!lease.held) return block("v13_worker_lease_not_valid");
  let orders = await db.select().from(microLiveOrderTable);
  let fills = await db.select().from(microLiveFillTable);
  let [accountConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!accountConfig || !accountBindingMatchesConfig(accountConfig)) {
    return block("account_mode_or_subaccount_changed");
  }
  const boundedPrimary = isPrimaryRun(accountConfig);
  const dedicatedPairMode = isDedicatedShardTwoRun(accountConfig);
  if ((boundedPrimary || dedicatedPairMode) && accountConfig.microLiveRunId &&
      !await currentRunCapMatchesAudit(accountConfig)) {
    await freezeBoundedRun(accountConfig.microLiveRunId, "bounded_run_cap_audit_mismatch");
    return block("bounded_run_cap_audit_mismatch");
  }
  if ((boundedPrimary || dedicatedPairMode) &&
      !workerLeaseIsLocalAndCurrent(lease, nowFn())) {
    return block("v13_worker_lease_not_owned_by_this_process");
  }
  if ((boundedPrimary || dedicatedPairMode) && (
      !knownBoundedRunPhase(accountConfig.microLiveRunPhase) ||
      !["ENTRY_OPEN", "EXIT_ONLY"].includes(accountConfig.microLiveRunPhase) ||
      !accountConfig.microLiveRunId || !accountConfig.microLiveRunArmedAt)) {
    return block("bounded_run_not_exit_eligible");
  }
  if (accountConfig.microLiveAccountingUnresolved) return block("primary_accounting_unresolved");
  const ledger = reconstructMicroLivePositions({ orders, fills });
  if (ledger.anomalies.length) return block(`micro_live_ledger_anomaly_${ledger.anomalies[0]!.code}`);
  const position = ledger.positions.find((item) => item.positionId === evaluation.livePositionId);
  if (!position || position.marketTicker !== evaluation.marketTicker ||
      position.side !== evaluation.direction || position.closed ||
      position.sellableContracts <= 0 || position.outstandingSellContracts > 0 ||
       orders.some((row) => row.action === "sell" &&
         row.exitPositionId === evaluation.livePositionId) ||
      orders.some((row) => row.action === "buy" &&
        (row.positionId ?? `position:${row.marketTicker}:${row.crossingKey}`) === evaluation.livePositionId &&
        ["pending", "partial", "unknown"].includes(row.status) && row.remainingContracts > 0)) {
    return block("live_exit_position_or_outstanding_orders_not_proven");
  }
  const sourceBuy = orders.find((row) => row.action === "buy" &&
    row.crossingKey === evaluation.crossingKey &&
    (row.positionId ?? `position:${row.marketTicker}:${row.crossingKey}`) === evaluation.livePositionId);
  if (!sourceBuy) return block("live_exit_crossing_mismatch");
  if (boundedPrimary && !boundedEntryReservationMatchesRun(accountConfig, sourceBuy)) {
    return block("bounded_run_reservation_proof_invalid");
  }
  if (dedicatedPairMode && (sourceBuy.microLiveRunId !== accountConfig.microLiveRunId ||
      accountConfig.microLiveExitAttempted)) {
    return block("dedicated_pair_bounded_exit_attempt_invalid");
  }
  if ((boundedPrimary || dedicatedPairMode) &&
      (sourceBuy.microLiveRunId !== accountConfig.microLiveRunId ||
      !sourceBuy.feeEvidenceFingerprint ||
      !feeEvidenceMatchesApproval(sourceBuy.feeEvidenceFingerprint, {
        id: accountConfig.microLiveRunApprovalId ?? "",
        digest: accountConfig.microLiveRunApprovalDigest ?? "",
      }))) return block("bounded_run_entry_fee_approval_identity_mismatch");
  if (!sourceBuy.microLiveRunId || !sourceBuy.feeEvidenceFingerprint ||
      !sourceBuy.feeEvidenceVerifiedAt ||
      sourceBuy.reservedExitFeeMicros === null ||
      sourceBuy.reservedExitFeeMicros === undefined) {
    return block("entry_fee_reservation_proof_missing");
  }
  const feeApproval = await currentApprovedFeeSession(dependencies);
  const configuredRunCap = accountConfig.microLiveRunCapMicros;
  const permittedExposureMicros = Math.min(PREPARED_BOUNDED_RUN_CAP_MICROS,
    configuredRunCap, feeApproval?.maximumExposureMicros ?? 0,
    feeApproval?.approvedRunCapMicros ?? 0);
  const reservedPositionExposure = sourceBuy.requestedStakeCents * 10_000 +
    (sourceBuy.reservedEntryFeeMicros ?? Number.MAX_SAFE_INTEGER) +
    sourceBuy.reservedExitFeeMicros;
  if (!feeApprovalAllowsRun(feeApproval, configuredRunCap, dependencies) ||
      !feeEvidenceMatchesApproval(sourceBuy.feeEvidenceFingerprint, feeApproval) ||
      boundedPrimary &&
        (accountConfig.microLiveRunApprovalId !== feeApproval.id ||
         accountConfig.microLiveRunApprovalDigest !== feeApproval.digest) ||
      !Number.isSafeInteger(reservedPositionExposure) ||
      reservedPositionExposure > permittedExposureMicros) {
    return block("standing_fee_policy_or_reserved_exposure_invalid");
  }
  let book: MicroLiveOrderbook;
  try {
    book = await (dependencies.readOrderbook ?? readKalshiOrderbook)(evaluation.marketTicker);
  } catch {
    return block("exit_sell_quote_unavailable");
  }
  const quoteAt = Date.parse(book.observedAt);
  const price = Number(evaluation.direction === "UP" ? book.yesBidDollars : book.noBidDollars);
  if (!Number.isFinite(quoteAt) || nowFn().getTime() - quoteAt < 0 ||
      nowFn().getTime() - quoteAt > FRESHNESS_MS ||
      !Number.isFinite(price) || price <= 0 || price >= 1) {
    return block("exit_sell_quote_stale_or_invalid");
  }
  const count = position.sellableContracts;
  let exitTerms: EntryFeeTerms | null;
  try {
    exitTerms = dependencies.readEntryFeeTerms && !isIsolatedFeeTest(dependencies)
      ? null
      : dependencies.readEntryFeeTerms
      ? await dependencies.readEntryFeeTerms(evaluation.marketTicker)
      : await readCurrentEntryFeeTerms(
        evaluation.marketTicker, globalThis.fetch, feeApproval,
      );
  } catch {
    exitTerms = null;
  }
  const exitPerContract = exitTerms?.exitCashDebitPerContractMicrosAtLimit?.(
    price.toFixed(4), sourceBuy.side === "UP" ? "yes" : "no",
  );
  const exitFeeBound = exitPerContract === null || exitPerContract === undefined
    ? null : feeBoundForContracts(exitPerContract, count);
  const freshExitExposure = exitFeeBound === null ? null :
    sourceBuy.requestedStakeCents * 10_000 +
    (sourceBuy.reservedEntryFeeMicros ?? Number.MAX_SAFE_INTEGER) + exitFeeBound;
  const exitTermsAge = exitTerms ? nowFn().getTime() - exitTerms.verifiedAt : -1;
  if (!exitTerms || exitTerms.ticker !== evaluation.marketTicker || !exitTerms.fingerprint ||
      !feeEvidenceMatchesApproval(exitTerms.fingerprint, feeApproval) ||
      !feeEvidenceMatchesMarketIdentity(
        sourceBuy.feeEvidenceFingerprint, exitTerms.fingerprint, feeApproval,
      ) ||
      !Number.isSafeInteger(exitTerms.verifiedAt) || exitTermsAge < 0 ||
      exitTermsAge > FRESHNESS_MS || exitFeeBound === null ||
      exitFeeBound > sourceBuy.reservedExitFeeMicros ||
      freshExitExposure === null ||
      !Number.isSafeInteger(freshExitExposure) ||
      freshExitExposure > permittedExposureMicros) {
    return block("current_exit_fee_terms_unavailable_or_above_reserved_bound");
  }
  const actionKey = createHash("sha256").update(
    `${evaluation.livePositionId}\u001f${evaluation.crossingKey}\u001fEXIT`).digest("hex");
  const orderId = randomUUID();
  const clientOrderId = `ml-${actionKey.slice(0, 40)}`;
  const dedicatedPhase = accountConfig.microLiveRunPhase === "EXIT_ONLY"
    ? "EXIT_ONLY" : "ENTRY_OPEN";
  let dedicatedPairPostProof: DedicatedPairPostProof | undefined;
  if (dedicatedPairMode) {
    const proof = await captureDedicatedPairPostProof(
      accountConfig, orderId, evaluation.marketTicker, "exit", dedicatedPhase, dependencies,
    );
    if (!proof.proof) {
      return block(proof.reason ?? "dedicated_pair_collateral_proof_unavailable");
    }
    dedicatedPairPostProof = proof.proof;
  }
  let fingerprint: string | null = null;
  try {
    fingerprint = await db.transaction(async (tx) => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [runCapBoundary] = dedicatedPairMode && config?.microLiveSelectedSubaccount
        ? await tx.select().from(microLivePairBoundaryTable)
          .where(eq(
            microLivePairBoundaryTable.subaccountNumber,
            config.microLiveSelectedSubaccount,
          )).for("update").limit(1)
        : [];
       if (!config || !config.microLiveEntryAttempted ||
            !accountBindingMatchesConfig(config) ||
             ((boundedPrimary || dedicatedPairMode) &&
              (config.microLiveRunId !== sourceBuy.microLiveRunId ||
               !["ENTRY_OPEN", "EXIT_ONLY"].includes(config.microLiveRunPhase) ||
               !boundedEntryReservationMatchesRun(config, sourceBuy) ||
               !runCapMatchesAudit(config,
                 await tx.select({
                   priorRunId: microLiveRunArchiveTable.priorRunId,
                   successorRunId: microLiveRunArchiveTable.successorRunId,
                  }).from(microLiveRunArchiveTable), runCapBoundary))) ||
             ((boundedPrimary || dedicatedPairMode) &&
               (config.microLiveExitAttempted || orders.some((row) => row.action === "sell"))) ||
           config.microLiveRunId !== sourceBuy.microLiveRunId ||
           config.microLiveReservedMicros < 1 ||
           config.manualKillSwitch || !config.microLiveProductionEnabled ||
          !config.liveExecutionEnabled || !environmentFlags().microLiveProductionEnabled ||
          !environmentFlags().liveExecutionEnabled || !readinessIsCurrent(nowFn().getTime())) return null;
      const lockedOrders = await tx.select().from(microLiveOrderTable);
      const lockedFills = await tx.select().from(microLiveFillTable);
      if (ledgerFingerprint(lockedOrders, lockedFills) !== ledgerFingerprint(orders, fills)) return null;
      const current = reconstructMicroLivePositions({ orders: lockedOrders, fills: lockedFills });
      const live = current.positions.find((item) => item.positionId === evaluation.livePositionId);
      if (current.anomalies.length || !live || live.sellableContracts !== count ||
          live.outstandingSellContracts !== 0 || live.closed ||
           lockedOrders.some((row) => row.action === "sell" &&
             row.exitPositionId === livePositionId)) return null;
      const [created] = await tx.insert(microLiveOrderTable).values({
        id: orderId, actionKey, clientOrderId, marketTicker: evaluation.marketTicker,
        crossingKey, triggerType: "EXIT", action: "sell", intent: "exit",
        exitPositionId: livePositionId, side: evaluation.direction,
        sourceEvaluationId: evaluation.id, signalAt: evaluation.evaluatedAt,
        btcSignalPrice: evaluation.btcPrice, target: evaluation.target,
        orderbookQuotePrice: price, quoteObservedAt: new Date(quoteAt),
        requestedLimitPrice: price, requestedContracts: count, requestedStakeCents: 0,
        reservedRiskCents: 0, microLiveRunId: sourceBuy.microLiveRunId,
        reservedEntryFeeMicros: sourceBuy.reservedEntryFeeMicros,
        reservedExitFeeMicros: exitFeeBound,
        feeEvidenceFingerprint: exitTerms.fingerprint,
        feeEvidenceVerifiedAt: new Date(exitTerms.verifiedAt),
        remainingContracts: count, status: "pending",
      }).onConflictDoNothing().returning({ id: microLiveOrderTable.id });
      if (!created) return null;
        if (boundedPrimary || dedicatedPairMode) {
         await tx.update(microLiveConfigTable).set({ microLiveExitAttempted: true })
           .where(eq(microLiveConfigTable.id, "singleton"));
       }
      return ledgerFingerprint(
        await tx.select().from(microLiveOrderTable),
        await tx.select().from(microLiveFillTable),
      );
    });
  } catch {
    fingerprint = null;
  }
  if (!fingerprint) return block("exit_atomic_reservation_conflict_or_gate_changed");
  let placed: KalshiOrder | null = null;
  let posted = false;
  let postInvoked = false;
  let errorReason: string | null = null;
  let ambiguous = false;
  try {
    await dependencies.beforeSubmissionInterlock?.();
  } catch {
    errorReason = "exit_submission_interlock_failed";
  }
  if (!errorReason) {
    try {
      errorReason = await freshOwnershipPreflight(
        orderId, dependencies, nowFn, dedicatedPairPostProof,
      );
    } catch {
      errorReason = "account_history_read_failed";
    }
  }
  if (errorReason) {
    startupReadiness = { ready: false, checkedAt: 0, reason: errorReason };
    await db.update(microLiveOrderTable).set({
      status: "rejected", failureReason: errorReason,
    }).where(eq(microLiveOrderTable.id, orderId));
    await emergencyStopMicroLive();
    return persistDecision(decision(evaluation.id, errorReason, "blocked", nowFn()), orderId);
  }
  try {
    await db.transaction(async (tx) => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [runCapBoundary] = dedicatedPairMode && config?.microLiveSelectedSubaccount
        ? await tx.select().from(microLivePairBoundaryTable)
          .where(eq(
            microLivePairBoundaryTable.subaccountNumber,
            config.microLiveSelectedSubaccount,
          )).for("update").limit(1)
        : [];
      if (dedicatedPairMode) {
        await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
          ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
      }
      const [settled] = await tx.select({ positionId: microLiveSettlementTable.positionId })
        .from(microLiveSettlementTable).limit(1);
      const [engine] = await tx.select().from(forwardTestEngineTable)
        .where(eq(forwardTestEngineTable.id, FORWARD_TEST_ENGINE_ID)).limit(1);
       if (settled || !config || !accountBindingMatchesConfig(config) ||
           config.microLiveAccountingUnresolved ||
             ((boundedPrimary || dedicatedPairMode) &&
              (config.microLiveRunId !== sourceBuy.microLiveRunId ||
               !["ENTRY_OPEN", "EXIT_ONLY"].includes(config.microLiveRunPhase) ||
               !boundedEntryReservationMatchesRun(config, sourceBuy) ||
               !runCapMatchesAudit(config,
                 await tx.select({
                   priorRunId: microLiveRunArchiveTable.priorRunId,
                   successorRunId: microLiveRunArchiveTable.successorRunId,
                  }).from(microLiveRunArchiveTable), runCapBoundary) ||
               !config.microLiveExitAttempted ||
               !engine?.leaseOwner || boundedWorkerLeaseEvidence?.owner !== engine.leaseOwner ||
               !boundedWorkerLeaseEvidence ||
               boundedWorkerLeaseEvidence.expiresAt <= nowFn().getTime() ||
               nowFn().getTime() - boundedWorkerLeaseEvidence.observedAt > FRESHNESS_MS)) ||
           config.manualKillSwitch || !config.microLiveProductionEnabled ||
          !config.liveExecutionEnabled || !environmentFlags().microLiveProductionEnabled ||
          !environmentFlags().liveExecutionEnabled || !readinessIsCurrent(nowFn().getTime()) ||
          !engine?.enabled || engine.strategyVersion !== "V1.3" ||
          !engine.leaseOwner || !engine.leaseExpiresAt ||
          engine.leaseExpiresAt <= nowFn() ||
          ledgerFingerprint(await tx.select().from(microLiveOrderTable),
            await tx.select().from(microLiveFillTable)) !== fingerprint) {
        errorReason = "exit_submission_gate_changed";
        return;
      }
       if (dedicatedPairMode && (!dedicatedPairPostProof ||
           dedicatedPairPostProof.action !== "exit" ||
           dedicatedPairPostProof.ticker !== evaluation.marketTicker ||
           dedicatedPairPostProof.configIdentityFingerprint !==
             dedicatedPairConfigIdentityFingerprint(config) ||
           nowFn().getTime() - dedicatedPairPostProof.proof.checkedAt < 0 ||
           nowFn().getTime() - dedicatedPairPostProof.proof.checkedAt > 5_000)) {
         errorReason = "dedicated_pair_collateral_post_proof_changed_or_stale";
         return;
       }
       if (dedicatedPairMode) {
         const [lockedBoundary] = await tx.select().from(microLivePairBoundaryTable)
           .where(eq(
             microLivePairBoundaryTable.subaccountNumber,
             config.microLiveSelectedSubaccount!,
           )).for("update").limit(1);
         if (!lockedBoundary || lockedBoundary.state !== "initialized" ||
             lockedBoundary.ambiguityFrozenAt ||
             lockedBoundary.initializedRunId !== config.microLiveRunId ||
             lockedBoundary.cleanBoundaryEvidenceDigest !==
               dedicatedPairPostProof!.proof.boundaryEvidenceDigest ||
             lockedBoundary.restrictedApiKeyId !== config.microLiveRestrictedApiKeyId ||
             lockedBoundary.restrictedKeyFingerprint !==
               config.microLiveRestrictedKeyFingerprint ||
             lockedBoundary.fundingTransferId !== config.microLiveFundingAnchorTransferId ||
             !dedicatedShardTwoIdentityMatchesConfig(config)) {
           errorReason = "dedicated_pair_collateral_boundary_identity_changed";
           return;
         }
         const [lockedOrders, lockedFills, lockedSettlements] = await Promise.all([
           tx.select().from(microLiveOrderTable),
           tx.select().from(microLiveFillTable),
           tx.select().from(microLiveSettlementTable),
         ]);
         if (dedicatedPairLedgerFingerprintFrom(
           lockedOrders.filter((entry) => entry.id !== orderId),
           lockedFills,
           lockedSettlements,
         ) !== dedicatedPairPostProof!.localLedgerFingerprint) {
           errorReason = "dedicated_pair_collateral_ledger_changed";
           return;
         }
       }
       const lockedFeeApproval = await feeApprovalAtBarrier(config, dependencies);
       if (!feeApprovalAllowsRun(lockedFeeApproval, config.microLiveRunCapMicros, dependencies) ||
           !sameFeeApproval(lockedFeeApproval, feeApproval) ||
            (boundedPrimary || dedicatedPairMode) &&
             (config.microLiveRunApprovalId !== lockedFeeApproval.id ||
              config.microLiveRunApprovalDigest !== lockedFeeApproval.digest)) {
         errorReason = "standing_fee_policy_changed_or_incompatible";
         return;
       }
        let finalExitTerms: EntryFeeTerms | null = null;
        try {
           finalExitTerms = dependencies.readEntryFeeTerms && !isIsolatedFeeTest(dependencies)
             ? null
             : dependencies.readEntryFeeTerms
            ? await dependencies.readEntryFeeTerms(evaluation.marketTicker)
            : await readCurrentEntryFeeTerms(
               evaluation.marketTicker, globalThis.fetch, feeApproval,
            );
       } catch {
         finalExitTerms = null;
       }
       const finalPerContract = finalExitTerms?.exitCashDebitPerContractMicrosAtLimit?.(
         price.toFixed(4), sourceBuy.side === "UP" ? "yes" : "no",
       );
       const finalFeeBound = finalPerContract === null || finalPerContract === undefined
         ? null : feeBoundForContracts(finalPerContract, count);
       const finalTermsAge = finalExitTerms ? nowFn().getTime() - finalExitTerms.verifiedAt : -1;
         const finalApproval = lockedFeeApproval;
        const finalReservedPositionExposure = sourceBuy.requestedStakeCents * 10_000 +
          (sourceBuy.reservedEntryFeeMicros ?? Number.MAX_SAFE_INTEGER) +
          (sourceBuy.reservedExitFeeMicros ?? Number.MAX_SAFE_INTEGER);
        const finalPermittedExposureMicros = Math.min(
          PREPARED_BOUNDED_RUN_CAP_MICROS,
          config.microLiveRunCapMicros,
          finalApproval?.maximumExposureMicros ?? 0,
          finalApproval?.approvedRunCapMicros ?? 0,
        );
        const finalExitExposure = finalFeeBound === null
          ? null
          : sourceBuy.requestedStakeCents * 10_000 +
            (sourceBuy.reservedEntryFeeMicros ?? Number.MAX_SAFE_INTEGER) + finalFeeBound;
          if (!feeApprovalAllowsRun(finalApproval, config.microLiveRunCapMicros, dependencies) ||
              !sameFeeApproval(finalApproval, feeApproval) ||
              boundedPrimary &&
                (config.microLiveRunApprovalId !== finalApproval.id ||
                 config.microLiveRunApprovalDigest !== finalApproval.digest) ||
             !feeEvidenceMatchesApproval(sourceBuy.feeEvidenceFingerprint!, finalApproval) ||
             !Number.isSafeInteger(finalReservedPositionExposure) ||
             finalReservedPositionExposure > finalApproval.maximumExposureMicros ||
             finalReservedPositionExposure > finalApproval.approvedRunCapMicros ||
              finalExitExposure === null ||
              !Number.isSafeInteger(finalExitExposure) ||
              finalExitExposure > finalPermittedExposureMicros ||
             !finalExitTerms || finalExitTerms.ticker !== evaluation.marketTicker ||
             Date.now() - finalExitTerms.verifiedAt < 0 ||
             Date.now() - finalExitTerms.verifiedAt > FRESHNESS_MS ||
             !feeEvidenceMatchesApproval(finalExitTerms.fingerprint, finalApproval) ||
              !feeEvidenceMatchesMarketIdentity(
                sourceBuy.feeEvidenceFingerprint!, finalExitTerms.fingerprint, finalApproval,
              ) ||
           !finalExitTerms.fingerprint || !Number.isSafeInteger(finalExitTerms.verifiedAt) ||
           finalTermsAge < 0 || finalTermsAge > FRESHNESS_MS || finalFeeBound === null ||
           finalFeeBound > sourceBuy.reservedExitFeeMicros!) {
         errorReason = "current_exit_fee_terms_unavailable_or_above_reserved_bound";
         return;
       }
      const [reservedExit] = await tx.select().from(microLiveOrderTable)
        .where(eq(microLiveOrderTable.id, orderId)).for("update").limit(1);
      if (reservedExit?.status !== "pending" ||
          reservedExit.action !== "sell" ||
          reservedExit.marketTicker !== evaluation.marketTicker ||
          !orderFeeProofMatches(reservedExit, {
            runId: sourceBuy.microLiveRunId,
            entryFeeMicros: sourceBuy.reservedEntryFeeMicros,
            exitFeeMicros: exitFeeBound,
            fingerprint: exitTerms.fingerprint,
            verifiedAt: exitTerms.verifiedAt,
          })) {
        errorReason = "exit_persisted_fee_provenance_mismatch";
        return;
      }
      const [refreshedExit] = await tx.update(microLiveOrderTable).set({
        reservedExitFeeMicros: finalFeeBound,
        feeEvidenceFingerprint: finalExitTerms.fingerprint,
        feeEvidenceVerifiedAt: new Date(finalExitTerms.verifiedAt),
      }).where(eq(microLiveOrderTable.id, orderId)).returning();
      if (refreshedExit?.status !== "pending" ||
          !orderFeeProofMatches(refreshedExit, {
            runId: sourceBuy.microLiveRunId,
            entryFeeMicros: sourceBuy.reservedEntryFeeMicros,
            exitFeeMicros: finalFeeBound,
            fingerprint: finalExitTerms.fingerprint,
            verifiedAt: finalExitTerms.verifiedAt,
          })) {
        errorReason = "exit_final_fee_provenance_mismatch";
        return;
      }
      // The final live fee read above may itself start a durable verifier.
      // Lock its gate only after that read, then hold it through the exit POST.
       const postFeeApproval = await feeApprovalAtBarrier(
         config, dependencies, tx, finalExitTerms,
       );
      if (!feeApprovalAllowsRun(postFeeApproval, config.microLiveRunCapMicros, dependencies) ||
          !sameFeeApproval(postFeeApproval, lockedFeeApproval) ||
          !sameFeeApproval(postFeeApproval, feeApproval) ||
           (boundedPrimary || dedicatedPairMode) &&
            (config.microLiveRunApprovalId !== postFeeApproval.id ||
             config.microLiveRunApprovalDigest !== postFeeApproval.digest)) {
        errorReason = "standing_fee_policy_changed_or_incompatible";
        return;
      }
       const exitInput: KalshiLimitOrderRequest = {
         ticker: evaluation.marketTicker,
         clientOrderId,
         side: evaluation.direction === "UP" ? "yes" : "no",
         action: "sell",
         count,
         priceDollars: price.toFixed(4),
       };
       const submissionContext = {
         databaseEnabled: true as const,
         killSwitch: "OFF" as const,
         leaseHeld: true as const,
         reconciled: true as const,
       };
       const submissionCapability = dependencies.submitOrder ? null :
         await authorizeKalshiSubmission(tx, exitInput, {
           orderId,
           reconciled: readinessIsCurrent(nowFn().getTime()),
           reconciledAt: startupReadiness.checkedAt,
            leaseOwner: engine.leaseOwner ?? "",
           leaseObservedAt: boundedWorkerLeaseEvidence?.observedAt ?? nowFn().getTime(),
           leaseExpiresAt: engine.leaseExpiresAt.getTime(),
            isStillReconciled: () => readinessIsCurrent(nowFn().getTime()),
         }, nowFn().getTime());
       if (!dependencies.submitOrder && !submissionCapability) {
         errorReason = "exit_submission_capability_rejected";
         return;
       }
      try {
        postInvoked = true;
         if (dependencies.submitOrder) {
           placed = await dependencies.submitOrder(exitInput, submissionContext);
         } else {
            placed = await createMicroLiveTradingClient(dedicatedPairPostProof)
             .createReduceOnlyExit(
               { ...exitInput, action: "sell" }, submissionContext, submissionCapability!,
             );
         }
        posted = true;
        await dependencies.afterExitPost?.();
      } catch (error) {
        placed = null;
        const detail = error instanceof Error ? error.message : "unknown";
        ambiguous = posted || !/HTTP_ERROR.*(?:400|401|403|404|409|422)/.test(detail);
        errorReason = ambiguous ? "ambiguous_exit_submission_freezes_live" : "exchange_rejected_exit";
        // A rejected reduce-only exit may mean inventory changed at Kalshi
        // since the account snapshot. No replacement or ordinary sell is safe.
        await tx.update(microLiveConfigTable).set({
          manualKillSwitch: true, microLiveProductionEnabled: false, liveExecutionEnabled: false,
          ...(config.microLiveAccountMode === "primary_nonexclusive" ? {
            microLiveAccountingUnresolved: true,
            microLiveAccountingUnresolvedReason: "primary_exit_submission_uncertain",
          } : {}),
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }
    });
  } catch {
    placed = null;
    ambiguous = postInvoked;
    errorReason = postInvoked
      ? "ambiguous_exit_submission_freezes_live" : "exit_submission_gate_changed";
  }
  if (!placed) {
    await db.update(microLiveOrderTable).set({
      status: ambiguous ? "unknown" : "rejected",
      failureReason: errorReason ?? "exit_submission_gate_changed",
    }).where(eq(microLiveOrderTable.id, orderId));
    if (accountConfig.microLiveAccountMode === "primary_nonexclusive" && ambiguous) {
      await markPrimaryAccountingUnresolved("primary_uncertain_exit_submission_result");
    }
    await emergencyStopMicroLive();
    if (errorReason === "exchange_rejected_exit") {
      // A definite rejection should still be compared with the authenticated
      // account. A conflicting position/fill stays frozen for manual review.
      await reconcileMicroLiveAtStartup({ ...dependencies, frozenExitReconciliation: true });
    }
    return persistDecision(decision(evaluation.id, errorReason ?? "exit_submission_gate_changed",
      ambiguous ? "unknown" : "blocked", nowFn()), orderId);
  }
  const exchange = placed as KalshiOrder;
  const remaining = Number(exchange.remainingCount);
  const filled = Number(exchange.filledCount);
  if (!exchange.orderId || exchange.ticker !== evaluation.marketTicker ||
      exchange.side !== (evaluation.direction === "UP" ? "yes" : "no") ||
      exchange.action !== "sell" || exchange.clientOrderId !== clientOrderId ||
      !Number.isSafeInteger(filled) || filled < 0 ||
      !Number.isSafeInteger(remaining) || remaining < 0 ||
      // IOC's final remaining count excludes the quantity canceled at the
      // venue. A partial fill can therefore have 1 + 0 < requested 3.
      remaining + filled > count) {
    await db.update(microLiveOrderTable).set({
      exchangeOrderId: exchange.orderId || null, status: "unknown",
      failureReason: "exit_response_unverifiable",
    }).where(eq(microLiveOrderTable.id, orderId));
    if (accountConfig.microLiveAccountMode === "primary_nonexclusive") {
      await markPrimaryAccountingUnresolved("primary_invalid_exit_submission_order_state");
    }
    await emergencyStopMicroLive();
    // A reduce-only order can be capped if inventory shrank. Save its ID and
    // attempt the frozen order/fill/position reconciliation immediately.
    if (exchange.orderId) await cancelAndVerifyMicroLiveExit(orderId, dependencies);
    return persistDecision(decision(evaluation.id, "exit_response_unverifiable", "unknown", nowFn()), orderId);
  }
  try {
    await db.update(microLiveOrderTable).set({
      exchangeOrderId: exchange.orderId, submittedAt: nowFn(),
      remainingContracts: remaining,
    }).where(eq(microLiveOrderTable.id, orderId));
    const recorded = await persistDecision({
      ...decision(evaluation.id, "exit_submitted_waiting_for_actual_fills", "submitted", nowFn()),
      orderId: exchange.orderId,
    }, orderId);
    const result = await cancelAndVerifyMicroLiveExit(orderId, dependencies);
    return result.reason === "exit_canceled_requires_manual_review"
      ? { ...recorded, reason: "exit_verified_execution_frozen_for_review" }
      : decision(evaluation.id, result.reason, "unknown", nowFn());
  } catch {
    startupReadiness = { ready: false, checkedAt: 0, reason: "exit_persistence_failed_after_submission" };
    try {
      await db.update(microLiveOrderTable).set({
        status: "unknown", failureReason: "exit_persistence_failed_after_submission",
      }).where(eq(microLiveOrderTable.id, orderId));
      await emergencyStopMicroLive();
    } catch {
      // The reserved ID-less order still prevents restart readiness. Never retry.
    }
    return decision(evaluation.id, "exit_audit_write_failed_freezes_live", "unknown", nowFn());
  }
}

/**
 * Processes one already-persisted V1.3 action. This function never evaluates
 * strategy signals or creates a production bankroll/configuration.
 */
export async function executeQualifiedV13Trigger(
  evaluationId: string,
  dependencies: MicroLiveDependencies = {},
): Promise<MicroLiveDecision> {
  const nowFn = dependencies.now ?? (() => new Date());
  const now = nowFn();
  const block = (reason: string) =>
    persistDecision(decision(evaluationId, reason, "blocked", nowFn()));
  if (process.env.NODE_ENV !== "development") {
    return block("micro_live_development_only");
  }
  const [evaluation] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, evaluationId)).limit(1);
  if (!evaluation) return block("evaluation_not_found");
  if (evaluation.signal === "EXIT" && evaluation.evaluationSource === "micro_live" &&
      evaluation.livePositionId && evaluation.sourcePaperEvaluationId &&
      evaluation.positionWasOpen && evaluation.qualifyingTrigger &&
      isChampionV13Evaluation(evaluation)) {
    return executeQualifiedLiveExit(evaluation, dependencies);
  }
  const isInitialEntry =
    (evaluation.signal === "SCOUT" || evaluation.signal === "CONFIRM") &&
    evaluation.evaluationSource === "paper" &&
    !evaluation.positionWasOpen &&
    evaluation.livePositionId === null &&
    evaluation.sourcePaperEvaluationId === null;
  if (!isChampionV13Evaluation(evaluation) || !evaluation.qualifyingTrigger ||
      !isInitialEntry ||
      (evaluation.direction !== "UP" && evaluation.direction !== "DOWN") ||
      !evaluation.crossingKey) {
    return block(evaluation.signal === "EXIT"
      ? "exit_blocked_no_provable_v13_exit_action"
      : "evaluation_not_a_qualified_v13_entry");
  }
  const age = now.getTime() - evaluation.evaluatedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > FRESHNESS_MS) return block("evaluation_stale");
  const flags = environmentFlags();
  if (!flags.microLiveProductionEnabled || !flags.liveExecutionEnabled) return block("environment_flags_not_both_true");

  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!config) return block("micro_live_configuration_absent");
  const binding = configuredMicroLiveAccountBinding();
  if (!binding) {
    return block(config.microLiveAccountMode !== null || config.microLiveEntryAttempted ||
      config.microLiveExitAttempted ? "account_mode_or_subaccount_changed" :
      "account_mode_or_subaccount_unverified");
  }
  const primaryMode = binding.mode === "primary_nonexclusive";
  const dedicatedPairMode = isDedicatedShardTwoRun(config);
  if (primaryMode && (
      !knownBoundedRunPhase(config.microLiveRunPhase) ||
      config.microLiveRunPhase !== "ENTRY_OPEN" ||
      !config.microLiveRunId || !config.microLiveRunArmedAt ||
      evaluation.evaluatedAt <= config.microLiveRunArmedAt ||
      config.microLiveEntryAttempted || config.microLiveExitAttempted)) {
    return block("bounded_run_entry_window_closed_or_already_used");
  }
  if (primaryMode && !await currentRunCapMatchesAudit(config)) {
    return block("bounded_run_cap_audit_mismatch");
  }
  if (dedicatedPairMode && (
      config.microLiveRunPhase !== "ENTRY_OPEN" || !config.microLiveRunId ||
      !config.microLiveRunArmedAt || evaluation.evaluatedAt <= config.microLiveRunArmedAt ||
      config.microLiveEntryAttempted || config.microLiveExitAttempted)) {
    return block("dedicated_pair_bounded_entry_window_closed_or_already_used");
  }
  if (dedicatedPairMode && !await currentRunCapMatchesAudit(config)) {
    return block("bounded_run_cap_audit_mismatch");
  }
  if (!accountBindingMatchesConfig(config, binding)) {
    const priorOrders = await db.select({ id: microLiveOrderTable.id }).from(microLiveOrderTable);
    if (config.microLiveAccountMode !== null || config.microLiveEntryAttempted ||
        config.microLiveExitAttempted || priorOrders.length) {
      return block("account_mode_or_subaccount_changed");
    }
  }
  if (config.microLiveAccountingUnresolved) return block("primary_accounting_unresolved");
  if (!config.microLiveProductionEnabled || !config.liveExecutionEnabled) return block("database_flags_not_both_enabled");
  if (config.manualKillSwitch) return block("micro_live_kill_switch_on");
  const lease = await currentLease(now);
  if (!lease.held || (primaryMode && !workerLeaseIsLocalAndCurrent(lease, now))) {
    return block(primaryMode
      ? "v13_worker_lease_not_owned_by_this_process" : "v13_worker_lease_not_valid");
  }
  if (!readinessIsCurrent(nowFn().getTime())) {
    return block(startupReadiness.reason ?? "startup_reconciliation_required");
  }

  const [existing] = await db.select().from(microLiveOrderTable).where(and(
    eq(microLiveOrderTable.marketTicker, evaluation.marketTicker),
    eq(microLiveOrderTable.crossingKey, evaluation.crossingKey),
    eq(microLiveOrderTable.triggerType, evaluation.signal),
  )).limit(1);
  if (existing) return block("action_already_reserved");

  const activeOrders = (await db.select().from(microLiveOrderTable)
    .where(inArray(microLiveOrderTable.status, ["pending", "unknown", "partial", "filled", "canceled"])))
    .filter(activeOrder);
  const initialLedger = reconstructMicroLivePositions({
    orders: await db.select().from(microLiveOrderTable),
    fills: await db.select().from(microLiveFillTable),
  });
  if (initialLedger.anomalies.length) {
    return block(`micro_live_ledger_anomaly_${initialLedger.anomalies[0]!.code}`);
  }
  if (initialLedger.effectiveCommittedRiskCents > 500 ||
      initialLedger.effectiveCommittedRiskCents > config.maxLiveBankrollCents ||
      initialLedger.effectiveCommittedRiskCents > config.maxCumulativeReservedCents) {
    return block("micro_live_risk_limit_reached");
  }
  if (activeOrders.some((order) => order.marketTicker !== evaluation.marketTicker)) {
    return block("one_position_limit_reached");
  }
  if (config.maxOpenPositions < 1) return block("micro_live_open_position_limit_is_zero");
  const sameCrossingRows = activeOrders.filter((order) =>
    order.marketTicker === evaluation.marketTicker && order.crossingKey === evaluation.crossingKey);
  if (activeOrders.some((order) => order.crossingKey !== evaluation.crossingKey)) {
    return block("different_crossing_already_has_open_position");
  }
  if (sameCrossingRows.some((order) => order.triggerType === "CONFIRM" || evaluation.signal === "SCOUT")) {
    return block("one_market_position_action_sequence_violation");
  }
  if (activeOrders.some((order) => order.status === "unknown")) return block("unknown_order_freezes_live_execution");

  let btc: Awaited<ReturnType<NonNullable<MicroLiveDependencies["readBtc"]>>>;
  let book: MicroLiveOrderbook;
  let account: KalshiAccountSnapshot;
  try {
    btc = await (dependencies.readBtc ?? (async () => publicForwardTestFeeds.btc()))();
    book = await (dependencies.readOrderbook ?? readKalshiOrderbook)(evaluation.marketTicker);
    account = await (dependencies.readAccount ?? readKalshiAccount)();
  } catch {
    return block("fresh_market_or_account_read_failed");
  }
  const feedAge = nowFn().getTime() - Math.min(btc.receivedAt.getTime(), btc.providerAt.getTime());
  const quoteAt = Date.parse(book.observedAt);
  const quoteAge = nowFn().getTime() - quoteAt;
  if (!Number.isFinite(btc.price) || btc.price <= 0 || !Number.isFinite(feedAge) ||
      feedAge < 0 || feedAge > FRESHNESS_MS) {
    return block("btc_observation_stale_or_invalid");
  }
  if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > FRESHNESS_MS) return block("orderbook_quote_stale");
  if (!accountIsComplete(account)) {
    if (primaryMode) await markPrimaryAccountingUnresolved("account_snapshot_truncated");
    return block("account_snapshot_truncated");
  }
  if (!accountPositionTickersAreUnique(account)) {
    if (primaryMode) await markPrimaryAccountingUnresolved("exchange_position_duplicate_ticker");
    return block("exchange_position_duplicate_ticker");
  }
  const cash = Number(account.balance.availableCashDollars);
  if (!Number.isFinite(cash) || cash < 0) return block("available_kalshi_cash_invalid");

  const localRows = await db.select().from(microLiveOrderTable);
  const localOrderIds = new Set(localRows.flatMap((row) => row.exchangeOrderId ? [row.exchangeOrderId] : []));
  const localFillRows = await db.select({
    id: microLiveFillTable.exchangeFillId,
    orderId: microLiveFillTable.orderId,
    contracts: microLiveFillTable.contracts,
    costCents: microLiveFillTable.costCents,
  }).from(microLiveFillTable);
  const knownFillIds = new Set(localFillRows.map((row) => row.id));
  if (account.fills.some((fill) => {
    if (!primaryMode) return !fill.orderId || !localOrderIds.has(fill.orderId);
    return fill.ticker === evaluation.marketTicker &&
      (!fill.orderId || !localOrderIds.has(fill.orderId));
  })) {
    if (primaryMode) await markPrimaryAccountingUnresolved("primary_market_fill_attribution_conflict");
    return block("exchange_fill_discrepancy");
  }
  if (account.openOrders.some((exchangeOrder) => {
    const local = localRows.find((row) => row.exchangeOrderId === exchangeOrder.id);
    return (!local && (!primaryMode || exchangeOrder.ticker === evaluation.marketTicker)) ||
      (local && local.marketTicker !== exchangeOrder.ticker) ||
      (local && (
      (local.side === "UP" ? "yes" : "no") !== exchangeOrder.side ||
      exchangeOrder.action !== "buy"));
  })) {
    if (primaryMode) await markPrimaryAccountingUnresolved("primary_market_open_order_conflict");
    return block("exchange_open_order_discrepancy");
  }
  if (account.fills.some((fill) => {
    const local = localRows.find((row) => row.exchangeOrderId === fill.orderId);
    return (!local && (!primaryMode || fill.ticker === evaluation.marketTicker)) ||
      (local && local.marketTicker !== fill.ticker) ||
      (local && (
      (local.side === "UP" ? "yes" : "no") !== fill.side ||
      fill.action !== "buy"));
  })) {
    if (primaryMode) await markPrimaryAccountingUnresolved("primary_market_fill_attribution_conflict");
    return block("exchange_fill_discrepancy");
  }
  if (primaryMode) {
    try {
      const activity = await (dependencies.readAccountActivity ?? readKalshiAccountActivity)();
      const proof = proveAccountActivity({
        activity, snapshot: account, localOrders: localRows,
        boundaryMs: Math.min(config.createdAt.getTime(),
          ...localRows.map((row) => row.createdAt.getTime())),
        nowMs: nowFn().getTime(), mode: "primary_nonexclusive",
      });
      if (proof.reason) {
        if (isAccountingUnresolvedReason(proof.reason)) {
          await markPrimaryAccountingUnresolved(proof.reason);
        }
        return block(proof.reason);
      }
      account = {
        ...account,
        fills: proof.botFills,
        openOrders: account.openOrders.filter((order) => localOrderIds.has(order.id)),
      };
    } catch {
      await markPrimaryAccountingUnresolved("primary_account_history_read_failed");
      return block("account_history_read_failed");
    }
  }

  const orderStatus = new Map<string, KalshiOrder>();
  const readOrderStatus = dependencies.readOrderStatus ?? ((id: string) =>
    createMicroLiveTradingClient().getOrder(id));
  for (const row of localRows) {
    if (!row.exchangeOrderId || !activeOrder(row) ||
        account.openOrders.some((order) => order.id === row.exchangeOrderId)) continue;
    try {
      const status = await readOrderStatus(row.exchangeOrderId);
      if (status.orderId !== row.exchangeOrderId || status.ticker !== row.marketTicker ||
          status.side !== (row.side === "UP" ? "yes" : "no") || status.action !== "buy") {
        await db.update(microLiveOrderTable).set({
          status: "unknown", failureReason: "order_identity_discrepancy_freezes_live",
        }).where(eq(microLiveOrderTable.id, row.id));
        if (primaryMode) await markPrimaryAccountingUnresolved("exchange_order_identity_discrepancy");
        await emergencyStopMicroLive();
        return block("exchange_order_identity_discrepancy");
      }
      orderStatus.set(row.id, status);
    } catch {
      await db.update(microLiveOrderTable).set({
        status: "unknown", failureReason: "order_status_unavailable_freezes_live",
      }).where(eq(microLiveOrderTable.id, row.id));
      if (primaryMode) await markPrimaryAccountingUnresolved("exchange_order_status_unavailable");
      await emergencyStopMicroLive();
      return block("local_order_status_unavailable");
    }
  }

  if (localRows.some((row) => row.status === "unknown")) return block("unknown_order_freezes_live_execution");
  const fillContractsByOrder = new Map<string, number>();
  const fillCostsByOrder = new Map<string, number>();
  for (const fill of localFillRows) {
    fillContractsByOrder.set(fill.orderId, (fillContractsByOrder.get(fill.orderId) ?? 0) + fill.contracts);
    fillCostsByOrder.set(fill.orderId, (fillCostsByOrder.get(fill.orderId) ?? 0) + fill.costCents);
  }
  for (const fill of account.fills) {
    if (!fill.orderId || knownFillIds.has(fill.id)) continue;
    const order = localRows.find((row) => row.exchangeOrderId === fill.orderId);
    const contracts = Number(fill.countFp);
    const price = Number(fill.priceDollars);
    const tradeMicros = fillTradeMicros(contracts, fill.priceDollars);
    const feeMicros = dollarsToMicros(fill.feeCostDollars);
    if (!order || !Number.isSafeInteger(contracts) || contracts <= 0 ||
        !Number.isFinite(price) || price <= 0 || price > order.requestedLimitPrice + 0.0001 ||
        tradeMicros === null || (fill.feeCostDollars != null && feeMicros === null)) {
      if (primaryMode) await markPrimaryAccountingUnresolved("exchange_fill_invalid");
      return block("exchange_fill_invalid");
    }
    const costCents = centsForContracts(contracts, price);
    if ((fillContractsByOrder.get(order.id) ?? 0) + contracts > order.requestedContracts ||
        (fillCostsByOrder.get(order.id) ?? 0) + costCents > order.requestedStakeCents) {
      if (primaryMode) await markPrimaryAccountingUnresolved("exchange_fill_exceeds_reserved_order");
      return block("exchange_fill_exceeds_reserved_order");
    }
    fillContractsByOrder.set(order.id, (fillContractsByOrder.get(order.id) ?? 0) + contracts);
    fillCostsByOrder.set(order.id, (fillCostsByOrder.get(order.id) ?? 0) + costCents);
    await db.insert(microLiveFillTable).values({
      id: randomUUID(), orderId: order.id, exchangeFillId: fill.id, exchangeOrderId: fill.orderId,
      filledAt: new Date(fill.createdAt ?? nowFn().toISOString()), contracts, fillPrice: price,
       costCents, tradeMicros, feeMicros,
       feeCents: feeMicros === null ? 0 : microsToRoundedCents(feeMicros),
       feeKnown: feeMicros !== null,
    }).onConflictDoNothing({ target: microLiveFillTable.exchangeFillId });
  }

  for (const row of localRows) {
    const filled = fillContractsByOrder.get(row.id) ?? 0;
    const fillCost = fillCostsByOrder.get(row.id) ?? 0;
    const visibleOpen = row.exchangeOrderId
      ? account.openOrders.find((order) => order.id === row.exchangeOrderId) : undefined;
    const terminal = orderStatus.get(row.id);
    let remaining: number;
    let terminalStatus: "filled" | "canceled" | null = null;
    if (visibleOpen) {
      remaining = Number(visibleOpen.remainingCount);
      if (!Number.isSafeInteger(remaining) || remaining < 0 ||
          visibleOpen.status !== "resting" ||
          filled + remaining !== row.requestedContracts) {
        if (primaryMode) await markPrimaryAccountingUnresolved("exchange_open_order_discrepancy");
        return block("exchange_open_order_discrepancy");
      }
    } else if (terminal?.status === "canceled") {
      remaining = 0;
      terminalStatus = "canceled";
    } else if (terminal?.status === "executed") {
      remaining = 0;
      if (filled !== row.requestedContracts && row.action !== "sell") {
        return block("executed_order_fill_discrepancy");
      }
      terminalStatus = filled === row.requestedContracts ? "filled" : "canceled";
    } else if (row.status === "rejected" || row.status === "canceled") {
      continue;
    } else if (row.status === "filled" && filled === row.requestedContracts) {
      remaining = 0;
      terminalStatus = "filled";
    } else {
      return block("local_order_exchange_discrepancy");
    }
    if (filled > row.requestedContracts || (remaining > 0 && !visibleOpen)) {
      return block("local_order_exchange_discrepancy");
    }
    const reserved = fillCost + (visibleOpen
      ? centsForContracts(remaining, row.requestedLimitPrice) : 0);
    await db.update(microLiveOrderTable).set({
      filledContracts: filled,
      remainingContracts: remaining,
      reservedRiskCents: reserved,
      status: terminalStatus ?? (filled > 0 ? "partial" : "pending"),
      ...(terminalStatus === "canceled" ? { canceledAt: nowFn() } : {}),
      ...(terminalStatus === "filled" ? { filledAt: nowFn() } : {}),
      lastReconciledAt: nowFn(),
    }).where(eq(microLiveOrderTable.id, row.id));
  }

  const refreshedFills = await db.select({
    orderId: microLiveFillTable.orderId,
    contracts: sql<number>`sum(${microLiveFillTable.contracts})::integer`,
    cost: sql<number>`sum(${microLiveFillTable.costCents})::integer`,
  }).from(microLiveFillTable).groupBy(microLiveFillTable.orderId);
  const expectedPosition = new Map<string, number>();
  for (const fill of refreshedFills) {
    const row = localRows.find((candidate) => candidate.id === fill.orderId);
    if (!row) return block("local_fill_without_parent_order");
    expectedPosition.set(row.marketTicker,
      (expectedPosition.get(row.marketTicker) ?? 0) +
      (row.side === "UP" ? 1 : -1) * Number(fill.contracts));
  }
  if (primaryMode) {
    for (const row of localRows) {
      if (!expectedPosition.has(row.marketTicker)) expectedPosition.set(row.marketTicker, 0);
    }
  }
  const actualPosition = new Map(account.positions.map((position) =>
    [position.ticker, Number(position.positionFp)] as const));
  const positionTickers = primaryMode
    ? new Set([...expectedPosition.keys(), evaluation.marketTicker])
    : new Set([...expectedPosition.keys(), ...actualPosition.keys()]);
  if ([...positionTickers].some((ticker) =>
    !Number.isFinite(actualPosition.get(ticker) ?? 0) ||
    Math.abs((expectedPosition.get(ticker) ?? 0) - (actualPosition.get(ticker) ?? 0)) > 0.0001)) {
    if (primaryMode) await markPrimaryAccountingUnresolved("primary_market_position_conflict");
    return block("exchange_position_discrepancy");
  }

  const currentOrders = await db.select().from(microLiveOrderTable);
  const allCurrentFills = await db.select().from(microLiveFillTable);
  const gateLedger = reconstructMicroLivePositions({
    orders: currentOrders,
    fills: allCurrentFills,
  });
  if (gateLedger.anomalies.length) {
    return block(`micro_live_ledger_anomaly_${gateLedger.anomalies[0]!.code}`);
  }
  const openPositions = gateLedger.positions.filter((position) =>
    !position.closed && (position.contractsBought > position.contractsSold ||
      position.outstandingSellContracts > 0 || position.reservedBuyRiskCents > 0));
  if (openPositions.length > config.maxOpenPositions) return block("micro_live_open_position_limit_reached");
  if (openPositions.some((position) => position.marketTicker !== evaluation.marketTicker)) {
    return block("one_position_limit_reached");
  }
  if (openPositions.some((position) => {
    const positionOrders = currentOrders.filter((order) =>
      order.positionId === position.positionId || order.exitPositionId === position.positionId ||
      (!order.positionId && order.action === "buy" &&
        `position:${order.marketTicker}:${order.crossingKey}` === position.positionId));
    return positionOrders.some((order) => order.crossingKey !== evaluation.crossingKey);
  })) return block("different_crossing_already_has_open_position");
  if (evaluation.signal === "SCOUT" && openPositions.length > 0) {
    return block("one_market_position_action_sequence_violation");
  }
  const reservedRisk = gateLedger.effectiveCommittedRiskCents;
  const entrySignal = evaluation.signal === "CONFIRM" ? "CONFIRM" as const : "SCOUT" as const;
  const entryDirection = evaluation.direction === "DOWN" ? "DOWN" as const : "UP" as const;
  const stakeLimit = Math.min(
    entrySignal === "CONFIRM"
      ? config.maxConfirmAdditionalStakeCents
      : config.maxScoutStakeCents,
    config.maxSingleOrderRiskCents,
  );
  if (stakeLimit <= 0 || reservedRisk > 500) {
    return block("micro_live_risk_limit_reached");
  }
  const price = quotePrice(book, evaluation.direction);
  const cap = evaluation.signal === "CONFIRM" ? 0.68 : 0.60;
  const referenceOffer = evaluation.entryOffer;
  if (!Number.isFinite(price) || price <= 0 || price > cap) return block("quote_above_v13_entry_cap");
  if (referenceOffer === null || !Number.isFinite(referenceOffer) ||
      price > referenceOffer) return block("quote_above_reference_offer");
  const maximumExecutionPrice = Math.min(cap, referenceOffer);
  const executionPlan = executableEntryPlan(
    book, entrySignal, entryDirection, stakeLimit, maximumExecutionPrice,
  );
  if (!executionPlan) return block("insufficient_available_cash_or_contracts");
  let contracts = executionPlan.contracts;
  const submittedPrice = executionPlan.limitPrice.toFixed(4);
  const submittedPriceMicros = dollarsToMicros(submittedPrice);
  if (submittedPriceMicros === null || Number(submittedPrice) > cap ||
      Number(submittedPrice) > referenceOffer ||
      !Number.isSafeInteger(contracts * submittedPriceMicros)) {
    return block("entry_limit_price_unverifiable");
  }
  let requestedStakeCents = Math.ceil(contracts * submittedPriceMicros / 10_000);
  // A second entry (including CONFIRM) cannot inherit an unreserved exit fee.
  // Count every prior buy conservatively, even if it later closed.
  const capOrders = await db.select().from(microLiveOrderTable);
  const capFills = dedicatedPairMode
    ? await db.select().from(microLiveFillTable) : null;
  const feeLedgerFingerprint = capFills
    ? ledgerFingerprint(capOrders, capFills) : null;
  const committedCashCents = capOrders.filter((row) =>
    row.action === "buy" && row.status !== "rejected")
    .reduce((sum, row) => sum + row.requestedStakeCents, 0);
  const feeInput = {
    ticker: evaluation.marketTicker,
    side: evaluation.direction === "UP" ? "yes" as const : "no" as const,
    count: contracts,
    priceDollars: submittedPrice,
  };
  let feeReservation: Awaited<ReturnType<typeof feeCapForEntry>> = null;
  while (contracts > 0) {
    requestedStakeCents = Math.ceil(contracts * submittedPriceMicros / 10_000);
    feeInput.count = contracts;
    feeReservation = await feeCapForEntry(dependencies, capOrders,
      committedCashCents, requestedStakeCents, feeInput, undefined,
      primaryMode || dedicatedPairMode
        ? config.microLiveRunCapMicros : LIVE_TEST_CAP_MICROS);
    if (feeReservation) break;
    contracts--;
  }
  if (!feeReservation) return block("live_test_fee_ceiling_unavailable_or_cap_exceeded");
  if ((primaryMode || dedicatedPairMode) && (!config.microLiveRunApprovalId ||
      !config.microLiveRunApprovalDigest ||
      !feeEvidenceMatchesApproval(feeReservation.fingerprint, {
        id: config.microLiveRunApprovalId, digest: config.microLiveRunApprovalDigest,
      }))) return block("bounded_run_fee_evidence_not_approved");
  const feeApprovalPreflight = dedicatedPairMode
    ? await feeApprovalAtBarrier(config, dependencies) : null;
  if (dedicatedPairMode &&
      (!feeApprovalAllowsRun(feeApprovalPreflight,
          config.microLiveRunCapMicros, dependencies) ||
       !sameFeeApproval(feeApprovalPreflight, feeReservation.approval))) {
    return block("live_fee_approval_changed");
  }
  const reservedCashCents = Math.ceil(feeReservation.allInMicros / 10_000);
  if (reservedCashCents > Math.floor(cash * 100 + 1e-8)) {
    return block("insufficient_available_cash_or_contracts");
  }
  if (reservedCashCents > stakeLimit ||
      reservedCashCents + reservedRisk > 500 ||
      reservedCashCents + reservedRisk > config.maxLiveBankrollCents ||
      reservedCashCents + reservedRisk > config.maxCumulativeReservedCents) {
    return block("micro_live_risk_limit_reached");
  }

  const actionKey = createHash("sha256").update([
    evaluation.marketTicker, evaluation.crossingKey, evaluation.signal,
  ].join("\u001f")).digest("hex");
  const orderId = randomUUID();
  const clientOrderId = `ml-${actionKey.slice(0, 40)}`;
  let dedicatedPairPostProof: DedicatedPairPostProof | undefined;
  if (dedicatedPairMode) {
    const proof = await captureDedicatedPairPostProof(
      config, orderId, evaluation.marketTicker, "entry", "ENTRY_OPEN", dependencies,
    );
    if (!proof.proof) {
      return block(proof.reason ?? "dedicated_pair_collateral_proof_unavailable");
    }
    dedicatedPairPostProof = proof.proof;
  }
  const row = {
    id: orderId, actionKey, clientOrderId, marketTicker: evaluation.marketTicker,
    crossingKey: evaluation.crossingKey, triggerType: evaluation.signal,
    side: evaluation.direction, sourceEvaluationId: evaluation.id,
    signalAt: evaluation.evaluatedAt, btcSignalPrice: btc.price, target: evaluation.target,
    orderbookQuotePrice: price, quoteObservedAt: new Date(quoteAt),
     requestedLimitPrice: Number(submittedPrice), requestedContracts: contracts,
    requestedStakeCents, reservedRiskCents: requestedStakeCents,
    microLiveRunId: primaryMode || dedicatedPairMode ? config.microLiveRunId! : randomUUID(),
    reservedEntryFeeMicros: feeReservation.entryFeeMicros,
    reservedExitFeeMicros: feeReservation.exitFeeMicros,
    feeEvidenceFingerprint: feeReservation.fingerprint,
    feeEvidenceVerifiedAt: new Date(feeReservation.verifiedAt),
    remainingContracts: contracts, status: "pending", lastReconciledAt: nowFn(),
  } as const;
  let reservationFingerprint: string | null;
  try {
    reservationFingerprint = await db.transaction(async (tx) => {
      const [lockedConfig] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [runCapBoundary] = dedicatedPairMode && lockedConfig?.microLiveSelectedSubaccount
        ? await tx.select().from(microLivePairBoundaryTable)
          .where(eq(
            microLivePairBoundaryTable.subaccountNumber,
            lockedConfig.microLiveSelectedSubaccount,
          )).for("update").limit(1)
        : [];
      if (dedicatedPairMode) {
        await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
          ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
      }
      if (!lockedConfig || lockedConfig.manualKillSwitch ||
          !lockedConfig.microLiveProductionEnabled || !lockedConfig.liveExecutionEnabled ||
           !accountBindingMatchesConfig(lockedConfig, binding) ||
           lockedConfig.maxOpenPositions < 1 || lockedConfig.microLiveEntryAttempted ||
           lockedConfig.microLiveReservedMicros !== 0) return null;
       if ((primaryMode || dedicatedPairMode) && (
          lockedConfig.microLiveRunId !== config.microLiveRunId ||
          lockedConfig.microLiveRunPhase !== "ENTRY_OPEN" ||
           lockedConfig.microLiveRunCapMicros !== config.microLiveRunCapMicros ||
           !runCapMatchesAudit(lockedConfig,
             await tx.select({
               priorRunId: microLiveRunArchiveTable.priorRunId,
               successorRunId: microLiveRunArchiveTable.successorRunId,
              }).from(microLiveRunArchiveTable), runCapBoundary) ||
          !lockedConfig.microLiveRunArmedAt || evaluation.evaluatedAt <= lockedConfig.microLiveRunArmedAt ||
          lockedConfig.microLiveExitAttempted ||
          lockedConfig.microLiveRunApprovalId !== config.microLiveRunApprovalId ||
          lockedConfig.microLiveRunApprovalDigest !== config.microLiveRunApprovalDigest)) return null;
        const existingOrders = await tx.select().from(microLiveOrderTable);
        const existingFills = await tx.select().from(microLiveFillTable);
        if (dedicatedPairMode &&
            ledgerFingerprint(existingOrders, existingFills) !== feeLedgerFingerprint) return null;
       if (lockedConfig.microLiveAccountMode === null && existingOrders.length) return null;
       const allBuys = await tx.select().from(microLiveOrderTable)
         .where(eq(microLiveOrderTable.action, "buy"));
       // Existing/historical orders without this control's immutable proof are
       // never eligible to inherit a fresh development budget.
       if (allBuys.length) return null;
      const lockedActive = (await tx.select().from(microLiveOrderTable)
        .where(inArray(microLiveOrderTable.status, ["pending", "unknown", "partial", "filled", "canceled"])))
        .filter(activeOrder);
      if (lockedActive.some((open) => open.marketTicker !== evaluation.marketTicker ||
          open.crossingKey !== evaluation.crossingKey || open.status === "unknown")) return null;
        const lockedLedger = reconstructMicroLivePositions({
          orders: existingOrders, fills: existingFills,
        });
       if (lockedLedger.anomalies.length ||
           lockedLedger.effectiveCommittedRiskCents + reservedCashCents > 500 ||
           lockedLedger.effectiveCommittedRiskCents + reservedCashCents > lockedConfig.maxLiveBankrollCents ||
           lockedLedger.effectiveCommittedRiskCents + reservedCashCents > lockedConfig.maxCumulativeReservedCents) return null;
          const lockedFeeApproval = dedicatedPairMode
            ? feeApprovalFromConfig(lockedConfig)
            : await feeApprovalAtBarrier(lockedConfig, dependencies);
         if (!feeApprovalAllowsRun(lockedFeeApproval,
               primaryMode || dedicatedPairMode
                 ? lockedConfig.microLiveRunCapMicros : LIVE_TEST_CAP_MICROS,
              dependencies) ||
             !sameFeeApproval(lockedFeeApproval, feeReservation.approval)) {
            return null;
          }
          const lockedOrders = await tx.select().from(microLiveOrderTable);
          const committedCash = lockedOrdersCash(lockedOrders);
          const lockedFeeReservation = dedicatedPairMode
            ? feeReservation
            : await feeCapForEntry(dependencies, lockedOrders, committedCash,
              requestedStakeCents, feeInput, feeReservation.fingerprint,
              primaryMode ? lockedConfig.microLiveRunCapMicros : LIVE_TEST_CAP_MICROS);
          if (!lockedFeeReservation ||
              lockedFeeReservation.entryFeeMicros !== feeReservation.entryFeeMicros ||
              lockedFeeReservation.exitFeeMicros !== feeReservation.exitFeeMicros ||
              lockedFeeReservation.allInMicros !== feeReservation.allInMicros) return null;
          if (primaryMode && !feeEvidenceMatchesApproval(lockedFeeReservation.fingerprint, {
          id: lockedConfig.microLiveRunApprovalId ?? "",
          digest: lockedConfig.microLiveRunApprovalDigest ?? "",
         })) return null;
          if (!sameFeeApproval(lockedFeeReservation.approval, feeReservation.approval) ||
              !feeApprovalAllowsRun(lockedFeeReservation.approval,
                primaryMode || dedicatedPairMode
                  ? lockedConfig.microLiveRunCapMicros : LIVE_TEST_CAP_MICROS,
                dependencies) ||
              !feeEvidenceMatchesApproval(lockedFeeReservation.fingerprint,
                lockedFeeReservation.approval)) return null;
      // V13 paper uses SCOUT and CONFIRM as alternative first-entry triggers.
      // A live run therefore permits exactly one initial buy for either signal.
      // Position-sourced CONFIRM add-ons are rejected by the isInitialEntry gate.
      if (lockedActive.length > 0) return null;
      const [created] = await tx.insert(microLiveOrderTable).values(row)
        .onConflictDoNothing().returning({ id: microLiveOrderTable.id });
      if (!created) return null;
       await tx.update(microLiveConfigTable).set({
          microLiveAccountMode: binding.mode,
          microLiveSelectedSubaccount: binding.subaccount,
           ...(primaryMode || dedicatedPairMode ? {} : { microLiveRunId: row.microLiveRunId }),
         microLiveEntryAttempted: true,
         microLiveReservedMicros: feeReservation.allInMicros,
       }).where(eq(microLiveConfigTable.id, "singleton"));
      return ledgerFingerprint(
        await tx.select().from(microLiveOrderTable),
        await tx.select().from(microLiveFillTable),
      );
    });
  } catch {
    reservationFingerprint = null;
  }
  if (!reservationFingerprint) return block("atomic_action_reservation_conflict_or_gate_changed");

  const submit = dependencies.submitOrder;
  type SubmissionResult =
    | { type: "blocked" }
    | { type: "submitted"; placed: KalshiOrder }
    | { type: "error"; error: unknown; ambiguous: boolean };
  let submission: SubmissionResult;
  let postInvoked = false;
  try {
    await dependencies.beforeSubmissionInterlock?.();
  } catch {
    const failure = "submission_interlock_failed";
    startupReadiness = { ready: false, checkedAt: 0, reason: failure };
    await db.update(microLiveOrderTable).set({
      status: "rejected", reservedRiskCents: 0, failureReason: failure,
    }).where(eq(microLiveOrderTable.id, orderId));
    await emergencyStopMicroLive();
    return persistDecision(decision(evaluationId, failure, "blocked", nowFn()), orderId);
  }
  let preflightFailure: string | null;
  try {
    preflightFailure = await freshOwnershipPreflight(
      orderId, dependencies, nowFn, dedicatedPairPostProof,
    );
  } catch {
    preflightFailure = "account_history_read_failed";
    if (binding.mode === "primary_nonexclusive") {
      await markPrimaryAccountingUnresolved(preflightFailure);
    }
  }
  if (preflightFailure) {
    startupReadiness = { ready: false, checkedAt: 0, reason: preflightFailure };
    await db.update(microLiveOrderTable).set({
      status: "rejected", reservedRiskCents: 0, failureReason: preflightFailure,
    }).where(eq(microLiveOrderTable.id, orderId));
    await emergencyStopMicroLive();
    return persistDecision(decision(evaluationId, preflightFailure, "blocked", nowFn()), orderId);
  }
  let dedicatedFinalFeeReservation: Awaited<ReturnType<typeof feeCapForEntry>> = null;
  if (dedicatedPairMode) {
    const finalOrders = (await db.select().from(microLiveOrderTable))
      .filter((entry) => entry.id !== orderId);
    try {
      dedicatedFinalFeeReservation = await feeCapForEntry(
        dependencies, finalOrders, lockedOrdersCash(finalOrders),
        requestedStakeCents, feeInput, feeReservation.fingerprint,
        config.microLiveRunCapMicros,
      );
    } catch {
      dedicatedFinalFeeReservation = null;
    }
  }
  try {
    submission = await db.transaction(async (tx) => {
      // Emergency stop updates this same singleton row. Holding its row lock
      // from the final gate check through the bounded Kalshi POST makes stop
      // and submit mutually ordered without coupling the ledger reservation.
      const [lockedConfig] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [runCapBoundary] = dedicatedPairMode && lockedConfig?.microLiveSelectedSubaccount
        ? await tx.select().from(microLivePairBoundaryTable)
          .where(eq(
            microLivePairBoundaryTable.subaccountNumber,
            lockedConfig.microLiveSelectedSubaccount,
          )).for("update").limit(1)
        : [];
       if (dedicatedPairMode) {
         await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
           ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
       }
      const [settled] = await tx.select({ positionId: microLiveSettlementTable.positionId })
        .from(microLiveSettlementTable).limit(1);
      const [engine] = await tx.select({
        enabled: forwardTestEngineTable.enabled,
        strategyVersion: forwardTestEngineTable.strategyVersion,
        leaseOwner: forwardTestEngineTable.leaseOwner,
        leaseExpiresAt: forwardTestEngineTable.leaseExpiresAt,
      }).from(forwardTestEngineTable)
        .where(eq(forwardTestEngineTable.id, FORWARD_TEST_ENGINE_ID)).limit(1);
      const latestLeaseHeld = Boolean(engine?.enabled && engine.strategyVersion === "V1.3" &&
        engine.leaseOwner && engine.leaseExpiresAt &&
         engine.leaseExpiresAt.getTime() > nowFn().getTime() &&
         (!primaryMode || (boundedWorkerLeaseEvidence?.owner === engine.leaseOwner &&
           boundedWorkerLeaseEvidence.expiresAt > nowFn().getTime() &&
           nowFn().getTime() - boundedWorkerLeaseEvidence.observedAt <= FRESHNESS_MS)));
      if (settled || !lockedConfig || lockedConfig.manualKillSwitch ||
           !accountBindingMatchesConfig(lockedConfig, binding) ||
          !lockedConfig.microLiveProductionEnabled || !lockedConfig.liveExecutionEnabled ||
          !latestLeaseHeld || !environmentFlags().microLiveProductionEnabled ||
          !environmentFlags().liveExecutionEnabled ||
          !readinessIsCurrent(nowFn().getTime())) {
        return { type: "blocked" } as const;
      }
        if ((primaryMode || dedicatedPairMode) && (
           lockedConfig.microLiveRunId !== row.microLiveRunId ||
           lockedConfig.microLiveRunPhase !== "ENTRY_OPEN" ||
            lockedConfig.microLiveRunCapMicros !== config.microLiveRunCapMicros ||
            !runCapMatchesAudit(lockedConfig,
              await tx.select({
                priorRunId: microLiveRunArchiveTable.priorRunId,
                successorRunId: microLiveRunArchiveTable.successorRunId,
              }).from(microLiveRunArchiveTable), runCapBoundary) ||
           lockedConfig.microLiveEntryAttempted !== true ||
           lockedConfig.microLiveExitAttempted ||
           lockedConfig.microLiveRunApprovalId !== config.microLiveRunApprovalId ||
           lockedConfig.microLiveRunApprovalDigest !== config.microLiveRunApprovalDigest)) {
         return { type: "blocked" } as const;
       }
      // No other worker may change the ledger between our reservation and POST.
      // A differing snapshot could invalidate the account read or risk budget.
      if (ledgerFingerprint(
        await tx.select().from(microLiveOrderTable),
        await tx.select().from(microLiveFillTable),
      ) !== reservationFingerprint) {
        return { type: "blocked" } as const;
      }
        if (dedicatedPairMode && (!dedicatedPairPostProof ||
            dedicatedPairPostProof.action !== "entry" ||
            dedicatedPairPostProof.ticker !== evaluation.marketTicker ||
            dedicatedPairPostProof.configIdentityFingerprint !==
              dedicatedPairConfigIdentityFingerprint(lockedConfig) ||
            nowFn().getTime() - dedicatedPairPostProof.proof.checkedAt < 0 ||
            nowFn().getTime() - dedicatedPairPostProof.proof.checkedAt > 5_000)) {
          return { type: "blocked" } as const;
        }
        if (dedicatedPairMode) {
          const [lockedBoundary] = await tx.select().from(microLivePairBoundaryTable)
            .where(eq(
              microLivePairBoundaryTable.subaccountNumber,
              lockedConfig.microLiveSelectedSubaccount!,
            )).for("update").limit(1);
          if (!lockedBoundary || lockedBoundary.state !== "initialized" ||
              lockedBoundary.ambiguityFrozenAt ||
              lockedBoundary.initializedRunId !== lockedConfig.microLiveRunId ||
              lockedBoundary.cleanBoundaryEvidenceDigest !==
                dedicatedPairPostProof!.proof.boundaryEvidenceDigest ||
              lockedBoundary.restrictedApiKeyId !== lockedConfig.microLiveRestrictedApiKeyId ||
              lockedBoundary.restrictedKeyFingerprint !==
                lockedConfig.microLiveRestrictedKeyFingerprint ||
              lockedBoundary.fundingTransferId !== lockedConfig.microLiveFundingAnchorTransferId ||
              !dedicatedShardTwoIdentityMatchesConfig(lockedConfig, binding)) {
            return { type: "blocked" } as const;
          }
          const [lockedOrders, lockedFills, lockedSettlements] = await Promise.all([
            tx.select().from(microLiveOrderTable),
            tx.select().from(microLiveFillTable),
            tx.select().from(microLiveSettlementTable),
          ]);
          if (dedicatedPairLedgerFingerprintFrom(
            lockedOrders.filter((entry) => entry.id !== orderId),
            lockedFills,
            lockedSettlements,
          ) !== dedicatedPairPostProof!.localLedgerFingerprint) {
            return { type: "blocked" } as const;
          }
        }
        const finalOrders = dedicatedPairMode
          ? null
          : (await tx.select().from(microLiveOrderTable))
            .filter((entry) => entry.id !== orderId);
        const finalFeeReservation = dedicatedPairMode
          ? dedicatedFinalFeeReservation
          : finalOrders ? await feeCapForEntry(
            dependencies, finalOrders, lockedOrdersCash(finalOrders),
            requestedStakeCents, feeInput, feeReservation.fingerprint,
            primaryMode ? lockedConfig.microLiveRunCapMicros : LIVE_TEST_CAP_MICROS,
          ) : null;
        if (!finalFeeReservation ||
            finalFeeReservation.entryFeeMicros !== feeReservation.entryFeeMicros ||
            finalFeeReservation.exitFeeMicros !== feeReservation.exitFeeMicros ||
            finalFeeReservation.allInMicros !== feeReservation.allInMicros) {
          return { type: "blocked" } as const;
        }
        const [reservedEntry] = await tx.select().from(microLiveOrderTable)
          .where(eq(microLiveOrderTable.id, orderId)).for("update").limit(1);
        if (reservedEntry?.status !== "pending" ||
            reservedEntry.action !== "buy" ||
            reservedEntry.marketTicker !== evaluation.marketTicker ||
            !orderFeeProofMatches(reservedEntry, {
              runId: row.microLiveRunId,
              entryFeeMicros: feeReservation.entryFeeMicros,
              exitFeeMicros: feeReservation.exitFeeMicros,
              fingerprint: feeReservation.fingerprint,
              verifiedAt: feeReservation.verifiedAt,
            })) {
          return { type: "blocked" } as const;
        }
        const [refreshedEntry] = await tx.update(microLiveOrderTable).set({
          feeEvidenceVerifiedAt: new Date(finalFeeReservation.verifiedAt),
        }).where(eq(microLiveOrderTable.id, orderId)).returning();
        if (refreshedEntry?.status !== "pending" ||
            !orderFeeProofMatches(refreshedEntry, {
              runId: row.microLiveRunId,
              entryFeeMicros: finalFeeReservation.entryFeeMicros,
              exitFeeMicros: finalFeeReservation.exitFeeMicros,
              fingerprint: finalFeeReservation.fingerprint,
              verifiedAt: finalFeeReservation.verifiedAt,
            })) {
          return { type: "blocked" } as const;
        }
         // Lock the exact fresh runtime metadata proof after all reservation
         // writes, then hold both gate and config locks through the POST.
         const finalApproval = await feeApprovalAtBarrier(
           lockedConfig, dependencies, tx, finalFeeReservation,
         );
          if (!feeApprovalAllowsRun(finalApproval,
                primaryMode || dedicatedPairMode
                  ? lockedConfig.microLiveRunCapMicros : LIVE_TEST_CAP_MICROS,
               dependencies) ||
             !sameFeeApproval(finalApproval, feeReservation.approval) ||
             !feeEvidenceMatchesApproval(feeReservation.fingerprint, finalApproval) ||
             !feeEvidenceMatchesApproval(finalFeeReservation.fingerprint, finalApproval)) {
           return { type: "blocked" } as const;
         }
       const entryInput: KalshiLimitOrderRequest = {
         ticker: evaluation.marketTicker,
         clientOrderId,
         side: evaluation.direction === "UP" ? "yes" : "no",
         action: "buy",
         count: contracts,
         priceDollars: submittedPrice,
       };
       const submissionContext = {
         databaseEnabled: true as const,
         killSwitch: "OFF" as const,
         leaseHeld: true as const,
         reconciled: true as const,
       };
       const submissionCapability = submit ? null :
         await authorizeKalshiSubmission(tx, entryInput, {
           orderId,
           reconciled: readinessIsCurrent(nowFn().getTime()),
           reconciledAt: startupReadiness.checkedAt,
            leaseOwner: engine.leaseOwner ?? "",
           leaseObservedAt: boundedWorkerLeaseEvidence?.observedAt ?? nowFn().getTime(),
           leaseExpiresAt: engine.leaseExpiresAt!.getTime(),
            isStillReconciled: () => readinessIsCurrent(nowFn().getTime()),
         }, nowFn().getTime());
       if (!submit && !submissionCapability) return { type: "blocked" } as const;
      try {
        postInvoked = true;
         const placed = submit
           ? await submit(entryInput, submissionContext)
            : await createMicroLiveTradingClient(dedicatedPairPostProof)
             .createLimitOrder(entryInput, submissionContext, submissionCapability!);
        return { type: "submitted", placed } as const;
      } catch (error) {
        const failure = error instanceof Error ? error.message : "submission_result_unknown";
        const ambiguous = !/HTTP_ERROR.*(?:400|401|403|404|409|422)/.test(failure);
        if (ambiguous) {
          await tx.update(microLiveConfigTable).set({
            manualKillSwitch: true,
            microLiveProductionEnabled: false,
            liveExecutionEnabled: false,
          }).where(eq(microLiveConfigTable.id, "singleton"));
        }
        return { type: "error", error, ambiguous } as const;
      }
    });
  } catch (error) {
    submission = { type: "error", error, ambiguous: postInvoked };
  }
  if (submission.type === "blocked") {
    await db.update(microLiveOrderTable).set({
      status: "rejected", reservedRiskCents: 0, failureReason: "submission_gate_changed",
    }).where(eq(microLiveOrderTable.id, orderId));
    return persistDecision(decision(evaluationId, "submission_gate_changed", "blocked", nowFn()), orderId);
  }
  if (submission.type === "error") {
    const { error, ambiguous } = submission;
    const failure = error instanceof Error ? error.message : "submission_result_unknown";
    await db.update(microLiveOrderTable).set({
      status: ambiguous ? "unknown" : "rejected",
      reservedRiskCents: ambiguous ? requestedStakeCents : 0,
      failureReason: ambiguous ? "ambiguous_submission_result_freezes_live" : "exchange_rejected_order",
    }).where(eq(microLiveOrderTable.id, orderId));
    if (ambiguous) {
      if (binding.mode === "primary_nonexclusive") {
        await markPrimaryAccountingUnresolved("primary_uncertain_submission_result");
      }
      await emergencyStopMicroLive();
    }
    return persistDecision(decision(evaluationId, ambiguous
      ? "ambiguous_submission_result_freezes_live" : "exchange_rejected_order",
    ambiguous ? "unknown" : "rejected", nowFn()), orderId);
  }
  const placed = submission.placed;
  const remainingContracts = Number(placed.remainingCount);
  const validRemaining = Number.isSafeInteger(remainingContracts) &&
    remainingContracts >= 0 && remainingContracts <= contracts;
  if (!validRemaining) {
    await db.update(microLiveOrderTable).set({
      status: "unknown", failureReason: "invalid_submission_order_state",
    }).where(eq(microLiveOrderTable.id, orderId));
    if (binding.mode === "primary_nonexclusive") {
      await markPrimaryAccountingUnresolved("primary_invalid_submission_order_state");
    }
    await emergencyStopMicroLive();
    return persistDecision(
      decision(evaluationId, "invalid_submission_order_state_freezes_live", "unknown", nowFn()), orderId,
    );
  }
  await db.update(microLiveOrderTable).set({
    exchangeOrderId: placed.orderId,
    status: "pending",
    submittedAt: nowFn(),
    remainingContracts,
    // Keep the full reservation until a complete account/order/fill read
    // confirms execution or cancellation and the corresponding fills.
    reservedRiskCents: requestedStakeCents,
    failureReason: null,
  }).where(eq(microLiveOrderTable.id, orderId));
  const accepted = {
    ...decision(evaluationId, "order_submitted_waiting_for_confirmed_fill", "submitted", nowFn()),
    orderId: placed.orderId,
  };
  try {
    return await persistDecision(accepted, orderId);
  } catch {
    await db.update(microLiveOrderTable).set({
      status: "unknown", failureReason: "decision_audit_write_failed_after_submission",
    }).where(eq(microLiveOrderTable.id, orderId));
    if (binding.mode === "primary_nonexclusive") {
      await markPrimaryAccountingUnresolved("primary_submission_audit_write_uncertain");
    }
    await emergencyStopMicroLive();
    return decision(evaluationId, "decision_audit_write_failed_freezes_live", "unknown", nowFn());
  }
}