import { createHash } from "node:crypto";

/**
 * Pure reconciliation of a durable primary-subaccount cash baseline against
 * bot-attributable exchange cash flows. Callers must build the authenticated,
 * complete evidence and ownership sets; this helper never reads credentials,
 * the database, or the exchange.
 */

export type PrimaryCashBaseline = {
  /** Canonical non-negative integer micros of USD, persisted as text. */
  availableCashMicros: string;
  runId: string;
  capturedAt: string;
  evidenceDigest: string;
  /** Required for numbered subaccounts; immutable account/shard binding. */
  readonly accountIdentity?: CashAccountIdentity;
};

/** Exact API subaccount and exchange shard represented by authenticated evidence. */
export type CashAccountIdentity = Readonly<{
  subaccountNumber: number;
  exchangeIndex: number;
}>;

export type PrimaryCashFillEvidence = {
  id: string;
  orderId: string | null;
  ticker: string;
  action: string;
  countFp: string;
  priceDollars: string | null;
  feeCostDollars: string | null;
};

export type PrimaryCashSettlementEvidence = {
  id: string;
  ticker: string;
  revenueCents: string;
  feeCostDollars: string | null;
};

export type PrimaryCashActivityEvidence = {
  authenticated: boolean;
  complete: boolean;
  selectedSubaccount: number;
  /** Required with a numbered subaccount; must match the persisted baseline. */
  readonly accountIdentity?: CashAccountIdentity;
  scanFinishedAt: string;
  /** False for unresolved open-order holds or any other unmodeled cash effect. */
  allCashComponentsKnown: boolean;
  fills: PrimaryCashFillEvidence[];
  settlements: PrimaryCashSettlementEvidence[];
  /** IDs separately classified by a caller's verified local ledger. */
  botOrderIds: string[];
  nonBotOrderIds: string[];
  botSettlementIds: string[];
  nonBotSettlementIds: string[];
  /** True only when all value in each bot settlement is attributable to this bot. */
  botSettlementOwnershipProven: boolean;
};

export type PrimaryCashReconciliationInput = {
  baseline: PrimaryCashBaseline;
  currentRunId: string;
  currentAvailableCashDollars: string;
  activity: PrimaryCashActivityEvidence;
  nowMs: number;
};

export type PrimaryCashActivityEventKind =
  | "order"
  | "fill"
  | "settlement"
  | "cash_transfer"
  | "other";

export type PrimaryCashActivityEventClassification =
  | "current_run_bot"
  | "unrelated_permitted"
  | "unknown";

/** Stable, authenticated account-history item normalized by the caller. */
export type PrimaryCashActivityEvent = {
  id: string;
  kind: PrimaryCashActivityEventKind;
  occurredAt: string;
  classification: PrimaryCashActivityEventClassification;
  /** Required and equal to the active run for current_run_bot events. */
  runId: string | null;
  /** True when the item touches any market traded by MICRO_LIVE. */
  affectsBotMarket: boolean;
  affectsPositions: boolean;
  affectsReservedExposure: boolean;
  /** Signed exact micros for cash transfers; null for other event kinds. */
  cashDeltaMicros: string | null;
  /** SHA-256 over the canonical event fields, made with the helper below. */
  evidenceDigest: string;
};

/**
 * Durable checkpoint fields map one-to-one to micro_live_config columns.
 * cursor must be an opaque provider cursor with complete, exclusive-after
 * semantics; a timestamp synthesized by the caller is not a safe substitute.
 */
export type PrimaryCashActivityCheckpoint = {
  runId: string;
  cursor: string;
  capturedAt: string;
  evidenceDigest: string;
};

export type PrimaryCashActivityScan = {
  authenticated: boolean;
  /** All relevant account order/fill/settlement history since historyFromCursor. */
  accountHistoryComplete: boolean;
  /** Must represent a complete, authenticated transfer history in the same range. */
  cashTransferHistoryAvailable: boolean;
  cashTransferHistoryComplete: boolean;
  selectedSubaccount: number;
  /** Required with a numbered subaccount; must match the persisted baseline. */
  readonly accountIdentity?: CashAccountIdentity;
  historyFromCursor: string | null;
  nextCursor: string;
  /** Used only to prove the first scan begins no later than the cash baseline. */
  historyCoveredFrom: string;
  scanStartedAt: string;
  scanFinishedAt: string;
  events: PrimaryCashActivityEvent[];
};

export type PrimaryCashActivityCheckpointInput = {
  baseline: PrimaryCashBaseline;
  currentRunId: string;
  previousCheckpoint: PrimaryCashActivityCheckpoint | null;
  activity: PrimaryCashActivityScan;
  nowMs: number;
};

export type PrimaryCashActivityCheckpointResult =
  | {
    ok: true;
    nextCheckpoint: PrimaryCashActivityCheckpoint;
    /** All new stable IDs committed into the checkpoint digest. */
    observedEventIds: string[];
    /** Exposed even when their aggregate cash delta is zero. */
    unrelatedCashMovementIds: string[];
    unrelatedCashDeltaMicros: string;
  }
  | {
    ok: false;
    reason: string;
  };

export type PrimaryCashReconciliation =
  | {
    ok: true;
    baselineAvailableCashMicros: string;
    currentAvailableCashMicros: string;
    observedDeltaMicros: string;
    botAttributableDeltaMicros: string;
    unexplainedDeltaMicros: "0";
  }
  | {
    ok: false;
    reason: string;
    /** Present for a cash discrepancy so the caller can audit without rounding. */
    observedDeltaMicros?: string;
    botAttributableDeltaMicros?: string;
    unexplainedDeltaMicros?: string;
  };

const DIGEST_RE = /^[0-9a-f]{64}$/;
const CANONICAL_INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const SIGNED_INTEGER_RE = /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/;

function validNumberedAccountIdentity(
  identity: CashAccountIdentity | undefined,
): identity is CashAccountIdentity {
  return identity !== undefined &&
    Number.isSafeInteger(identity.subaccountNumber) &&
    identity.subaccountNumber >= 1 && identity.subaccountNumber <= 63 &&
    Number.isSafeInteger(identity.exchangeIndex) && identity.exchangeIndex >= 0;
}

/**
 * Legacy primary-account evidence remains valid without pair fields. Every
 * numbered account must carry the same explicit, immutable subaccount/shard
 * pair in the baseline and its authenticated activity evidence.
 */
function accountIdentityMatches(
  baselineIdentity: CashAccountIdentity | undefined,
  activityIdentity: CashAccountIdentity | undefined,
  selectedSubaccount: number,
): boolean {
  if (selectedSubaccount === 0) {
    return baselineIdentity === undefined && activityIdentity === undefined;
  }
  if (!validNumberedAccountIdentity(baselineIdentity) ||
      !validNumberedAccountIdentity(activityIdentity)) return false;
  return selectedSubaccount === baselineIdentity.subaccountNumber &&
    selectedSubaccount === activityIdentity.subaccountNumber &&
    baselineIdentity.exchangeIndex === activityIdentity.exchangeIndex;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalActivityEventFields(
  event: Omit<PrimaryCashActivityEvent, "evidenceDigest">,
): string {
  return JSON.stringify([
    event.id,
    event.kind,
    event.occurredAt,
    event.classification,
    event.runId,
    event.affectsBotMarket,
    event.affectsPositions,
    event.affectsReservedExposure,
    event.cashDeltaMicros,
  ]);
}

/** Create the canonical digest expected for one normalized activity event. */
export function createPrimaryCashActivityEventDigest(
  event: Omit<PrimaryCashActivityEvent, "evidenceDigest">,
): string {
  return sha256(canonicalActivityEventFields(event));
}

function validTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Verify and advance the durable account-activity checkpoint. This is separate
 * from cash-flow arithmetic: callers must also run the cash-delta reconciler.
 * A complete transfer ledger is mandatory; without it, this helper never
 * claims that offsetting or otherwise unobserved cash movements were checked.
 */
export function reconcilePrimaryCashActivityCheckpoint(
  input: PrimaryCashActivityCheckpointInput,
): PrimaryCashActivityCheckpointResult {
  const { baseline, activity, previousCheckpoint } = input;
  const baselineAt = validTimestamp(baseline.capturedAt);
  const scanStartedAt = validTimestamp(activity.scanStartedAt);
  const scanFinishedAt = validTimestamp(activity.scanFinishedAt);

  if (!baseline.runId || baseline.runId !== input.currentRunId ||
      !CANONICAL_INTEGER_RE.test(baseline.availableCashMicros) ||
      baselineAt === null || !DIGEST_RE.test(baseline.evidenceDigest)) {
    return { ok: false, reason: "primary_cash_baseline_invalid_or_run_changed" };
  }
  if (!Number.isSafeInteger(input.nowMs) || !activity.authenticated ||
      !activity.accountHistoryComplete ||
      !accountIdentityMatches(
        baseline.accountIdentity, activity.accountIdentity, activity.selectedSubaccount,
      )) {
    return { ok: false, reason: "primary_activity_history_unverified_or_incomplete" };
  }
  if (!activity.cashTransferHistoryAvailable || !activity.cashTransferHistoryComplete) {
    return { ok: false, reason: "primary_cash_transfer_history_unavailable_or_incomplete" };
  }
  if (scanStartedAt === null || scanFinishedAt === null ||
      scanFinishedAt < baselineAt || scanFinishedAt < scanStartedAt ||
      scanFinishedAt > input.nowMs || input.nowMs - scanFinishedAt > 5_000) {
    return { ok: false, reason: "primary_activity_scan_time_invalid_or_stale" };
  }
  if (!activity.nextCursor || activity.nextCursor.length > 4096) {
    return { ok: false, reason: "primary_activity_cursor_missing_or_invalid" };
  }

  let priorDigest: string;
  if (previousCheckpoint) {
    const previousAt = validTimestamp(previousCheckpoint.capturedAt);
    if (previousCheckpoint.runId !== input.currentRunId ||
        !previousCheckpoint.cursor || previousCheckpoint.cursor.length > 4096 ||
        previousAt === null || previousAt < baselineAt ||
        previousAt > scanFinishedAt ||
        !DIGEST_RE.test(previousCheckpoint.evidenceDigest) ||
        activity.historyFromCursor !== previousCheckpoint.cursor) {
      return { ok: false, reason: "primary_activity_checkpoint_invalid_or_cursor_mismatch" };
    }
    priorDigest = previousCheckpoint.evidenceDigest;
  } else {
    const coveredFrom = validTimestamp(activity.historyCoveredFrom);
    if (activity.historyFromCursor !== null || coveredFrom === null || coveredFrom > baselineAt) {
      return { ok: false, reason: "primary_activity_initial_history_does_not_cover_baseline" };
    }
    priorDigest = sha256(JSON.stringify(
      baseline.accountIdentity === undefined
        ? [
            "primary-cash-activity-checkpoint-v1",
            input.currentRunId,
            baseline.capturedAt,
            baseline.evidenceDigest,
          ]
        : [
            "pair-cash-activity-checkpoint-v1",
            input.currentRunId,
            baseline.capturedAt,
            baseline.evidenceDigest,
            baseline.accountIdentity.subaccountNumber,
            baseline.accountIdentity.exchangeIndex,
          ],
    ));
  }
  if (activity.events.length > 0 && activity.nextCursor === activity.historyFromCursor) {
    return { ok: false, reason: "primary_activity_cursor_did_not_advance" };
  }

  const ids = new Set<string>();
  const unrelatedCashMovementIds: string[] = [];
  let unrelatedCashDeltaMicros = 0n;
  const eventDigests: Array<[string, string]> = [];
  for (const event of activity.events) {
    const occurredAt = validTimestamp(event.occurredAt);
    if (!event.id || event.id.trim() !== event.id || event.id.length > 512 ||
        ids.has(event.id) || occurredAt === null || occurredAt < baselineAt ||
        occurredAt > scanFinishedAt ||
        !["order", "fill", "settlement", "cash_transfer", "other"].includes(event.kind) ||
        typeof event.affectsBotMarket !== "boolean" ||
        typeof event.affectsPositions !== "boolean" ||
        typeof event.affectsReservedExposure !== "boolean" ||
        !DIGEST_RE.test(event.evidenceDigest) ||
        event.evidenceDigest !== createPrimaryCashActivityEventDigest({
          id: event.id,
          kind: event.kind,
          occurredAt: event.occurredAt,
          classification: event.classification,
          runId: event.runId,
          affectsBotMarket: event.affectsBotMarket,
          affectsPositions: event.affectsPositions,
          affectsReservedExposure: event.affectsReservedExposure,
          cashDeltaMicros: event.cashDeltaMicros,
        })) {
      return { ok: false, reason: "primary_activity_event_identity_or_digest_invalid" };
    }
    ids.add(event.id);

    if (event.kind === "cash_transfer") {
      if (event.classification === "current_run_bot" ||
          typeof event.cashDeltaMicros !== "string" ||
          !SIGNED_INTEGER_RE.test(event.cashDeltaMicros)) {
        return { ok: false, reason: "primary_cash_transfer_attribution_invalid" };
      }
    } else if (event.cashDeltaMicros !== null) {
      return { ok: false, reason: "primary_activity_non_transfer_has_cash_delta" };
    }

    if (event.classification === "unknown") {
      return { ok: false, reason: "primary_activity_ownership_unknown" };
    }
    if (event.classification === "current_run_bot") {
      if (event.runId !== input.currentRunId) {
        return { ok: false, reason: "primary_activity_bot_run_identity_mismatch" };
      }
    } else if (event.classification === "unrelated_permitted") {
      if (event.runId !== null || event.affectsBotMarket ||
          event.affectsPositions || event.affectsReservedExposure) {
        return { ok: false, reason: "primary_activity_unrelated_item_affects_bot_scope" };
      }
      if (event.kind === "cash_transfer") {
        unrelatedCashMovementIds.push(event.id);
        unrelatedCashDeltaMicros += BigInt(event.cashDeltaMicros!);
      }
    } else {
      return { ok: false, reason: "primary_activity_classification_invalid" };
    }
    eventDigests.push([event.id, event.evidenceDigest]);
  }

  eventDigests.sort(([idA], [idB]) => idA < idB ? -1 : idA > idB ? 1 : 0);
  const nextCheckpoint: PrimaryCashActivityCheckpoint = {
    runId: input.currentRunId,
    cursor: activity.nextCursor,
    capturedAt: activity.scanFinishedAt,
    evidenceDigest: sha256(JSON.stringify([
      "primary-cash-activity-checkpoint-v1",
      priorDigest,
      eventDigests,
    ])),
  };
  return {
    ok: true,
    nextCheckpoint,
    observedEventIds: eventDigests.map(([id]) => id),
    unrelatedCashMovementIds,
    unrelatedCashDeltaMicros: unrelatedCashDeltaMicros.toString(),
  };
}

function parseDollarsMicros(value: string | null): bigint | null {
  if (value === null || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function parseCount(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(value)) return null;
  const count = BigInt(value.split(".")[0]!);
  return count > 0n ? count : null;
}

function parseCents(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

function validIdSet(ids: string[]): Set<string> | null {
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return new Set(ids);
}

/**
 * Reconciles exact available cash at the current observation with the original
 * persisted baseline and the net cash flows from matching bot fills/settlements.
 * A successful result means the observed change is fully explained by those
 * bot flows. Deposits, withdrawals, unrelated fills that alter cash, missing
 * fees, ambiguous settlements, or unknown reservation effects fail closed.
 */
export function computeBotAttributableAvailableCashDelta(
  input: PrimaryCashReconciliationInput,
): PrimaryCashReconciliation {
  const { baseline, activity } = input;
  const baselineAtMs = Date.parse(baseline.capturedAt);
  if (!CANONICAL_INTEGER_RE.test(baseline.availableCashMicros) ||
      !baseline.runId || baseline.runId !== input.currentRunId ||
      !Number.isFinite(baselineAtMs) || !DIGEST_RE.test(baseline.evidenceDigest)) {
    return { ok: false, reason: "primary_cash_baseline_invalid_or_run_changed" };
  }
  if (!Number.isFinite(input.nowMs) || !activity.authenticated || !activity.complete ||
      !accountIdentityMatches(
        baseline.accountIdentity, activity.accountIdentity, activity.selectedSubaccount,
      ) || !activity.allCashComponentsKnown) {
    return { ok: false, reason: "primary_cash_activity_unverified_or_incomplete" };
  }
  const scanFinishedAtMs = Date.parse(activity.scanFinishedAt);
  if (!Number.isFinite(scanFinishedAtMs) || scanFinishedAtMs > input.nowMs ||
      input.nowMs - scanFinishedAtMs > 5_000 || scanFinishedAtMs < baselineAtMs) {
    return { ok: false, reason: "primary_cash_activity_stale" };
  }
  const botOrderIds = validIdSet(activity.botOrderIds);
  const nonBotOrderIds = validIdSet(activity.nonBotOrderIds);
  const botSettlementIds = validIdSet(activity.botSettlementIds);
  const nonBotSettlementIds = validIdSet(activity.nonBotSettlementIds);
  if (!botOrderIds || !nonBotOrderIds || !botSettlementIds || !nonBotSettlementIds ||
      [...botOrderIds].some((id) => nonBotOrderIds.has(id)) ||
      [...botSettlementIds].some((id) => nonBotSettlementIds.has(id))) {
    return { ok: false, reason: "primary_cash_ownership_classification_invalid" };
  }

  let botDelta = 0n;
  const fillIds = new Set<string>();
  for (const fill of activity.fills) {
    if (!fill.id || fillIds.has(fill.id) || !fill.ticker || !fill.orderId) {
      return { ok: false, reason: "primary_cash_fill_identity_unknown" };
    }
    fillIds.add(fill.id);
    const isBot = botOrderIds.has(fill.orderId);
    if (!isBot && !nonBotOrderIds.has(fill.orderId)) {
      return { ok: false, reason: "primary_cash_fill_ownership_unknown" };
    }
    if (!isBot) continue;
    if (fill.action !== "buy" && fill.action !== "sell") {
      return { ok: false, reason: "primary_cash_fill_action_unknown" };
    }
    const count = parseCount(fill.countFp);
    const price = parseDollarsMicros(fill.priceDollars);
    const fee = parseDollarsMicros(fill.feeCostDollars);
    if (count === null || price === null || price > 1_000_000n ||
        fee === null || (fill.feeCostDollars !== null && fee < 0n)) {
      return { ok: false, reason: "primary_cash_fill_price_count_or_fee_unknown" };
    }
    const trade = count * price;
    botDelta += (fill.action === "buy" ? -trade : trade) - fee;
  }
  const settlementIds = new Set<string>();
  for (const settlement of activity.settlements) {
    if (!settlement.id || settlementIds.has(settlement.id) || !settlement.ticker) {
      return { ok: false, reason: "primary_cash_settlement_identity_unknown" };
    }
    settlementIds.add(settlement.id);
    const isBot = botSettlementIds.has(settlement.id);
    if (!isBot && !nonBotSettlementIds.has(settlement.id)) {
      return { ok: false, reason: "primary_cash_settlement_ownership_unknown" };
    }
    if (!isBot) continue;
    if (!activity.botSettlementOwnershipProven) {
      return { ok: false, reason: "primary_cash_settlement_attribution_ambiguous" };
    }
    const revenueCents = parseCents(settlement.revenueCents);
    const fee = parseDollarsMicros(settlement.feeCostDollars);
    if (revenueCents === null || fee === null) {
      return { ok: false, reason: "primary_cash_settlement_revenue_or_fee_unknown" };
    }
    botDelta += revenueCents * 10_000n - fee;
  }

  if ([...botSettlementIds].some((id) => !settlementIds.has(id)) ||
      [...nonBotSettlementIds].some((id) => !settlementIds.has(id))) {
    return { ok: false, reason: "primary_cash_settlement_evidence_missing" };
  }
  const currentCash = parseDollarsMicros(input.currentAvailableCashDollars);
  if (currentCash === null) return { ok: false, reason: "primary_cash_snapshot_invalid" };
  const baselineCash = BigInt(baseline.availableCashMicros);
  const observedDelta = currentCash - baselineCash;
  const unexplainedDelta = observedDelta - botDelta;
  if (unexplainedDelta !== 0n) {
    return {
      ok: false,
      reason: "primary_cash_delta_unexplained",
      observedDeltaMicros: observedDelta.toString(),
      botAttributableDeltaMicros: botDelta.toString(),
      unexplainedDeltaMicros: unexplainedDelta.toString(),
    };
  }
  return {
    ok: true,
    baselineAvailableCashMicros: baselineCash.toString(),
    currentAvailableCashMicros: currentCash.toString(),
    observedDeltaMicros: observedDelta.toString(),
    botAttributableDeltaMicros: botDelta.toString(),
    unexplainedDeltaMicros: "0",
  };
}