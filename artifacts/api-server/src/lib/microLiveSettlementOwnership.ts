import type { microLiveFillTable, microLiveOrderTable } from "@workspace/db";
import type { KalshiAccountSnapshot, KalshiSubmissionEvidence } from "./kalshiAccountClient";
import { dollarsToMicros } from "./microLiveMoney";
import {
  compatibleOptionalDirection, compatibleOptionalPrice, mergeDirectionAndPrices,
} from "./microLiveFillNormalization";

type LocalOrder = typeof microLiveOrderTable.$inferSelect;
type LocalFill = typeof microLiveFillTable.$inferSelect;
type MarketFill = KalshiSubmissionEvidence["fills"][number];
type MarketOrder = KalshiSubmissionEvidence["orders"][number];

type OwnershipProof =
  | { verified: false; reason: string }
  | { verified: true; orders: MarketOrder[]; fills: MarketFill[] };

function whole(value: string): number | null {
  if (!/^\d+(?:\.0+)?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function sameFill(a: MarketFill, b: MarketFill): boolean {
  return a.id === b.id && a.orderId === b.orderId &&
    a.ticker === b.ticker && a.side === b.side && a.action === b.action &&
    whole(a.countFp) !== null && whole(a.countFp) === whole(b.countFp) &&
    a.priceDollars !== null && b.priceDollars !== null &&
    dollarsToMicros(a.priceDollars) === dollarsToMicros(b.priceDollars) &&
    compatibleOptionalDirection(a, b) &&
    compatibleOptionalPrice(a.yesPriceDollars, b.yesPriceDollars) &&
    compatibleOptionalPrice(a.noPriceDollars, b.noPriceDollars) &&
    a.createdAt !== null && a.createdAt === b.createdAt &&
    (a.feeCostDollars === null || b.feeCostDollars === null ||
      dollarsToMicros(a.feeCostDollars) === dollarsToMicros(b.feeCostDollars));
}

function sameOrder(a: MarketOrder, b: MarketOrder): boolean {
  return a.id === b.id && a.clientOrderId === b.clientOrderId &&
    a.ticker === b.ticker && a.side === b.side && a.action === b.action &&
    a.type === b.type && a.status === b.status &&
    compatibleOptionalDirection(a, b) &&
    a.priceDollars !== null && b.priceDollars !== null &&
    dollarsToMicros(a.priceDollars) === dollarsToMicros(b.priceDollars) &&
    whole(a.initialCount) !== null && whole(a.initialCount) === whole(b.initialCount) &&
    whole(a.filledCount) !== null && whole(a.filledCount) === whole(b.filledCount) &&
    whole(a.remainingCount) !== null && whole(a.remainingCount) === whole(b.remainingCount);
}

/**
 * Settlement is an account-market record. Prove that its entire market's
 * orders and fills, including aged-out history, belong to just this position.
 * No missing endpoint or incomplete page is interpreted as zero activity.
 */
export function proveSettlementMarketOwnership(input: {
  ticker: string;
  localMarketOrders: LocalOrder[];
  positionOrders: LocalOrder[];
  positionFills: LocalFill[];
  accountFills: KalshiAccountSnapshot["fills"];
  history: KalshiSubmissionEvidence;
}): OwnershipProof {
  const { ticker, localMarketOrders, positionOrders, positionFills, accountFills, history } = input;
  const incomplete = "micro_live_settlement_history_incomplete";
  const foreign = "micro_live_settlement_market_orders_not_exclusive";
  const fillMismatch = "micro_live_settlement_market_fill_mismatch";
  if (history.truncated || history.historicalFillsAvailable !== true ||
      !Array.isArray(history.historicalFills) ||
      !Array.isArray(history.orders) || !Array.isArray(history.fills)) {
    return { verified: false, reason: incomplete };
  }
  if (localMarketOrders.length !== positionOrders.length ||
      localMarketOrders.some((order) => !positionOrders.some((own) => own.id === order.id)) ||
      !positionOrders.length) {
    return { verified: false, reason: foreign };
  }
  const localByExchangeId = new Map<string, LocalOrder>();
  for (const order of positionOrders) {
    if (!order.exchangeOrderId || localByExchangeId.has(order.exchangeOrderId)) {
      return { verified: false, reason: foreign };
    }
    localByExchangeId.set(order.exchangeOrderId, order);
  }

  const ordersById = new Map<string, MarketOrder>();
  for (const order of history.orders) {
    if (!order.id || order.ticker !== ticker) return { verified: false, reason: foreign };
    const previous = ordersById.get(order.id);
    if (previous && !sameOrder(previous, order)) {
      return { verified: false, reason: foreign };
    }
    ordersById.set(order.id, previous ? {
      ...previous,
      outcomeSide: previous.outcomeSide ?? order.outcomeSide,
      bookSide: previous.bookSide ?? order.bookSide,
    } : order);
  }
  if (ordersById.size !== localByExchangeId.size ||
      [...ordersById.keys()].some((id) => !localByExchangeId.has(id))) {
    return { verified: false, reason: foreign };
  }

  const fillsById = new Map<string, MarketFill>();
  for (const fill of history.fills) {
    if (!fill.id || fill.ticker !== ticker) return { verified: false, reason: fillMismatch };
    const previous = fillsById.get(fill.id);
    if (previous && !sameFill(previous, fill)) {
      return { verified: false, reason: fillMismatch };
    }
    fillsById.set(fill.id, previous ? {
      ...mergeDirectionAndPrices(previous, fill),
      feeCostDollars: previous.feeCostDollars ?? fill.feeCostDollars,
    } : fill);
  }
  const historicalIds = new Set<string>();
  for (const fill of history.historicalFills) {
    if (!fill.id || historicalIds.has(fill.id) || fill.ticker !== ticker ||
        !fillsById.has(fill.id) || !sameFill(fill, fillsById.get(fill.id)!)) {
      return { verified: false, reason: fillMismatch };
    }
    historicalIds.add(fill.id);
  }
  for (const fill of accountFills.filter((item) => item.ticker === ticker)) {
    const known = fillsById.get(fill.id);
    if (!known || !sameFill(known, { ...fill, feeCostDollars: fill.feeCostDollars ?? null })) {
      return { verified: false, reason: fillMismatch };
    }
  }
  if (fillsById.size !== positionFills.length ||
      new Set(positionFills.map((fill) => fill.exchangeFillId)).size !== positionFills.length) {
    return { verified: false, reason: fillMismatch };
  }
  for (const [id, exchange] of fillsById) {
    const local = positionFills.find((fill) => fill.exchangeFillId === id);
    if (!local || exchange.orderId === null ||
        localByExchangeId.get(exchange.orderId)?.id !== local.orderId) {
      return { verified: false, reason: fillMismatch };
    }
  }
  for (const [id, exchange] of ordersById) {
    const local = localByExchangeId.get(id)!;
    const initial = whole(exchange.initialCount);
    const filled = whole(exchange.filledCount);
    const remaining = whole(exchange.remainingCount);
    const observed = [...fillsById.values()].filter((fill) => fill.orderId === id);
    const observedTotal = observed.reduce((sum, fill) => sum + (whole(fill.countFp) ?? NaN), 0);
    if (exchange.clientOrderId !== local.clientOrderId ||
        exchange.side !== (local.side === "UP" ? "yes" : "no") ||
        exchange.action !== local.action || exchange.type !== "limit" ||
        exchange.priceDollars === null ||
        dollarsToMicros(exchange.priceDollars) !==
          dollarsToMicros(String(local.requestedLimitPrice)) ||
        initial !== local.requestedContracts || filled === null ||
        remaining === null || filled > initial! || observedTotal !== filled ||
        !["executed", "canceled"].includes(exchange.status) || remaining !== 0 ||
        (exchange.status === "executed" && filled !== initial)) {
      return { verified: false, reason: fillMismatch };
    }
  }
  return {
    verified: true,
    orders: [...ordersById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    fills: [...fillsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}