import type { microLiveOrderTable } from "@workspace/db";
import {
  getConfiguredKalshiSubaccount,
  type KalshiAccountActivity,
  type KalshiAccountSnapshot,
} from "./kalshiAccountClient";

type LocalOrder = typeof microLiveOrderTable.$inferSelect;
type Fill = KalshiAccountSnapshot["fills"][number];

// Kalshi _fp contract responses use hundredths. Keep account-history arithmetic
// exact and conservatively bound it to safely representable centi-contracts.
const MAX_ACCOUNT_COUNT_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

function accountHistoryCountUnits(value: string, allowZero = false): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const units = BigInt(match[1]!) * 100n +
    BigInt((match[2] ?? "").padEnd(2, "0"));
  return units <= MAX_ACCOUNT_COUNT_UNITS && (allowZero || units > 0n)
    ? units : null;
}

function sameFill(a: Fill, b: Fill): boolean {
  return a.id === b.id && a.orderId === b.orderId && a.ticker === b.ticker &&
    a.side === b.side && a.action === b.action && a.countFp === b.countFp &&
    a.createdAt === b.createdAt && a.priceDollars === b.priceDollars &&
    (a.feeCostDollars == null || b.feeCostDollars == null ||
      a.feeCostDollars === b.feeCostDollars);
}

export type ActivityCheckInput = {
  activity: KalshiAccountActivity;
  snapshot: KalshiAccountSnapshot;
  localOrders: LocalOrder[];
  boundaryMs: number;
  /** Test seam; production compares against the configured selector. */
  configuredSubaccount?: number;
  nowMs?: number;
};

type ActivityCheckResult = { reason: string | null; botFills: Fill[] };

function validateActivityScan(
  input: ActivityCheckInput,
): ActivityCheckResult {
  const { activity, snapshot, localOrders, boundaryMs } = input;
  const blocked = (reason: string) => ({ reason, botFills: [] });
  if (activity.orderOverlapConflicts?.length) {
    return blocked("account_history_order_overlap_conflict");
  }
  if (snapshot.truncated.openOrders || snapshot.truncated.positions ||
      snapshot.truncated.fills) {
    return blocked("account_snapshot_truncated");
  }
  if (new Set(snapshot.positions.map((position) => position.ticker)).size !==
      snapshot.positions.length) {
    return blocked("exchange_position_duplicate_ticker");
  }
  if (!Number.isFinite(boundaryMs) || !activity.available || activity.truncated) {
    return blocked("account_history_incomplete");
  }
  if (activity.keyRestrictionVerified !== true) {
    return blocked("account_key_restriction_unverified");
  }
  const selectedSubaccount = activity.selectedSubaccount;
  if (!Number.isInteger(selectedSubaccount) || selectedSubaccount! < 1 ||
      selectedSubaccount! > 63) {
    return blocked("account_subaccount_unverified");
  }
  let configuredSubaccount = input.configuredSubaccount;
  if (configuredSubaccount === undefined) {
    try {
      configuredSubaccount = getConfiguredKalshiSubaccount();
    } catch {
      return blocked("account_subaccount_unverified");
    }
  }
  if (configuredSubaccount !== selectedSubaccount) {
    return blocked("account_subaccount_mismatch");
  }
  const startedAtMs = activity.scanStartedAt ? Date.parse(activity.scanStartedAt) : NaN;
  const finishedAtMs = activity.scanFinishedAt ? Date.parse(activity.scanFinishedAt) : NaN;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || !Number.isFinite(startedAtMs) ||
      !Number.isFinite(finishedAtMs) || startedAtMs > finishedAtMs ||
      finishedAtMs > nowMs || nowMs - startedAtMs > 5_000 ||
      finishedAtMs - startedAtMs > 15_000) {
    return blocked("account_history_scan_stale_or_incomplete");
  }
  return { reason: null, botFills: [] };
}

/**
 * Diagnostics can prove the supplied snapshot/history is internally clean,
 * but deliberately cannot make the exclusivity control predicate true.
 */
export function diagnoseMicroLiveAccountActivity(
  input: ActivityCheckInput,
): ActivityCheckResult {
  const metadata = validateActivityScan(input);
  if (metadata.reason) return metadata;
  return evaluateAccountActivityHistory(input);
}

/**
 * Account-wide history is essential here: a ticker-only GET cannot find an
 * aged-out foreign order on a different market after the bot's start time.
 * This proof only separates history; it never authorizes a submission.
 */
export function separateMicroLiveAccountActivity(
  input: ActivityCheckInput,
): ActivityCheckResult {
  const metadata = validateActivityScan(input);
  if (metadata.reason) return metadata;
  if (!input.activity.exclusiveControlVerified) {
    return { reason: "account_exclusive_control_unproven", botFills: [] };
  }
  return evaluateAccountActivityHistory(input);
}

/**
 * Attribute bot fills on primary account 0 without claiming exclusivity.
 * Manual activity is tolerated only on other markets; any unexplained order,
 * fill, or net position on a bot market makes attribution ambiguous.
 */
export function attributePrimaryMicroLiveAccountActivity(
  input: ActivityCheckInput,
): ActivityCheckResult {
  const metadata = validatePrimaryActivityScan(input);
  if (metadata.reason) return metadata;

  const { activity, snapshot, localOrders } = input;
  const blocked = (reason: string) => ({ reason, botFills: [] });
  const byExchangeId = new Map(localOrders.flatMap((row) =>
    row.exchangeOrderId ? [[row.exchangeOrderId, row] as const] : []));
  const byClientId = new Map(localOrders.map((row) => [row.clientOrderId, row] as const));
  if (byExchangeId.size !== localOrders.filter((row) => row.exchangeOrderId).length ||
      byClientId.size !== localOrders.length) {
    return blocked("primary_account_local_order_identity_conflict");
  }
  const botMarkets = new Set(localOrders.map((row) => row.marketTicker));
  const orders = new Map<string, KalshiAccountActivity["orders"][number]>();
  for (const order of activity.orders) {
    if (!order.id || orders.has(order.id)) {
      return blocked("primary_account_history_order_conflict");
    }
    orders.set(order.id, order);
    const localById = byExchangeId.get(order.id);
    const localByClient = order.clientOrderId ? byClientId.get(order.clientOrderId) : undefined;
    if (localByClient && localByClient.exchangeOrderId !== order.id) {
      return blocked("primary_account_bot_order_identity_conflict");
    }
    const local = localById ?? localByClient;
    if (local) {
      if (local.exchangeOrderId !== order.id ||
          order.clientOrderId !== local.clientOrderId ||
          order.ticker !== local.marketTicker ||
          order.side !== (local.side === "UP" ? "yes" : "no") ||
          order.action !== local.action || order.type !== "limit" ||
          Number(order.initialCount) !== local.requestedContracts) {
        return blocked("primary_account_bot_order_mismatch");
      }
    } else if (botMarkets.has(order.ticker)) {
      return blocked("primary_account_same_market_order_conflict");
    }
  }
  for (const local of localOrders) {
    if (local.exchangeOrderId && !orders.has(local.exchangeOrderId)) {
      return blocked("primary_account_bot_order_missing");
    }
    // One fresh, not-yet-submitted reservation is expected during the
    // immediate pre-POST scan. Any uncertain or previously submitted
    // ID-less order cannot be attributed and must remain frozen.
    if (!local.exchangeOrderId &&
        !(local.status === "pending" && local.submittedAt === null &&
          local.filledContracts === 0 && local.remainingContracts === local.requestedContracts &&
          Date.now() - local.createdAt.getTime() <= 5_000)) {
      return blocked("primary_account_bot_order_identity_missing");
    }
  }

  const allFills = new Map<string, Fill>();
  const botFills: Fill[] = [];
  const filledByOrder = new Map<string, bigint>();
  for (const fill of activity.fills) {
    if (!fill.id || allFills.has(fill.id)) {
      return blocked("primary_account_history_fill_conflict");
    }
    allFills.set(fill.id, fill);
    const order = fill.orderId ? orders.get(fill.orderId) : undefined;
    const countUnits = accountHistoryCountUnits(fill.countFp);
    if (!order || order.ticker !== fill.ticker || !fill.createdAt ||
        !Number.isFinite(Date.parse(fill.createdAt)) ||
        countUnits === null ||
        // The bot still requests and accounts for whole contracts only.
        (byExchangeId.has(order.id) && countUnits % 100n !== 0n)) {
      return blocked("primary_account_unexplained_fill");
    }
    const total = (filledByOrder.get(order.id) ?? 0n) + countUnits;
    if (total > MAX_ACCOUNT_COUNT_UNITS) return blocked("primary_account_unexplained_fill");
    filledByOrder.set(order.id, total);
    if (byExchangeId.has(order.id)) {
      botFills.push(fill);
    } else if (botMarkets.has(fill.ticker)) {
      return blocked("primary_account_same_market_fill_conflict");
    }
  }
  for (const order of activity.orders) {
    // A complete account-wide scan must account for every reported fill,
    // including fractional fills on unrelated manual markets.
    const filled = accountHistoryCountUnits(order.filledCount, true);
    if (filled === null || filled !== (filledByOrder.get(order.id) ?? 0n)) {
      return blocked("primary_account_order_fill_count_mismatch");
    }
  }
  for (const fill of snapshot.fills) {
    const historical = allFills.get(fill.id);
    if (!historical || !sameFill(fill, historical)) {
      return blocked("primary_account_current_fill_mismatch");
    }
  }
  for (const fill of botFills) {
    const observed = snapshot.fills.find((item) => item.id === fill.id);
    if (!observed || !sameFill(fill, observed)) {
      return blocked("primary_account_bot_fill_missing");
    }
  }
  if (snapshot.openOrders.some((order) =>
    botMarkets.has(order.ticker) && !byExchangeId.has(order.id))) {
    return blocked("primary_account_same_market_open_order_conflict");
  }

  const botPositionByTicker = new Map<string, number>();
  for (const fill of botFills) {
    const order = byExchangeId.get(fill.orderId!);
    if (!order) return blocked("primary_account_bot_fill_identity_missing");
    const leg = fill.side === "yes" ? 1 : fill.side === "no" ? -1 : 0;
    if (!leg || (fill.action !== "buy" && fill.action !== "sell")) {
      return blocked("primary_account_bot_fill_identity_missing");
    }
    const signedCount = leg * Number(fill.countFp) * (fill.action === "buy" ? 1 : -1);
    botPositionByTicker.set(fill.ticker,
      (botPositionByTicker.get(fill.ticker) ?? 0) + signedCount);
  }
  const exchangePositions = new Map(snapshot.positions.map((position) =>
    [position.ticker, Number(position.positionFp)] as const));
  for (const ticker of botMarkets) {
    const actual = exchangePositions.get(ticker) ?? 0;
    const expected = botPositionByTicker.get(ticker) ?? 0;
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.0001) {
      return blocked("primary_account_net_position_conflict");
    }
  }
  return { reason: null, botFills };
}

/** Diagnostic alias used by the caller to emphasize this does not prove exclusivity. */
export const diagnosePrimaryMicroLiveAccountActivity =
  attributePrimaryMicroLiveAccountActivity;

function validatePrimaryActivityScan(
  input: ActivityCheckInput,
): ActivityCheckResult {
  const { activity, snapshot, localOrders, boundaryMs } = input;
  const blocked = (reason: string) => ({ reason, botFills: [] });
  if (activity.orderOverlapConflicts?.length) {
    return blocked("account_history_order_overlap_conflict");
  }
  if (snapshot.truncated.openOrders || snapshot.truncated.positions ||
      snapshot.truncated.fills) return blocked("account_snapshot_truncated");
  if (new Set(snapshot.positions.map((position) => position.ticker)).size !==
      snapshot.positions.length) return blocked("exchange_position_duplicate_ticker");
  if (!Number.isFinite(boundaryMs) || !activity.available || activity.truncated) {
    return blocked("account_history_incomplete");
  }
  const selectedSubaccount = activity.selectedSubaccount;
  if (selectedSubaccount !== 0) return blocked("account_subaccount_unverified");
  let configuredSubaccount = input.configuredSubaccount;
  if (configuredSubaccount === undefined) {
    try {
      configuredSubaccount = getConfiguredKalshiSubaccount();
    } catch {
      return blocked("account_subaccount_unverified");
    }
  }
  if (configuredSubaccount !== 0) return blocked("account_subaccount_mismatch");
  const startedAtMs = activity.scanStartedAt ? Date.parse(activity.scanStartedAt) : NaN;
  const finishedAtMs = activity.scanFinishedAt ? Date.parse(activity.scanFinishedAt) : NaN;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || !Number.isFinite(startedAtMs) ||
      !Number.isFinite(finishedAtMs) || startedAtMs > finishedAtMs ||
      finishedAtMs > nowMs || nowMs - startedAtMs > 5_000 ||
      finishedAtMs - startedAtMs > 15_000) {
    return blocked("account_history_scan_stale_or_incomplete");
  }
  return { reason: null, botFills: [] };
}

function evaluateAccountActivityHistory(input: ActivityCheckInput): ActivityCheckResult {
  const { activity, snapshot, localOrders, boundaryMs } = input;
  const blocked = (reason: string) => ({ reason, botFills: [] });
  const byExchangeId = new Map(localOrders.flatMap((row) =>
    row.exchangeOrderId ? [[row.exchangeOrderId, row] as const] : []));
  if (byExchangeId.size !== localOrders.filter((row) => row.exchangeOrderId).length) {
    return blocked("duplicate_local_exchange_order_id");
  }
  const botMarkets = new Set(localOrders.map((row) => row.marketTicker));
  const orders = new Map<string, KalshiAccountActivity["orders"][number]>();
  for (const order of activity.orders) {
    if (!order.id || orders.has(order.id)) return blocked("account_history_order_conflict");
    orders.set(order.id, order);
    const local = byExchangeId.get(order.id);
    if (local) {
      if (order.clientOrderId !== local.clientOrderId ||
          order.ticker !== local.marketTicker ||
          order.side !== (local.side === "UP" ? "yes" : "no") ||
          order.action !== local.action || order.type !== "limit" ||
          Number(order.initialCount) !== local.requestedContracts) {
        return blocked("account_history_bot_order_mismatch");
      }
    } else if (order.status === "resting" || Number(order.remainingCount) !== 0 ||
        !order.createdAt || !Number.isFinite(Date.parse(order.createdAt)) ||
        Date.parse(order.createdAt) >= boundaryMs || botMarkets.has(order.ticker) ||
        (order.clientOrderId !== null &&
          localOrders.some((row) => row.clientOrderId === order.clientOrderId))) {
      return blocked("account_history_unexplained_order");
    }
  }
  if ([...byExchangeId.keys()].some((id) => !orders.has(id))) {
    return blocked("account_history_bot_order_missing");
  }
  const allFills = new Map<string, Fill>();
  const botFills: Fill[] = [];
  const filledByOrder = new Map<string, number>();
  for (const fill of activity.fills) {
    if (!fill.id || allFills.has(fill.id)) return blocked("account_history_fill_conflict");
    allFills.set(fill.id, fill);
    const order = fill.orderId ? orders.get(fill.orderId) : undefined;
    if (!order || order.ticker !== fill.ticker ||
        !fill.createdAt || !Number.isFinite(Date.parse(fill.createdAt)) ||
        !Number.isSafeInteger(Number(fill.countFp)) || Number(fill.countFp) <= 0) {
      return blocked("account_history_unexplained_fill");
    }
    filledByOrder.set(order.id, (filledByOrder.get(order.id) ?? 0) + Number(fill.countFp));
    if (byExchangeId.has(order.id)) {
      botFills.push(fill);
    } else if (Date.parse(fill.createdAt) >= boundaryMs || botMarkets.has(fill.ticker)) {
      return blocked("account_history_unexplained_fill");
    }
  }
  for (const order of activity.orders) {
    const filled = Number(order.filledCount);
    if (!Number.isSafeInteger(filled) || filled < 0 ||
        filled !== (filledByOrder.get(order.id) ?? 0)) {
      return blocked("account_history_order_fill_count_mismatch");
    }
  }
  // The independent current snapshot must not contain an ID omitted or
  // contradicted by the supposedly complete account-wide history.
  for (const fill of snapshot.fills) {
    const historical = allFills.get(fill.id);
    if (!historical || !sameFill(fill, historical)) {
      return blocked("account_history_current_fill_mismatch");
    }
  }
  for (const fill of botFills) {
    const observed = snapshot.fills.find((item) => item.id === fill.id);
    if (!observed || !sameFill(fill, observed)) {
      return blocked("account_history_bot_fill_missing");
    }
  }
  // A foreign resting order cannot be dismissed as settled legacy activity.
  if (snapshot.openOrders.some((order) => !byExchangeId.has(order.id))) {
    return blocked("exchange_open_order_discrepancy");
  }
  return { reason: null, botFills };
}