import type { KalshiDedicatedPairEvidence, KalshiPairEvidenceRecord } from "./kalshiAccountClient";
import type { MicroLiveFill, MicroLiveOrder, MicroLiveSettlement } from "@workspace/db";
import { microLiveOrderLegFillPrice } from "./microLiveFillNormalization";

const MICRO = 1_000_000n;

export type PairCollateralLocalLedger = {
  orders: MicroLiveOrder[];
  fills: MicroLiveFill[];
  settlements: MicroLiveSettlement[];
};

export type PairCollateralSnapshot = {
  status: "verified" | "blocked";
  reason: string;
  checkedAt: number;
  evidenceDigest?: string;
  availableCashMicros?: string;
  inventoryBalanceMicros?: string;
  activityCashDeltaMicros?: string;
  expectedAvailableCashMicros?: string;
  restingEntryReserveMicros?: string;
  filledBuyExposureMicros?: string;
  reconciledFeeMicros?: string;
  filledExposureMicrosByTicker?: Record<string, string>;
  terminalOrderCount?: number;
  restingEntryOrderCount?: number;
  restingExitOrderCount?: number;
  restingExitContractsByPosition?: Record<string, string>;
  positionContractsByTicker?: Record<string, string>;
  matchedOrderCount?: number;
  matchedFillCount?: number;
  matchedSettlementCount?: number;
};

function blocked(reason: string, checkedAt: number): PairCollateralSnapshot {
  return { status: "blocked", reason, checkedAt };
}

function decimalMicros(value: string | null | undefined): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const valueMicros = BigInt(match[2]!) * MICRO +
    BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] === "-" ? -valueMicros : valueMicros;
}

function canonicalMicros(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function amountMicros(quantity: string, price: string): bigint | null {
  const quantityMicros = decimalMicros(quantity);
  const priceMicros = decimalMicros(price);
  if (quantityMicros === null || priceMicros === null ||
      quantityMicros <= 0n || priceMicros <= 0n || priceMicros > MICRO) return null;
  const product = quantityMicros * priceMicros;
  return product % MICRO === 0n ? product / MICRO : null;
}

function positionExposureMicros(record: KalshiPairEvidenceRecord): bigint | null {
  const dollars = detail(record, "market_exposure_dollars");
  if (dollars !== null) return decimalMicros(dollars);
  const cents = detail(record, "market_exposure");
  if (cents === null || !/^-?\d+$/.test(cents)) return null;
  try {
    return BigInt(cents) * 10_000n;
  } catch {
    return null;
  }
}

function detail(record: KalshiPairEvidenceRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record.details[key];
    if (value !== undefined && value !== null && value.trim() !== "") return value;
  }
  return null;
}

function sameTerms(
  a: KalshiPairEvidenceRecord,
  b: KalshiPairEvidenceRecord,
  fields: Array<[string, string[]]>,
): boolean {
  return fields.every(([, keys]) => {
    const left = detail(a, ...keys);
    const right = detail(b, ...keys);
    if (left === null || right === null) return true;
    return left?.toLowerCase() === right?.toLowerCase();
  });
}

const ORDER_FIELDS: Array<[string, string[]]> = [
  ["ticker", ["ticker"]],
  ["side", ["side"]],
  ["action", ["action"]],
  ["type", ["type"]],
  ["status", ["status"]],
  ["initial", ["initial_count_fp", "initial_count"]],
  ["filled", ["fill_count_fp", "fill_count"]],
  ["remaining", ["remaining_count_fp", "remaining_count"]],
  ["yes_price", ["yes_price_dollars", "yes_price"]],
  ["no_price", ["no_price_dollars", "no_price"]],
  ["price", ["price_dollars", "price"]],
  ["client_order_id", ["client_order_id"]],
  ["reduce_only", ["reduce_only"]],
  ["outcome_side", ["outcome_side"]],
  ["book_side", ["book_side"]],
];

const FILL_FIELDS: Array<[string, string[]]> = [
  ["order_id", ["order_id"]],
  ["ticker", ["ticker"]],
  ["side", ["side"]],
  ["action", ["action"]],
  ["count", ["count_fp", "count"]],
  ["yes_price", ["yes_price_dollars", "yes_price"]],
  ["no_price", ["no_price_dollars", "no_price"]],
  ["price", ["price_dollars", "price"]],
  ["outcome_side", ["outcome_side"]],
  ["book_side", ["book_side"]],
  ["fee", ["fee_cost"]],
];

function mergeUniqueRecords(
  records: KalshiPairEvidenceRecord[],
  feeds: readonly KalshiPairEvidenceRecord["feed"][],
  fields: Array<[string, string[]]>,
): { rows: KalshiPairEvidenceRecord[]; reason: string | null } {
  const found = new Map<string, KalshiPairEvidenceRecord>();
  for (const record of records) {
    if (record.classification !== "pair" || !feeds.includes(record.feed)) continue;
    const previous = found.get(record.id);
    if (previous && !sameTerms(previous, record, fields)) {
      return { rows: [], reason: `exchange_${record.feed}_overlap_conflict:${record.id}` };
    }
    if (!previous) {
      found.set(record.id, record);
    } else {
      const details = { ...previous.details };
      for (const [key, value] of Object.entries(record.details)) {
        if (details[key] === null || details[key] === undefined) details[key] = value;
      }
      found.set(record.id, { ...previous, details });
    }
  }
  return { rows: [...found.values()], reason: null };
}

function strategySide(exchangeSide: string): "UP" | "DOWN" | null {
  const side = exchangeSide.toLowerCase();
  return side === "yes" ? "UP" : side === "no" ? "DOWN" : null;
}

function expectedExchangeSide(side: string): "yes" | "no" | null {
  return side === "UP" ? "yes" : side === "DOWN" ? "no" : null;
}

function localPositionId(order: MicroLiveOrder): string | null {
  if (order.action === "sell") return order.exitPositionId;
  return order.positionId ?? `position:${order.marketTicker}:${order.crossingKey}`;
}

function orderStatusMatches(
  exchangeStatus: string,
  localStatus: string,
  remaining: bigint,
  filled: bigint,
): boolean {
  const exchange = exchangeStatus.toLowerCase();
  if (["resting", "pending", "open", "partially_filled", "partial"].includes(exchange)) {
    return remaining > 0n &&
      ["pending", "partial", "unknown"].includes(localStatus);
  }
  if (["canceled", "cancelled", "rejected", "expired", "closed"].includes(exchange)) {
    return remaining === 0n &&
      ["canceled", "rejected", "closed"].includes(localStatus);
  }
  if (["executed", "filled"].includes(exchange)) {
    return remaining === 0n && filled > 0n &&
      ["filled", "closed"].includes(localStatus);
  }
  return false;
}

/**
 * Pure authoritative order/fill/position reconciliation for a persisted (N,2)
 * pair. It uses available cash + resting entry principal as the cash identity;
 * actual fill cash effects already include fees once. Settlement fee_cost is
 * checked as aggregate evidence, never subtracted a second time.
 */
export function reconcilePairCollateralLedger(input: {
  evidence: KalshiDedicatedPairEvidence;
  local: PairCollateralLocalLedger;
  subaccountNumber: number;
  runId: string;
  baselineCashMicros: string;
  now?: number;
}): PairCollateralSnapshot {
  const checkedAt = Date.parse(input.evidence.scanFinishedAt);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(checkedAt) || checkedAt > now + 5_000 ||
      now - checkedAt > 15_000) return blocked("pair_collateral_evidence_stale", checkedAt || 0);
  if (input.evidence.pair.subaccountNumber !== input.subaccountNumber ||
      input.evidence.pair.exchangeIndex !== 2 ||
      input.evidence.balance.subaccountNumber !== input.subaccountNumber ||
      input.evidence.balance.exchangeIndex !== 2 ||
      input.evidence.marketExchangeIndex !== 2 ||
      !input.evidence.keyRestrictionVerified ||
      !input.evidence.tradePermissionVerified) {
    return blocked("pair_collateral_exchange_identity_unproven", checkedAt);
  }
  const reasons = [
    ...(input.evidence.reasons ?? []),
    ...(input.evidence.reason ? [input.evidence.reason] : []),
  ];
  const disallowedReasons = [...new Set(reasons)];
  if (disallowedReasons.length) {
    return blocked(`pair_collateral_account_evidence_incomplete:${disallowedReasons[0]}`, checkedAt);
  }
  const availableCashMicros = input.evidence.collateralSnapshot?.availableCashMicros === null ||
      input.evidence.collateralSnapshot?.availableCashMicros === undefined
    ? decimalMicros(input.evidence.balance.availableCashDollars)
    : canonicalMicros(input.evidence.collateralSnapshot.availableCashMicros);
  const inventoryBalanceMicros =
    input.evidence.collateralSnapshot?.inventoryBalanceMicros === null ||
      input.evidence.collateralSnapshot?.inventoryBalanceMicros === undefined
      ? decimalMicros(input.evidence.balance.balanceDollars)
      : canonicalMicros(input.evidence.collateralSnapshot.inventoryBalanceMicros);
  const baseline = canonicalMicros(input.baselineCashMicros);
  const activityDelta = canonicalMicros(input.evidence.postAnchorCashDeltaMicros);
  if (availableCashMicros === null || inventoryBalanceMicros === null ||
      baseline === null || activityDelta === null || baseline < 0n) {
    return blocked("pair_collateral_cash_snapshot_incomplete", checkedAt);
  }

  const ordersResult = mergeUniqueRecords(input.evidence.records ?? [], [
    "current_order", "historical_order",
  ], ORDER_FIELDS);
  if (ordersResult.reason) return blocked(ordersResult.reason, checkedAt);
  const fillsResult = mergeUniqueRecords(input.evidence.records ?? [], [
    "current_fill", "historical_fill",
  ], FILL_FIELDS);
  if (fillsResult.reason) return blocked(fillsResult.reason, checkedAt);
  const exchangeOrders = new Map(ordersResult.rows.map((record) => [record.id, record]));
  const localOrders = new Map<string, MicroLiveOrder>();
  for (const order of input.local.orders) {
    if (order.microLiveRunId !== input.runId || localOrders.has(order.id)) {
      return blocked("pair_collateral_local_order_run_or_identity_mismatch", checkedAt);
    }
    localOrders.set(order.id, order);
  }
  if (exchangeOrders.size !== localOrders.size) {
    return blocked("pair_collateral_order_count_mismatch", checkedAt);
  }

  const localFills = new Map<string, MicroLiveFill>();
  for (const fill of input.local.fills) {
    if (localFills.has(fill.exchangeFillId)) {
      return blocked(`pair_collateral_duplicate_local_fill:${fill.exchangeFillId}`, checkedAt);
    }
    localFills.set(fill.exchangeFillId, fill);
  }
  const exchangeFills = new Map(fillsResult.rows.map((record) => [record.id, record]));
  if (exchangeFills.size !== localFills.size) {
    return blocked("pair_collateral_fill_count_mismatch", checkedAt);
  }

  let restingEntryReserveMicros = 0n;
  let filledBuyExposureMicros = 0n;
  let reconciledFeeMicros = 0n;
  let terminalOrderCount = 0;
  let restingEntryOrderCount = 0;
  let restingExitOrderCount = 0;
  const fillContractsByOrder = new Map<string, bigint>();
  const positionContractsByTicker = new Map<string, bigint>();
  const buyContractsByPosition = new Map<string, bigint>();
  const sellContractsByPosition = new Map<string, bigint>();
  const restingExitContractsByPosition = new Map<string, bigint>();
  const fillFeesByTicker = new Map<string, bigint>();
  const filledExposureMicrosByTicker = new Map<string, bigint>();
  const settlementRecords = (input.evidence.records ?? []).filter((record) =>
    record.classification === "pair" && record.feed === "settlement");
  const settlementByTicker = new Map(settlementRecords.map((record) =>
    [detail(record, "ticker") ?? "", record]));

  for (const [exchangeId, record] of exchangeOrders) {
    const local = [...localOrders.values()].find((order) =>
      order.exchangeOrderId === exchangeId);
    if (!local) return blocked(`pair_collateral_unowned_exchange_order:${exchangeId}`, checkedAt);
    const localExchangeSide = expectedExchangeSide(local.side);
    const exchangeSide = detail(record, "side")?.toLowerCase() ?? null;
    const action = detail(record, "action")?.toLowerCase() ?? null;
    const ticker = detail(record, "ticker");
    const exchangeStatus = detail(record, "status");
    const initial = decimalMicros(detail(record, "initial_count_fp", "initial_count"));
    const filled = decimalMicros(detail(record, "fill_count_fp", "fill_count"));
    const remaining = decimalMicros(detail(record, "remaining_count_fp", "remaining_count"));
    const price = detail(record,
      exchangeSide === "yes" ? "yes_price_dollars" : "no_price_dollars",
      exchangeSide === "yes" ? "yes_price" : "no_price",
      "price_dollars", "price");
    const priceMicros = decimalMicros(price);
    if (!ticker || !exchangeStatus || initial === null || filled === null ||
        remaining === null || priceMicros === null || !localExchangeSide ||
        localExchangeSide !== exchangeSide || ticker !== local.marketTicker ||
        detail(record, "client_order_id") !== local.clientOrderId ||
        action !== local.action || action !== "buy" && action !== "sell" ||
        detail(record, "type")?.toLowerCase() !== "limit" ||
        priceMicros !== decimalMicros(local.requestedLimitPrice.toFixed(6)) ||
        initial !== BigInt(local.requestedContracts) * MICRO ||
        filled !== BigInt(local.filledContracts) * MICRO ||
        remaining !== BigInt(local.remainingContracts) * MICRO ||
        !orderStatusMatches(exchangeStatus, local.status, remaining, filled)) {
      return blocked(`pair_collateral_order_terms_mismatch:${exchangeId}`, checkedAt);
    }
    const reduceOnly = detail(record, "reduce_only")?.toLowerCase();
    if (action === "sell" && reduceOnly !== "true") {
      return blocked(`pair_collateral_exit_not_authoritatively_reduce_only:${exchangeId}`, checkedAt);
    }
    if (action === "buy" && reduceOnly !== "false") {
      return blocked(`pair_collateral_entry_reduce_only_state_unknown:${exchangeId}`, checkedAt);
    }
    if (remaining > 0n && action === "buy") {
      if (settlementByTicker.has(ticker)) {
        return blocked(`pair_collateral_entry_order_after_settlement:${exchangeId}`, checkedAt);
      }
      const exactReserve = price === null
        ? null : amountMicros(detail(record,
          "remaining_count_fp", "remaining_count") ?? "", price);
      if (exactReserve === null) {
        return blocked(`pair_collateral_entry_reserve_uncomputable:${exchangeId}`, checkedAt);
      }
      restingEntryReserveMicros += exactReserve;
      restingEntryOrderCount += 1;
    }
    if (remaining === 0n) {
      terminalOrderCount += 1;
    }
    if (action === "sell" && remaining > 0n) {
      if (!local.exitPositionId) {
        return blocked(`pair_collateral_exit_position_link_missing:${exchangeId}`, checkedAt);
      }
      if (settlementByTicker.has(ticker)) {
        return blocked(`pair_collateral_exit_order_after_settlement:${exchangeId}`, checkedAt);
      }
      const prior = restingExitContractsByPosition.get(local.exitPositionId) ?? 0n;
      restingExitContractsByPosition.set(local.exitPositionId, prior + remaining);
      restingExitOrderCount += 1;
    }
  }

  for (const [fillId, record] of exchangeFills) {
    const local = localFills.get(fillId);
    if (!local) return blocked(`pair_collateral_unowned_exchange_fill:${fillId}`, checkedAt);
    const order = localOrders.get(local.orderId);
    const exchangeOrderId = detail(record, "order_id");
    const exchangeOrder = exchangeOrderId ? exchangeOrders.get(exchangeOrderId) : undefined;
    if (!order || !exchangeOrder || order.exchangeOrderId !== exchangeOrderId ||
        detail(record, "ticker") !== order.marketTicker) {
      return blocked(`pair_collateral_fill_order_link_mismatch:${fillId}`, checkedAt);
    }
    const normalizedOrderSide = expectedExchangeSide(order.side);
    const normalizedOrder = {
      id: exchangeOrder.id,
      ticker: detail(exchangeOrder, "ticker") ?? "",
      side: detail(exchangeOrder, "side")?.toLowerCase() ?? "",
      action: detail(exchangeOrder, "action")?.toLowerCase() ?? "",
      outcomeSide: detail(exchangeOrder, "outcome_side"),
      bookSide: detail(exchangeOrder, "book_side"),
    };
    if (!normalizedOrderSide || normalizedOrder.side !== normalizedOrderSide ||
        strategySide(normalizedOrder.side) !== order.side) {
      return blocked(`pair_collateral_fill_order_side_mismatch:${fillId}`, checkedAt);
    }
    const fillSide = detail(record, "side")?.toLowerCase() ?? "";
    const count = detail(record, "count_fp", "count");
    const price = detail(record,
      fillSide === "yes" ? "yes_price_dollars" : "no_price_dollars",
      fillSide === "yes" ? "yes_price" : "no_price",
      "price_dollars", "price");
    const feeMicros = decimalMicros(detail(record, "fee_cost"));
    const legPrice = microLiveOrderLegFillPrice({
      orderId: exchangeOrderId,
      ticker: detail(record, "ticker") ?? "",
      side: fillSide,
      action: detail(record, "action")?.toLowerCase() ?? "",
      priceDollars: price,
      yesPriceDollars: detail(record, "yes_price_dollars", "yes_price"),
      noPriceDollars: detail(record, "no_price_dollars", "no_price"),
      outcomeSide: detail(record, "outcome_side"),
      bookSide: detail(record, "book_side"),
    }, normalizedOrder);
    const quantityMicros = decimalMicros(count);
    const localQuantityMicros = BigInt(local.contracts) * MICRO;
    const legPriceMicros = decimalMicros(legPrice);
    const exactTrade = legPriceMicros === null
      ? null : amountMicros(local.contracts.toString(), legPrice!);
    if (!legPrice || !price || !count || feeMicros === null ||
        localQuantityMicros !== quantityMicros ||
        order.action !== local.action ||
        local.exchangeOrderId !== exchangeOrderId ||
        local.positionId !== localPositionId(order) ||
        detail(record, "action")?.toLowerCase() !== local.action ||
        legPriceMicros !== decimalMicros(local.fillPrice.toFixed(6)) ||
        !Number.isSafeInteger(local.tradeMicros) || local.tradeMicros === null ||
        exactTrade === null || BigInt(local.tradeMicros) !== exactTrade ||
        !Number.isSafeInteger(local.feeMicros) || local.feeMicros === null ||
        local.feeKnown !== true ||
        BigInt(local.feeMicros) !== feeMicros ||
        strategySide(normalizedOrder.side) !== order.side) {
      return blocked(`pair_collateral_fill_amount_or_fee_mismatch:${fillId}`, checkedAt);
    }
    const ticker = order.marketTicker;
    const feePrior = fillFeesByTicker.get(ticker) ?? 0n;
    fillFeesByTicker.set(ticker, feePrior + feeMicros);
    reconciledFeeMicros += feeMicros;
    const orderFillPrior = fillContractsByOrder.get(order.id) ?? 0n;
    fillContractsByOrder.set(order.id, orderFillPrior + quantityMicros!);
    const direction = order.side === "UP" ? 1n : -1n;
    const actionDirection = order.action === "buy" ? direction : -direction;
    const positionPrior = positionContractsByTicker.get(ticker) ?? 0n;
    positionContractsByTicker.set(ticker, positionPrior + quantityMicros! / MICRO * actionDirection);
    if (order.action === "buy") {
      const positionId = localPositionId(order);
      if (!positionId) return blocked(`pair_collateral_entry_position_link_missing:${fillId}`, checkedAt);
      const prior = buyContractsByPosition.get(positionId) ?? 0n;
      buyContractsByPosition.set(positionId, prior + quantityMicros!);
    } else if (order.exitPositionId) {
      const prior = sellContractsByPosition.get(order.exitPositionId) ?? 0n;
      sellContractsByPosition.set(order.exitPositionId, prior + quantityMicros!);
    } else {
      return blocked(`pair_collateral_exit_position_link_missing:${fillId}`, checkedAt);
    }
  }
  for (const order of localOrders.values()) {
    const accountFilled = fillContractsByOrder.get(order.id) ?? 0n;
    if (accountFilled !== BigInt(order.filledContracts) * MICRO) {
      return blocked(`pair_collateral_order_fill_total_mismatch:${order.id}`, checkedAt);
    }
  }
  for (const [positionId, reserved] of restingExitContractsByPosition) {
    const held = (buyContractsByPosition.get(positionId) ?? 0n) -
      (sellContractsByPosition.get(positionId) ?? 0n);
    if (reserved > held) {
      return blocked(`pair_collateral_resting_exit_exceeds_owned_position:${positionId}`, checkedAt);
    }
  }

  const lotsByPosition = new Map<string, Array<{
    contracts: bigint;
    unitCostMicros: bigint;
    ticker: string;
    side: string;
  }>>();
  for (const fill of [...input.local.fills].sort((a, b) =>
    a.filledAt.getTime() - b.filledAt.getTime())) {
    const order = input.local.orders.find((candidate) => candidate.id === fill.orderId);
    const positionId = order ? localPositionId(order) : null;
    if (!order || !positionId || fill.contracts <= 0 ||
        fill.tradeMicros === null || !Number.isSafeInteger(fill.tradeMicros) ||
        fill.tradeMicros < 0) {
      return blocked(`pair_collateral_local_filled_exposure_uncomputable:${fill.id}`, checkedAt);
    }
    const lots = lotsByPosition.get(positionId) ?? [];
    if (fill.action === "buy") {
      const tradeMicros = BigInt(fill.tradeMicros);
      if (tradeMicros % BigInt(fill.contracts) !== 0n) {
        return blocked(`pair_collateral_local_filled_exposure_precision_invalid:${fill.id}`, checkedAt);
      }
      lots.push({
        contracts: BigInt(fill.contracts),
        unitCostMicros: tradeMicros / BigInt(fill.contracts),
        ticker: order.marketTicker,
        side: order.side,
      });
    } else {
      let remaining = BigInt(fill.contracts);
      while (remaining > 0n) {
        const lot = lots.find((candidate) => candidate.contracts > 0n);
        if (!lot || lot.ticker !== order.marketTicker || lot.side !== order.side) {
          return blocked(`pair_collateral_local_sell_exceeds_filled_exposure:${fill.id}`, checkedAt);
        }
        const consumed = remaining < lot.contracts ? remaining : lot.contracts;
        lot.contracts -= consumed;
        remaining -= consumed;
      }
    }
    lotsByPosition.set(positionId, lots);
  }
  for (const lots of lotsByPosition.values()) {
    for (const lot of lots) {
      if (!settlementByTicker.has(lot.ticker)) {
        const exposure = lot.contracts * lot.unitCostMicros;
        filledBuyExposureMicros += exposure;
        filledExposureMicrosByTicker.set(
          lot.ticker,
          (filledExposureMicrosByTicker.get(lot.ticker) ?? 0n) + exposure,
        );
      }
    }
  }

  const positionRecords = (input.evidence.records ?? []).filter((record) =>
    record.classification === "pair" && record.feed === "position");
  const exchangePositions = new Map(positionRecords.map((record) =>
    [detail(record, "ticker") ?? "", decimalMicros(
      detail(record, "position_fp", "position"),
    )]));
  const exchangeExposure = new Map(positionRecords.map((record) =>
    [detail(record, "ticker") ?? "", positionExposureMicros(record)]));
  if (exchangePositions.size !== positionRecords.length ||
      [...exchangePositions.values()].some((value) => value === null) ||
      [...exchangeExposure.values()].some((value) => value === null)) {
    return blocked("pair_collateral_position_snapshot_invalid", checkedAt);
  }
  const allTickers = new Set([
    ...positionContractsByTicker.keys(), ...exchangePositions.keys(),
    ...settlementByTicker.keys(),
  ]);
  for (const ticker of allTickers) {
    const localPosition = positionContractsByTicker.get(ticker) ?? 0n;
    const actual = exchangePositions.get(ticker) ?? 0n;
    const expected = settlementByTicker.has(ticker) ? 0n : localPosition;
    if (actual !== expected * MICRO) {
      return blocked(`pair_collateral_inventory_position_mismatch:${ticker}`, checkedAt);
    }
    const actualExposure = exchangeExposure.get(ticker) ?? 0n;
    const expectedExposure = settlementByTicker.has(ticker)
      ? 0n : filledExposureMicrosByTicker.get(ticker) ?? 0n;
    if (actualExposure !== expectedExposure) {
      return blocked(`pair_collateral_filled_exposure_mismatch:${ticker}`, checkedAt);
    }
  }

  const settlementRows = new Map(input.local.settlements.map((row) => [row.marketTicker, row]));
  if (settlementRows.size !== settlementRecords.length) {
    return blocked("pair_collateral_settlement_count_mismatch", checkedAt);
  }
  for (const [ticker, record] of settlementByTicker) {
    const local = settlementRows.get(ticker);
    const revenueCents = detail(record, "revenue");
    const revenue = revenueCents !== null && /^\d+$/.test(revenueCents)
      ? BigInt(revenueCents) * 10_000n : null;
    const fee = decimalMicros(detail(record, "fee_cost"));
    const expectedCount = local === undefined ? null : BigInt(local.contracts) * MICRO;
    const winningCount = decimalMicros(
      detail(record, local?.side === "UP" ? "yes_count_fp" : "no_count_fp"),
    );
    const oppositeCount = decimalMicros(
      detail(record, local?.side === "UP" ? "no_count_fp" : "yes_count_fp"),
    );
    const settledAtMs = record.occurredAt === null ? NaN : Date.parse(record.occurredAt);
    if (!local || revenue === null || fee === null ||
        BigInt(local.payoutMicros) !== revenue ||
        detail(record, "market_result") !== local.marketResult ||
        expectedCount !== winningCount || oppositeCount !== 0n ||
        !Number.isFinite(settledAtMs) || settledAtMs !== local.settledAt.getTime() ||
        local.feeMicros === null || BigInt(local.feeMicros) !== fee ||
        fillFeesByTicker.get(ticker) !== fee ||
        local.contracts !== Math.abs(Number(positionContractsByTicker.get(ticker) ?? 0n))) {
      return blocked(`pair_collateral_settlement_amount_or_fee_mismatch:${ticker}`, checkedAt);
    }
  }

  const expectedAvailable = baseline + activityDelta - restingEntryReserveMicros;
  if (expectedAvailable !== availableCashMicros || expectedAvailable < 0n) {
    return blocked("pair_collateral_cash_plus_reserved_activity_mismatch", checkedAt);
  }
  if (availableCashMicros + restingEntryReserveMicros !== inventoryBalanceMicros) {
    return blocked("pair_collateral_inventory_available_and_reserved_mismatch", checkedAt);
  }
  const readerReserve = canonicalMicros(
    input.evidence.collateralSnapshot?.restingEntryReserveMicros,
  );
  if (readerReserve === null || readerReserve !== restingEntryReserveMicros) {
    return blocked("pair_collateral_order_reserve_snapshot_mismatch", checkedAt);
  }
  const positionsOut = Object.fromEntries([...allTickers].map((ticker) => [
    ticker, (settlementByTicker.has(ticker)
      ? 0n : positionContractsByTicker.get(ticker) ?? 0n).toString(),
  ]));
  const exposureOut = Object.fromEntries([...allTickers].map((ticker) => [
    ticker, (settlementByTicker.has(ticker)
      ? 0n : filledExposureMicrosByTicker.get(ticker) ?? 0n).toString(),
  ]));
  const exitsOut = Object.fromEntries([...restingExitContractsByPosition.entries()].map(
    ([positionId, value]) => [positionId, value.toString()],
  ));
  return {
    status: "verified",
    reason: "pair_collateral_reconciled",
    checkedAt,
    availableCashMicros: availableCashMicros.toString(),
    inventoryBalanceMicros: inventoryBalanceMicros.toString(),
    activityCashDeltaMicros: activityDelta.toString(),
    expectedAvailableCashMicros: expectedAvailable.toString(),
    restingEntryReserveMicros: restingEntryReserveMicros.toString(),
    filledBuyExposureMicros: filledBuyExposureMicros.toString(),
    reconciledFeeMicros: reconciledFeeMicros.toString(),
    filledExposureMicrosByTicker: exposureOut,
    terminalOrderCount,
    restingEntryOrderCount,
    restingExitOrderCount,
    restingExitContractsByPosition: exitsOut,
    positionContractsByTicker: positionsOut,
    matchedOrderCount: exchangeOrders.size,
    matchedFillCount: exchangeFills.size,
    matchedSettlementCount: settlementRows.size,
  };
}