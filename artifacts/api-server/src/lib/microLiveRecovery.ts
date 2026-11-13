import { createHash, randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import {
  db, microLiveConfigTable, microLiveDecisionTable, microLiveFillTable, microLiveOrderTable,
} from "@workspace/db";
import {
  getConfiguredKalshiSubaccount, readKalshiAccount, readKalshiDedicatedPairEvidence,
  readKalshiSubmissionEvidence, type KalshiAccountSnapshot,
  type KalshiDedicatedPairEvidence, type KalshiSubmissionEvidence,
} from "./kalshiAccountClient";
import {
  compatibleOptionalDirection, compatibleOptionalPrice, microLiveOrderLegFillPrice,
} from "./microLiveFillNormalization";
import {
  cancelAndVerifyMicroLiveExit,
  type MicroLiveDependencies,
} from "./microLive";

function accountBindingMatches(config: typeof microLiveConfigTable.$inferSelect): boolean {
  const mode = process.env.MICRO_LIVE_ACCOUNT_MODE?.trim() || "exclusive";
  if (mode !== "exclusive" && mode !== "primary_nonexclusive") return false;
  try {
    const subaccount = getConfiguredKalshiSubaccount();
    if (config.microLiveAccountMode !== mode ||
        config.microLiveSelectedSubaccount !== subaccount) return false;
    if (mode === "primary_nonexclusive") {
      return subaccount === 0 && config.microLiveSelectedExchangeIndex === null &&
        config.microLiveRestrictedApiKeyId === null &&
        config.microLiveRestrictedKeyFingerprint === null &&
        config.microLiveFundingAnchorSubaccount === null &&
        config.microLiveFundingAnchorExchangeIndex === null &&
        config.microLiveFundingAnchorTransferId === null &&
        config.microLiveFundingAnchorTransferAt === null &&
        config.microLiveFundingAnchorAmountCents === null &&
        config.microLivePairCashBaselineMicros === null &&
        config.microLivePairCashBaselineRunId === null &&
        config.microLivePairCashBaselineAt === null &&
        config.microLivePairCashBaselineEvidenceDigest === null &&
        config.microLiveAccountActivityCheckpointRunId === null &&
        config.microLiveAccountActivityCheckpointCursor === null &&
        config.microLiveAccountActivityCheckpointAt === null &&
        config.microLiveAccountActivityCheckpointEvidenceDigest === null &&
        config.microLiveAccountActivityCheckpointSubaccount === null &&
        config.microLiveAccountActivityCheckpointExchangeIndex === null;
    }
    if (subaccount < 1 || subaccount > 63) return false;
    // Legacy exclusive runs remain eligible for their existing GET-only
    // reconciliation, but never for dedicated shard-2 identity verification.
    if (config.microLiveSelectedExchangeIndex !== 2) return true;
    return config.microLiveRestrictedApiKeyId !== null &&
      config.microLiveRestrictedApiKeyId.trim() !== "" &&
      config.microLiveRestrictedKeyFingerprint !== null &&
      /^[0-9a-f]{64}$/.test(config.microLiveRestrictedKeyFingerprint) &&
      config.microLiveFundingAnchorSubaccount === subaccount &&
      config.microLiveFundingAnchorExchangeIndex === 2 &&
      config.microLiveFundingAnchorTransferId !== null &&
      config.microLiveFundingAnchorTransferId.trim() !== "" &&
      config.microLiveFundingAnchorTransferAt !== null &&
      config.microLiveFundingAnchorAmountCents === 2500 &&
      config.microLivePairCashBaselineMicros === "25000000" &&
      config.microLivePairCashBaselineRunId === config.microLiveRunId &&
      config.microLivePairCashBaselineAt !== null &&
      config.microLivePairCashBaselineEvidenceDigest !== null &&
      /^[0-9a-f]{64}$/.test(config.microLivePairCashBaselineEvidenceDigest) &&
      config.microLiveAccountActivityCheckpointRunId === config.microLiveRunId &&
      config.microLiveAccountActivityCheckpointCursor !== null &&
      config.microLiveAccountActivityCheckpointCursor.trim() !== "" &&
      config.microLiveAccountActivityCheckpointAt !== null &&
      config.microLiveAccountActivityCheckpointEvidenceDigest !== null &&
      /^[0-9a-f]{64}$/.test(config.microLiveAccountActivityCheckpointEvidenceDigest) &&
      config.microLiveAccountActivityCheckpointSubaccount === subaccount &&
      config.microLiveAccountActivityCheckpointExchangeIndex === 2;
  } catch {
    return false;
  }
}

function explicitExchangeIndex(record: unknown): number | null {
  if (!record || typeof record !== "object") return null;
  const value = record as Record<string, unknown>;
  const index = value.exchangeIndex ?? value.exchange_index;
  return typeof index === "number" && Number.isSafeInteger(index) ? index : null;
}

function dedicatedPairEvidenceMatches(
  evidence: KalshiDedicatedPairEvidence | null,
  subaccountNumber: number,
  ticker: string,
): evidence is KalshiDedicatedPairEvidence {
  if (!evidence || evidence.pair.subaccountNumber !== subaccountNumber ||
      evidence.pair.exchangeIndex !== 2 || evidence.marketExchangeIndex !== 2 ||
      evidence.balance.subaccountNumber !== subaccountNumber ||
      evidence.balance.exchangeIndex !== 2 ||
      !evidence.keyRestrictionVerified || !evidence.tradePermissionVerified) return false;
  const startedAt = Date.parse(evidence.scanStartedAt);
  const finishedAt = Date.parse(evidence.scanFinishedAt);
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt) &&
    startedAt <= finishedAt && finishedAt <= Date.now() &&
    Date.now() - finishedAt <= 5_000 &&
    Object.values(evidence.recordCounts).every((count) =>
      Number.isSafeInteger(count) && count >= 0) &&
    /^KXBTC15M[A-Za-z0-9._-]*$/.test(ticker);
}

export type UncertainRecoveryResult = {
  status: "blocked" | "linked_needs_reconciliation";
  reason: string;
  orderId: string;
};

export type UncertainRecoveryDependencies = {
  readEvidence?: (ticker: string) => Promise<KalshiSubmissionEvidence>;
  readAccount?: () => Promise<KalshiAccountSnapshot>;
  readDedicatedPairEvidence?: (
    subaccountNumber: number,
    ticker: string,
  ) => Promise<KalshiDedicatedPairEvidence>;
  afterEvidenceRead?: () => Promise<void>;
};

export type UncertainExitRecoveryResult = {
  status: "blocked" | "linked_and_cancel_checked";
  reason: string;
  orderId: string;
};

export type UncertainExitRecoveryDependencies = UncertainRecoveryDependencies & {
  /** Test seam; production uses the fail-closed identified-order path below. */
  cancelExit?: (localOrderId: string) => Promise<{ ready: false; reason: string }>;
  cancellationDependencies?: MicroLiveDependencies;
};

function matchesReservation(
  order: KalshiSubmissionEvidence["orders"][number],
  reserved: typeof microLiveOrderTable.$inferSelect,
) {
  const initial = Number(order.initialCount);
  const filled = Number(order.filledCount);
  const remaining = Number(order.remainingCount);
  const price = Number(order.priceDollars);
  return order.ticker === reserved.marketTicker &&
    order.side === (reserved.side === "UP" ? "yes" : "no") &&
    order.action === reserved.action && order.type === "limit" &&
    ["resting", "canceled", "executed"].includes(order.status) &&
    Number.isSafeInteger(initial) && initial === reserved.requestedContracts &&
    Number.isSafeInteger(filled) && filled >= 0 && filled <= initial &&
    Number.isSafeInteger(remaining) && remaining >= 0 && remaining <= initial &&
    Number.isFinite(price) &&
    Math.abs(price - reserved.requestedLimitPrice) < 0.0001;
}

function verifyEvidence(
  evidence: KalshiSubmissionEvidence,
  account: KalshiAccountSnapshot,
  reserved: typeof microLiveOrderTable.$inferSelect,
  expectedPair?: { subaccountNumber: number; exchangeIndex: 2 },
): { reason: string; exchangeOrderId?: string; fingerprint?: string } {
  if (evidence.truncated || evidence.historicalFillsAvailable !== true ||
      Object.values(account.truncated).some(Boolean)) {
    return { reason: "uncertain_recovery_snapshot_incomplete" };
  }
  const candidates = evidence.orders.filter((order) => order.clientOrderId === reserved.clientOrderId);
  if (candidates.length !== 1) {
    return { reason: candidates.length ? "uncertain_recovery_multiple_client_matches" :
      "uncertain_recovery_no_proven_client_match" };
  }
  const candidate = candidates[0]!;
  if (expectedPair) {
    const matchingHistoryOrders = evidence.orders.filter((order) =>
      order.ticker === reserved.marketTicker);
    const matchingCurrentFills = evidence.fills.filter((fill) =>
      fill.ticker === reserved.marketTicker);
    const matchingHistoricalFills = (evidence.historicalFills ?? []).filter((fill) =>
      fill.ticker === reserved.marketTicker);
    const matchingAccountOrders = account.openOrders.filter((order) =>
      order.ticker === reserved.marketTicker);
    const matchingAccountPositions = account.positions.filter((position) =>
      position.ticker === reserved.marketTicker);
    const matchingAccountFills = account.fills.filter((fill) =>
      fill.ticker === reserved.marketTicker);
    if (expectedPair.exchangeIndex !== 2 ||
        !Number.isSafeInteger(expectedPair.subaccountNumber) ||
        expectedPair.subaccountNumber < 1 ||
        expectedPair.subaccountNumber > 63 ||
        [...matchingHistoryOrders, ...matchingCurrentFills, ...matchingHistoricalFills,
          ...matchingAccountOrders, ...matchingAccountPositions, ...matchingAccountFills]
          .some((record) => explicitExchangeIndex(record) !== 2)) {
      return { reason: "uncertain_recovery_record_exchange_index_unproven" };
    }
  }
  if (!matchesReservation(candidate, reserved) ||
      evidence.orders.some((order) => order.id === candidate.id && order !== candidate)) {
    return { reason: "uncertain_recovery_order_identity_conflict" };
  }
  const filled = Number(candidate.filledCount);
  const remaining = Number(candidate.remainingCount);
  if ((candidate.status === "resting" &&
        filled + remaining !== reserved.requestedContracts) ||
      (candidate.status === "executed" &&
        ((filled !== reserved.requestedContracts && reserved.action !== "sell") ||
          remaining !== 0)) ||
      (candidate.status === "canceled" && remaining !== 0)) {
    return { reason: "uncertain_recovery_order_quantity_conflict" };
  }
  const matchedFills = evidence.fills.filter((fill) => fill.orderId === candidate.id);
  const historicalById = new Map((evidence.historicalFills ?? [])
    .map((fill) => [fill.id, fill]));
  const fillIds = new Set<string>();
  let total = 0;
  for (const fill of matchedFills) {
    const count = Number(fill.countFp);
    const legPrice = microLiveOrderLegFillPrice(fill, candidate);
    const price = Number(legPrice);
    if (fillIds.has(fill.id) || fill.ticker !== reserved.marketTicker ||
        fill.action !== reserved.action ||
        legPrice === null ||
        !Number.isSafeInteger(count) || count <= 0 ||
        !Number.isFinite(price) || price <= 0 || price > 1 ||
        (reserved.action === "buy"
          ? price > reserved.requestedLimitPrice + 0.0001
          : price < reserved.requestedLimitPrice - 0.0001) ||
        !fill.createdAt || !Number.isFinite(Date.parse(fill.createdAt))) {
      return { reason: "uncertain_recovery_fill_identity_conflict" };
    }
    fillIds.add(fill.id);
    total += count;
  }
  if (total !== Number(candidate.filledCount)) {
    return { reason: "uncertain_recovery_fills_not_reconcilable" };
  }
  for (const fill of matchedFills) {
    const current = account.fills.find((item) => item.id === fill.id);
    const historical = historicalById.get(fill.id);
    const sourceFill = current ?? historical;
    if (!sourceFill || (current === undefined &&
        (evidence.historicalFillsAvailable !== true || !historical))) {
      // A 404 or absent endpoint evidence is never interpreted as zero fills.
      return { reason: "uncertain_recovery_fills_not_reconcilable" };
    }
    if (sourceFill.orderId !== fill.orderId || sourceFill.ticker !== fill.ticker ||
        sourceFill.side !== fill.side || sourceFill.action !== fill.action ||
        Number(sourceFill.countFp) !== Number(fill.countFp) ||
        Number(sourceFill.priceDollars) !== Number(fill.priceDollars) ||
        !compatibleOptionalDirection(sourceFill, fill) ||
        !compatibleOptionalPrice(sourceFill.yesPriceDollars, fill.yesPriceDollars) ||
        !compatibleOptionalPrice(sourceFill.noPriceDollars, fill.noPriceDollars) ||
        sourceFill.createdAt !== fill.createdAt ||
        (sourceFill.feeCostDollars != null && fill.feeCostDollars != null &&
          Number(sourceFill.feeCostDollars) !== Number(fill.feeCostDollars))) {
      return { reason: "uncertain_recovery_fill_identity_conflict" };
    }
  }
  if (evidence.fills.some((fill) => fill.ticker === reserved.marketTicker &&
      fill.orderId !== candidate.id)) {
    return { reason: "uncertain_recovery_fill_identity_conflict" };
  }
  const open = account.openOrders.find((order) => order.id === candidate.id);
  if (candidate.status === "resting" &&
      (!open || open.ticker !== candidate.ticker || open.side !== candidate.side ||
        open.action !== candidate.action ||
        Number(open.remainingCount) !== Number(candidate.remainingCount) ||
        open.status !== "resting" ||
        open.priceDollars === null ||
        !Number.isFinite(Number(open.priceDollars)) ||
        Math.abs(Number(open.priceDollars) - reserved.requestedLimitPrice) >= 0.0001)) {
    return { reason: "uncertain_recovery_open_order_conflict" };
  }
  if (candidate.status !== "resting" && open) {
    return { reason: "uncertain_recovery_open_order_conflict" };
  }
  return {
    reason: "uncertain_recovery_exchange_id_linked_reconciliation_required",
    exchangeOrderId: candidate.id,
    fingerprint: createHash("sha256").update(JSON.stringify({
      order: candidate, fills: matchedFills,
    })).digest("hex"),
  };
}

export function verifyMicroLiveRecoveryEvidence(
  evidence: KalshiSubmissionEvidence,
  account: KalshiAccountSnapshot,
  reserved: typeof microLiveOrderTable.$inferSelect,
  expectedPair?: { subaccountNumber: number; exchangeIndex: 2 },
) {
  return verifyEvidence(evidence, account, reserved, expectedPair);
}

function dedicatedIdentityMatches(
  left: typeof microLiveConfigTable.$inferSelect,
  right: typeof microLiveConfigTable.$inferSelect,
): boolean {
  return left.microLiveAccountMode === right.microLiveAccountMode &&
    left.microLiveRunId === right.microLiveRunId &&
    left.microLiveSelectedSubaccount === right.microLiveSelectedSubaccount &&
    left.microLiveSelectedExchangeIndex === right.microLiveSelectedExchangeIndex &&
    left.microLiveRestrictedApiKeyId === right.microLiveRestrictedApiKeyId &&
    left.microLiveRestrictedKeyFingerprint === right.microLiveRestrictedKeyFingerprint &&
    left.microLiveFundingAnchorSubaccount === right.microLiveFundingAnchorSubaccount &&
    left.microLiveFundingAnchorExchangeIndex === right.microLiveFundingAnchorExchangeIndex &&
    left.microLiveFundingAnchorTransferId === right.microLiveFundingAnchorTransferId &&
    left.microLiveFundingAnchorTransferAt?.getTime() ===
      right.microLiveFundingAnchorTransferAt?.getTime() &&
    left.microLiveFundingAnchorAmountCents === right.microLiveFundingAnchorAmountCents &&
    left.microLivePairCashBaselineMicros === right.microLivePairCashBaselineMicros &&
    left.microLivePairCashBaselineRunId === right.microLivePairCashBaselineRunId &&
    left.microLivePairCashBaselineAt?.getTime() ===
      right.microLivePairCashBaselineAt?.getTime() &&
    left.microLivePairCashBaselineEvidenceDigest ===
      right.microLivePairCashBaselineEvidenceDigest &&
    left.microLiveAccountActivityCheckpointRunId ===
      right.microLiveAccountActivityCheckpointRunId &&
    left.microLiveAccountActivityCheckpointCursor ===
      right.microLiveAccountActivityCheckpointCursor &&
    left.microLiveAccountActivityCheckpointAt?.getTime() ===
      right.microLiveAccountActivityCheckpointAt?.getTime() &&
    left.microLiveAccountActivityCheckpointEvidenceDigest ===
      right.microLiveAccountActivityCheckpointEvidenceDigest &&
    left.microLiveAccountActivityCheckpointSubaccount ===
      right.microLiveAccountActivityCheckpointSubaccount &&
    left.microLiveAccountActivityCheckpointExchangeIndex ===
      right.microLiveAccountActivityCheckpointExchangeIndex;
}

/**
 * Explicit, fail-closed recovery-and-cancel for an ID-less sell exit. Identity
 * is proven from complete authenticated order/fill history and committed under
 * a row/config lock before delegating to the existing identified-order exit
 * cancellation procedure. This helper never submits or replaces an order.
 *
 * This intentionally is not wired to the contract's reconcile-only endpoint:
 * that API contract explicitly promises never to cancel.
 */
export async function recoverAndCancelUncertainMicroLiveExit(
  orderId: string,
  actorId: string,
  dependencies: UncertainExitRecoveryDependencies = {},
): Promise<UncertainExitRecoveryResult> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(actorId)) {
    throw new Error("invalid_recovery_request");
  }
  const blocked = (reason: string): UncertainExitRecoveryResult =>
    ({ status: "blocked", reason, orderId });
  const auditOnly = async (reason: string, fingerprint?: string) => {
    const [row] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, orderId)).limit(1);
    if (!row) return;
    await db.insert(microLiveDecisionTable).values({
      id: randomUUID(), orderId, evaluationId: row.sourceEvaluationId, status: "BLOCK",
      reason: `${reason};actor=${actorId}${fingerprint ? `;evidence_sha256=${fingerprint}` : ""}`,
    });
  };

  if (process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true" ||
      process.env.LIVE_EXECUTION_ENABLED === "true") {
    await auditOnly("uncertain_exit_recovery_requires_environment_gates_off");
    return blocked("uncertain_exit_recovery_requires_environment_gates_off");
  }
  const [reserved] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, orderId)).limit(1);
  if (!reserved) return blocked("uncertain_recovery_order_not_found");
  const [initialConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const dedicatedPairMode = initialConfig?.microLiveAccountMode === "exclusive" &&
    initialConfig.microLiveSelectedExchangeIndex === 2;
  if (reserved.action !== "sell" || reserved.intent !== "exit" ||
      reserved.triggerType !== "EXIT" || !reserved.exitPositionId) {
    await auditOnly("uncertain_exit_recovery_not_a_sell_exit");
    return blocked("uncertain_exit_recovery_not_a_sell_exit");
  }

  let outcome: ReturnType<typeof verifyEvidence>;
  try {
    const [evidence, account, pairEvidence] = await Promise.all([
      (dependencies.readEvidence ?? readKalshiSubmissionEvidence)(reserved.marketTicker),
      (dependencies.readAccount ?? readKalshiAccount)(),
      dedicatedPairMode && initialConfig
        ? (dependencies.readDedicatedPairEvidence ?? readKalshiDedicatedPairEvidence)(
          initialConfig.microLiveSelectedSubaccount!, reserved.marketTicker,
        )
        : Promise.resolve(null),
    ]);
    const pairMatches = !dedicatedPairMode || (initialConfig !== undefined &&
      dedicatedPairEvidenceMatches(
        pairEvidence,
        initialConfig.microLiveSelectedSubaccount!,
        reserved.marketTicker,
      ));
    outcome = pairMatches
      ? verifyEvidence(evidence, account, reserved, dedicatedPairMode && initialConfig
        ? { subaccountNumber: initialConfig.microLiveSelectedSubaccount!, exchangeIndex: 2 }
        : undefined)
      : { reason: "uncertain_recovery_dedicated_pair_evidence_unproven" };
    await dependencies.afterEvidenceRead?.();
  } catch {
    outcome = { reason: "uncertain_recovery_exchange_read_failed" };
  }

  const linked = await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    const [current] = await tx.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, orderId)).for("update").limit(1);
    let reason = outcome.reason;
    let identityConfirmed = false;
    if (!config || !config.manualKillSwitch || config.microLiveProductionEnabled ||
        config.liveExecutionEnabled ||
        process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true" ||
        process.env.LIVE_EXECUTION_ENABLED === "true") {
      reason = "uncertain_recovery_requires_kill_switch_and_all_gates_off";
    } else if (!accountBindingMatches(config)) {
      reason = "account_mode_or_subaccount_changed";
    } else if (dedicatedPairMode &&
        (!initialConfig || !dedicatedIdentityMatches(initialConfig, config))) {
      reason = "dedicated_pair_identity_changed_during_recovery";
    } else if (!current || JSON.stringify(current) !== JSON.stringify(reserved)) {
      reason = "uncertain_recovery_reservation_changed";
    } else if (!["pending", "partial", "unknown"].includes(current.status)) {
      reason = "uncertain_exit_recovery_order_not_cancelable";
    } else if ((await tx.select({ id: microLiveFillTable.id }).from(microLiveFillTable)
      .where(eq(microLiveFillTable.orderId, current.id)).limit(1)).length) {
      reason = "uncertain_recovery_existing_local_fills";
    } else if (outcome.exchangeOrderId) {
      if (current.exchangeOrderId && current.exchangeOrderId !== outcome.exchangeOrderId) {
        reason = "uncertain_exit_recovery_linked_order_id_conflict";
      } else {
        const duplicate = await tx.select({ id: microLiveOrderTable.id }).from(microLiveOrderTable)
          .where(and(eq(microLiveOrderTable.exchangeOrderId, outcome.exchangeOrderId),
            ne(microLiveOrderTable.id, current.id))).limit(1);
        if (duplicate.length) {
          reason = "uncertain_recovery_exchange_id_already_owned";
        } else if (!current.exchangeOrderId) {
          await tx.update(microLiveOrderTable).set({
            exchangeOrderId: outcome.exchangeOrderId,
            status: "unknown",
            failureReason: "exchange_id_linked_exit_cancel_requires_verification",
          }).where(eq(microLiveOrderTable.id, current.id));
          identityConfirmed = true;
        } else {
          // A restart/retry may verify an existing link, but never writes it
          // again and never proceeds if current evidence names another ID.
          identityConfirmed = true;
        }
      }
    }
    await tx.insert(microLiveDecisionTable).values({
      id: randomUUID(), orderId,
      evaluationId: current?.sourceEvaluationId ?? reserved.sourceEvaluationId,
      status: "BLOCK",
      reason: `${reason};actor=${actorId}${outcome.fingerprint ? `;evidence_sha256=${outcome.fingerprint}` : ""}`,
    });
    if (config?.microLiveAccountMode === "primary_nonexclusive") {
      await tx.update(microLiveConfigTable).set({
        microLiveAccountingUnresolved: true,
        microLiveAccountingUnresolvedReason:
          "primary_nonexclusive_uncertain_exit_requires_get_only_reconciliation",
      }).where(eq(microLiveConfigTable.id, "singleton"));
    }
    return {
      identityConfirmed, reason,
      primaryNonexclusive: config?.microLiveAccountMode === "primary_nonexclusive",
    };
  });
  if (!linked.identityConfirmed || !outcome.exchangeOrderId) return blocked(linked.reason);
  if (linked.primaryNonexclusive) {
    return blocked("primary_nonexclusive_exit_cancel_prohibited_get_only_reconciliation_required");
  }

  // This is the only possible DELETE path: the precondition above proves and
  // transactionally owns the exchange ID; the delegated function freezes,
  // re-proves account-wide exclusive ownership, and re-reads that exact ID.
  let cancellation: { ready: false; reason: string };
  try {
    cancellation = dependencies.cancelExit
      ? await dependencies.cancelExit(orderId)
      : await cancelAndVerifyMicroLiveExit(orderId, dependencies.cancellationDependencies);
  } catch {
    cancellation = { ready: false, reason: "exit_cancellation_or_verification_failed" };
  }
  try {
    await auditOnly(`uncertain_exit_cancel_path_${cancellation.reason}`, outcome.fingerprint);
  } catch {
    // The original identity decision is already audited. Keep the routine
    // frozen if the follow-up audit write cannot be completed.
  }
  return {
    status: cancellation.reason === "exit_canceled_requires_manual_review"
      ? "linked_and_cancel_checked" : "blocked",
    reason: cancellation.reason,
    orderId,
  };
}

/**
 * Read-only exchange discovery, followed by an atomic local identity link.
 * No POST/DELETE to Kalshi and no clearing of the execution kill switch.
 * A linked row stays unknown until the ordinary full startup reconciliation.
 */
export async function reconcileUncertainSubmission(
  orderId: string,
  actorId: string,
  dependencies: UncertainRecoveryDependencies = {},
): Promise<UncertainRecoveryResult> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(actorId)) {
    throw new Error("invalid_recovery_request");
  }
  const blocked = (reason: string): UncertainRecoveryResult =>
    ({ status: "blocked", reason, orderId });
  if (process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true" ||
      process.env.LIVE_EXECUTION_ENABLED === "true") {
    return blocked("uncertain_recovery_requires_environment_gates_off");
  }
  const [reserved] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, orderId)).limit(1);
  if (!reserved) return blocked("uncertain_recovery_order_not_found");
  const [initialConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const dedicatedPairMode = initialConfig?.microLiveAccountMode === "exclusive" &&
    initialConfig.microLiveSelectedExchangeIndex === 2;

  let outcome: ReturnType<typeof verifyEvidence>;
  try {
    const [evidence, account, pairEvidence] = await Promise.all([
      (dependencies.readEvidence ?? readKalshiSubmissionEvidence)(reserved.marketTicker),
      (dependencies.readAccount ?? readKalshiAccount)(),
      dedicatedPairMode && initialConfig
        ? (dependencies.readDedicatedPairEvidence ?? readKalshiDedicatedPairEvidence)(
          initialConfig.microLiveSelectedSubaccount!, reserved.marketTicker,
        )
        : Promise.resolve(null),
    ]);
    const pairMatches = !dedicatedPairMode || (initialConfig !== undefined &&
      dedicatedPairEvidenceMatches(
        pairEvidence,
        initialConfig.microLiveSelectedSubaccount!,
        reserved.marketTicker,
      ));
    outcome = pairMatches
      ? verifyEvidence(evidence, account, reserved, dedicatedPairMode && initialConfig
        ? { subaccountNumber: initialConfig.microLiveSelectedSubaccount!, exchangeIndex: 2 }
        : undefined)
      : { reason: "uncertain_recovery_dedicated_pair_evidence_unproven" };
    await dependencies.afterEvidenceRead?.();
  } catch {
    outcome = { reason: "uncertain_recovery_exchange_read_failed" };
  }

  return db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    const [current] = await tx.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, orderId)).for("update").limit(1);
    if (!config || !config.manualKillSwitch || config.microLiveProductionEnabled ||
        config.liveExecutionEnabled ||
        process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true" ||
        process.env.LIVE_EXECUTION_ENABLED === "true") {
      return blocked("uncertain_recovery_requires_kill_switch_and_all_gates_off");
    }
    if (!accountBindingMatches(config)) return blocked("account_mode_or_subaccount_changed");
    if (dedicatedPairMode &&
        (!initialConfig || !dedicatedIdentityMatches(initialConfig, config))) {
      return blocked("dedicated_pair_identity_changed_during_recovery");
    }
    let reason = outcome.reason;
    let linked = false;
    if (!current || JSON.stringify(current) !== JSON.stringify(reserved)) {
      reason = "uncertain_recovery_reservation_changed";
    } else if (current.exchangeOrderId || !["pending", "unknown"].includes(current.status)) {
      reason = "uncertain_recovery_not_idless_pending_or_unknown";
    } else if ((await tx.select({ id: microLiveFillTable.id }).from(microLiveFillTable)
      .where(eq(microLiveFillTable.orderId, current.id)).limit(1)).length) {
      reason = "uncertain_recovery_existing_local_fills";
    } else if (outcome.exchangeOrderId) {
      const duplicate = await tx.select({ id: microLiveOrderTable.id }).from(microLiveOrderTable)
        .where(and(eq(microLiveOrderTable.exchangeOrderId, outcome.exchangeOrderId),
          ne(microLiveOrderTable.id, current.id))).limit(1);
      if (duplicate.length) reason = "uncertain_recovery_exchange_id_already_owned";
      else {
        await tx.update(microLiveOrderTable).set({
          exchangeOrderId: outcome.exchangeOrderId, status: "unknown",
          failureReason: "exchange_id_linked_requires_startup_reconciliation",
        }).where(eq(microLiveOrderTable.id, current.id));
        linked = true;
      }
    }
    if (config.microLiveAccountMode === "primary_nonexclusive") {
      await tx.update(microLiveConfigTable).set({
        microLiveAccountingUnresolved: true,
        microLiveAccountingUnresolvedReason:
          "primary_nonexclusive_uncertain_submission_requires_get_only_reconciliation",
      }).where(eq(microLiveConfigTable.id, "singleton"));
    }
    // The decision ledger records both successful links and denied attempts,
    // including who requested them and a digest of the exchange evidence.
    await tx.insert(microLiveDecisionTable).values({
      id: randomUUID(), orderId, evaluationId: current?.sourceEvaluationId ?? reserved.sourceEvaluationId,
      status: "BLOCK",
      reason: `${reason};actor=${actorId}${outcome.fingerprint ? `;evidence_sha256=${outcome.fingerprint}` : ""}`,
    });
    return linked
      ? { status: "linked_needs_reconciliation", reason, orderId }
      : blocked(reason);
  });
}