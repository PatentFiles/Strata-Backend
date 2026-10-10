/**
 * Pure reconstruction of live position state from the persisted order/fill
 * ledger. No timestamps are generated and no row is mutated, so replaying the
 * same ledger after a restart produces the same result.
 */
export type MicroLivePositionOrder = {
  id: string;
  marketTicker: string;
  crossingKey: string;
  triggerType: string;
  action: string;
  intent: string;
  positionId: string | null;
  exitPositionId: string | null;
  side: string;
  status: string;
  requestedLimitPrice: number;
  requestedContracts: number;
  requestedStakeCents: number;
  reservedRiskCents: number;
  filledContracts: number;
  remainingContracts: number;
};

export type MicroLivePositionFill = {
  id: string;
  orderId: string;
  exchangeFillId: string;
  filledAt: string | Date;
  contracts: number;
  fillPrice: number;
  action: string;
  positionId: string | null;
  costCents: number;
  feeCents: number;
  feeKnown: boolean;
  proceedsCents: number | null;
  costBasisCents: number | null;
  /** Gross trade value in integer millionths of a dollar, when available. */
  tradeMicros?: number | null;
  /** Fee in integer millionths of a dollar; null or absent means unknown. */
  feeMicros?: number | null;
};

export type MicroLivePositionSettlement = {
  positionId: string;
  marketTicker: string;
  side: string;
  contracts: number;
  payoutMicros: number;
  feeMicros: number | null;
  settledAt: string | Date;
};

export type MicroLivePositionInput = {
  orders: readonly MicroLivePositionOrder[];
  fills: readonly MicroLivePositionFill[];
  settlements?: readonly MicroLivePositionSettlement[];
  /** Restrict results to one resolved position ID. */
  positionId?: string;
  /** Mark is a reliable executable sell-side price, not a mid or buy quote. */
  sellSideMark?: { price: number; reliable: boolean };
  limits?: {
    maxContracts?: number;
    maxFilledCostCents?: number;
    maxReservedRiskCents?: number;
  };
};

export type MicroLivePositionState =
  | "entry_pending"
  | "entry_partial"
  | "entry_filled"
  | "confirm_pending"
  | "confirm_partial"
  | "confirm_filled"
  | "exit_requested"
  | "exit_partial"
  | "settled"
  | "closed"
  | "canceled"
  | "rejected"
  | "unknown";

export type MicroLivePositionAnomaly = {
  code: string;
  rowId?: string;
  detail: string;
};

export type ReconstructedMicroLivePosition = {
  positionId: string;
  marketTicker: string;
  side: string;
  state: MicroLivePositionState;
  contractsBought: number;
  contractsSold: number;
  sellableContracts: number;
  outstandingSellContracts: number;
  confirmedFilledCostCents: number;
  openCostCents: number;
  openExposureCents: number;
  reservedBuyRiskCents: number;
  realizedPnlCents: number | null;
  realizedPnlMicros: number | null;
  unrealizedPnlCents: number | null;
  closed: boolean;
  anomalies: MicroLivePositionAnomaly[];
};

export type MicroLivePositionResult = {
  positions: ReconstructedMicroLivePosition[];
  anomalies: MicroLivePositionAnomaly[];
  reservedBuyRiskCents: number;
  /** Open FIFO basis plus unfilled active-buy reservations, without double-counting fills. */
  effectiveCommittedRiskCents: number;
  confirmedFilledCostCents: number;
  openCostCents: number;
  openExposureCents: number;
  realizedPnlCents: number | null;
  realizedPnlMicros: number | null;
  unrealizedPnlCents: number | null;
};

const ACTIVE = new Set(["pending", "unknown", "partial"]);
const TERMINAL = new Set(["filled", "closed", "canceled", "rejected"]);
const validCents = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validMicros = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;
const cents = (contracts: number, price: number) => Math.round(contracts * price * 100);
const reservedCents = (contracts: number, price: number) =>
  Math.ceil(contracts * price * 100 - 1e-8);
const MICROS_PER_CENT = 10_000n;

/** Cumulative-floor allocation keeps every partial slice integer-exact and sums to its source. */
function allocatedMicros(totalMicros: number, before: number, after: number, contracts: number): bigint {
  const total = BigInt(totalMicros);
  const denominator = BigInt(contracts);
  return total * BigInt(after) / denominator - total * BigInt(before) / denominator;
}

function microsToCents(value: bigint): number | null {
  const rounded = value < 0n
    ? -((-value + MICROS_PER_CENT / 2n) / MICROS_PER_CENT)
    : (value + MICROS_PER_CENT / 2n) / MICROS_PER_CENT;
  const asNumber = Number(rounded);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

type Lot = {
  fill: MicroLivePositionFill;
  remaining: number;
};

function stateFor(
  entryOrders: MicroLivePositionOrder[],
  confirmOrders: MicroLivePositionOrder[],
  exitOrders: MicroLivePositionOrder[],
  bought: number,
  sold: number,
  outstandingSell: number,
): MicroLivePositionState {
  const relevant = [...entryOrders, ...confirmOrders, ...exitOrders];
  if (relevant.some((row) => row.status === "unknown")) return "unknown";
  if (bought > 0 && bought === sold && outstandingSell === 0) return "closed";
  if (exitOrders.length) {
    if (sold > 0) return "exit_partial";
    if (exitOrders.every((row) => row.status === "rejected")) return "rejected";
    if (exitOrders.every((row) => row.status === "canceled")) return "canceled";
    return "exit_requested";
  }
  if (confirmOrders.length) {
    if (confirmOrders.some((row) => row.status === "pending")) return "confirm_pending";
    if (confirmOrders.some((row) => row.status === "partial") || confirmOrders.some((row) => row.status === "canceled" && row.filledContracts > 0)) {
      return "confirm_partial";
    }
    if (confirmOrders.some((row) => row.status === "rejected")) return "rejected";
    if (confirmOrders.some((row) => row.status === "canceled")) return "canceled";
    return "confirm_filled";
  }
  if (entryOrders.some((row) => row.status === "pending")) return "entry_pending";
  if (entryOrders.some((row) => row.status === "partial") || entryOrders.some((row) => row.status === "canceled" && row.filledContracts > 0)) {
    return "entry_partial";
  }
  if (entryOrders.some((row) => row.status === "unknown")) return "unknown";
  if (entryOrders.some((row) => row.status === "rejected")) return "rejected";
  if (entryOrders.some((row) => row.status === "canceled")) return "canceled";
  return bought > 0 ? "entry_filled" : "entry_pending";
}

function compareFills(a: MicroLivePositionFill, b: MicroLivePositionFill) {
  const timeA = (a.filledAt instanceof Date ? a.filledAt : new Date(a.filledAt)).getTime();
  const timeB = (b.filledAt instanceof Date ? b.filledAt : new Date(b.filledAt)).getTime();
  return timeA - timeB || a.id.localeCompare(b.id);
}

/** FIFO basis for the next actual sell fill; fees are included only when known. */
export function fifoExitCostBasis(
  buyFills: readonly MicroLivePositionFill[],
  priorSellFills: readonly MicroLivePositionFill[],
  contracts: number,
): number | null {
  if (!validCount(contracts) || contracts <= 0) return null;
  let alreadySold = priorSellFills.reduce((sum, fill) => sum + fill.contracts, 0);
  let remaining = contracts;
  let basis = 0;
  for (const buy of buyFills.slice().sort(compareFills)) {
    if (buy.action !== "buy" || !validCount(buy.contracts) || buy.contracts <= 0 ||
        !validCents(buy.costCents) || !validCents(buy.feeCents)) return null;
    const consumed = Math.min(buy.contracts, alreadySold);
    alreadySold -= consumed;
    const take = Math.min(buy.contracts - consumed, remaining);
    if (take > 0) {
      const before = Math.floor(buy.costCents * consumed / buy.contracts);
      const after = consumed + take === buy.contracts
        ? buy.costCents : Math.floor(buy.costCents * (consumed + take) / buy.contracts);
      basis += after - before;
      if (buy.feeKnown) {
        const feeBefore = Math.floor(buy.feeCents * consumed / buy.contracts);
        const feeAfter = consumed + take === buy.contracts
          ? buy.feeCents : Math.floor(buy.feeCents * (consumed + take) / buy.contracts);
        basis += feeAfter - feeBefore;
      }
      remaining -= take;
    }
  }
  return remaining === 0 && alreadySold === 0 ? basis : null;
}

export function reconstructMicroLivePositions(input: MicroLivePositionInput): MicroLivePositionResult {
  const anomalies: MicroLivePositionAnomaly[] = [];
  const addAnomaly = (code: string, detail: string, rowId?: string) => {
    anomalies.push({ code, detail, ...(rowId ? { rowId } : {}) });
  };
  const orderById = new Map<string, MicroLivePositionOrder>();
  for (const order of input.orders) {
    if (orderById.has(order.id)) addAnomaly("duplicate_order_id", "Order IDs must be unique.", order.id);
    else orderById.set(order.id, order);
    if (!Number.isSafeInteger(order.requestedContracts) || order.requestedContracts <= 0 ||
        !validCount(order.filledContracts) || !validCount(order.remainingContracts) ||
        order.filledContracts + order.remainingContracts > order.requestedContracts) {
      addAnomaly("inconsistent_order_counts", "Requested, filled, and remaining contract counts are inconsistent.", order.id);
    }
    if (!validCents(order.reservedRiskCents) || !validCents(order.requestedStakeCents)) {
      addAnomaly("invalid_order_risk", "Order risk amounts must be non-negative safe integer cents.", order.id);
    }
    if (!["buy", "sell"].includes(order.action) ||
        (order.action === "buy" && order.intent !== "entry") ||
        (order.action === "sell" && order.intent !== "exit")) {
      addAnomaly("wrong_order_action", "Order action and intent do not describe an entry buy or exit sell.", order.id);
    }
    if (!TERMINAL.has(order.status) && !ACTIVE.has(order.status)) {
      addAnomaly("unknown_order_status", `Unrecognized order status: ${order.status}.`, order.id);
    }
    if (order.status === "partial" && (order.filledContracts <= 0 || order.remainingContracts <= 0)) {
      addAnomaly("inconsistent_order_status", "Partial status requires both filled and remaining contracts.", order.id);
    }
    if (order.status === "filled" && order.remainingContracts !== 0) {
      addAnomaly("inconsistent_order_status", "Filled status requires zero remaining contracts.", order.id);
    }
  }

  const uniqueFills = new Map<string, MicroLivePositionFill>();
  const localFillIds = new Set<string>();
  for (const fill of input.fills) {
    const key = fill.exchangeFillId || fill.id;
    if (uniqueFills.has(key) || localFillIds.has(fill.id)) {
      addAnomaly("duplicate_fill", "Exchange fill IDs must be unique.", fill.id);
      continue;
    }
    uniqueFills.set(key, fill);
    localFillIds.add(fill.id);
    const filledAt = fill.filledAt instanceof Date ? fill.filledAt.getTime() : Date.parse(fill.filledAt);
    if (!Number.isFinite(filledAt)) addAnomaly("invalid_fill_time", "Fill timestamp must be a valid date.", fill.id);
  }

  const fillsByOrder = new Map<string, MicroLivePositionFill[]>();
  for (const fill of uniqueFills.values()) {
    const order = orderById.get(fill.orderId);
    if (!order) {
      addAnomaly("orphan_fill", "Fill has no matching local order.", fill.id);
      continue;
    }
    if (!validCount(fill.contracts) || fill.contracts <= 0 ||
        !Number.isFinite(fill.fillPrice) || fill.fillPrice <= 0 || fill.fillPrice > 1 ||
        !validCents(fill.costCents) || !validCents(fill.feeCents) ||
        (fill.tradeMicros != null && !validMicros(fill.tradeMicros)) ||
        (fill.feeMicros != null && !validMicros(fill.feeMicros))) {
      addAnomaly("invalid_fill_values", "Fill contracts, price, cost, or fee are invalid.", fill.id);
    }
    if (fill.action !== order.action) {
      addAnomaly("wrong_fill_action", "Fill action does not match its parent order.", fill.id);
    }
    if (fill.positionId && order.action === "sell" && fill.positionId !== order.exitPositionId) {
      addAnomaly("wrong_fill_position", "Sell fill position does not match its exit order.", fill.id);
    }
    const list = fillsByOrder.get(fill.orderId) ?? [];
    list.push(fill);
    fillsByOrder.set(fill.orderId, list);
  }

  const orderPosition = new Map<string, string>();
  const positions = new Map<string, {
    orders: MicroLivePositionOrder[];
    fills: MicroLivePositionFill[];
    settlements: MicroLivePositionSettlement[];
    marketTicker: string;
    side: string;
  }>();
  const ensurePosition = (id: string, order?: MicroLivePositionOrder) => {
    let value = positions.get(id);
    if (!value) {
      value = { orders: [], fills: [], settlements: [], marketTicker: order?.marketTicker ?? "", side: order?.side ?? "" };
      positions.set(id, value);
    }
    if (order && value.orders.every((candidate) => candidate.id !== order.id)) value.orders.push(order);
    if (order && value.marketTicker && (value.marketTicker !== order.marketTicker || value.side !== order.side)) {
      addAnomaly("wrong_position_market_or_side", "Orders grouped into one position must share market and side.", order.id);
    }
    return value;
  };

  for (const order of input.orders) {
    let id: string;
    if (order.action === "sell") {
      id = order.exitPositionId ?? "";
      if (!id) addAnomaly("missing_exit_position", "Exit sell order must identify the position it closes.", order.id);
    } else {
      const orderFills = fillsByOrder.get(order.id) ?? [];
      const fillId = orderFills.find((fill) => fill.positionId)?.positionId;
      id = order.positionId ?? fillId ?? `position:${order.marketTicker}:${order.crossingKey}`;
      if (order.positionId && fillId && order.positionId !== fillId) {
        addAnomaly("wrong_fill_position", "Entry fill position does not match its entry order.", order.id);
      }
    }
    if (!id) continue;
    orderPosition.set(order.id, id);
    ensurePosition(id, order);
  }

  for (const fill of uniqueFills.values()) {
    const order = orderById.get(fill.orderId);
    if (!order) continue;
    const id = orderPosition.get(order.id);
    if (!id) continue;
    if (fill.positionId && fill.positionId !== id) {
      addAnomaly("wrong_fill_position", "Fill position does not match the resolved parent position.", fill.id);
    }
    ensurePosition(id, order).fills.push(fill);
  }

  const settlementByPosition = new Map<string, MicroLivePositionSettlement>();
  const settlementAnomaliesByPosition = new Map<string, MicroLivePositionAnomaly[]>();
  const addSettlementAnomaly = (positionId: string, code: string, detail: string) => {
    const anomaly = { code, detail, rowId: positionId };
    anomalies.push(anomaly);
    const list = settlementAnomaliesByPosition.get(positionId) ?? [];
    list.push(anomaly);
    settlementAnomaliesByPosition.set(positionId, list);
  };
  const settlementsByPosition = new Map<string, MicroLivePositionSettlement[]>();
  for (const settlement of input.settlements ?? []) {
    if (typeof settlement.positionId !== "string" || !settlement.positionId.trim()) {
      addAnomaly("invalid_settlement", "Settlement must identify a position.");
      continue;
    }
    const id = settlement.positionId;
    const position = ensurePosition(id);
    position.settlements.push(settlement);
    if (position.marketTicker && position.marketTicker !== settlement.marketTicker ||
        position.side && position.side !== settlement.side) {
      addSettlementAnomaly(id, "settlement_identity_mismatch",
        "Settlement market or side differs from the resolved position.");
    } else {
      if (!position.marketTicker) position.marketTicker = settlement.marketTicker;
      if (!position.side) position.side = settlement.side;
    }
    const settledAt = settlement.settledAt instanceof Date
      ? settlement.settledAt.getTime()
      : Date.parse(settlement.settledAt);
    if (!settlement.marketTicker || !settlement.side ||
        !validCount(settlement.contracts) ||
        !validMicros(settlement.payoutMicros) ||
        (settlement.feeMicros !== null && !validMicros(settlement.feeMicros)) ||
        !Number.isFinite(settledAt)) {
      addSettlementAnomaly(id, "invalid_settlement",
        "Settlement identity, contracts, payout, fee, or timestamp is invalid.");
    }
    const list = settlementsByPosition.get(id) ?? [];
    list.push(settlement);
    settlementsByPosition.set(id, list);
  }
  for (const [positionId, records] of settlementsByPosition) {
    const settlement = records[0]!;
    if (records.length > 1) {
      addSettlementAnomaly(positionId, "duplicate_settlement",
        "Only one settlement record is allowed per position; identical duplicate records are applied once.");
      const firstSettledAt = settlement.settledAt instanceof Date
        ? settlement.settledAt.getTime()
        : Date.parse(settlement.settledAt);
      const duplicatesMatch = records.every((record) => {
        const settledAt = record.settledAt instanceof Date
          ? record.settledAt.getTime()
          : Date.parse(record.settledAt);
        return record.positionId === settlement.positionId &&
          record.marketTicker === settlement.marketTicker &&
          record.side === settlement.side &&
          record.contracts === settlement.contracts &&
          record.payoutMicros === settlement.payoutMicros &&
          record.feeMicros === settlement.feeMicros &&
          settledAt === firstSettledAt;
      });
      if (!duplicatesMatch) continue;
    }
    const alreadyInvalid = (settlementAnomaliesByPosition.get(positionId) ?? [])
      .some((item) => item.code !== "duplicate_settlement");
    if (!alreadyInvalid) settlementByPosition.set(positionId, settlement);
  }

  const results: ReconstructedMicroLivePosition[] = [];
  for (const [positionId, data] of positions) {
    if (input.positionId && input.positionId !== positionId) continue;
    const positionAnomalies: MicroLivePositionAnomaly[] = [];
    const addPositionAnomaly = (code: string, detail: string, rowId?: string) => {
      const item = { code, detail, ...(rowId ? { rowId } : {}) };
      positionAnomalies.push(item);
      anomalies.push(item);
    };
    for (const item of settlementAnomaliesByPosition.get(positionId) ?? []) {
      if (!positionAnomalies.some((existing) =>
        existing.code === item.code && existing.detail === item.detail && existing.rowId === item.rowId)) {
        positionAnomalies.push(item);
      }
    }
    const orders = data.orders;
    const entryOrders = orders.filter((order) => order.action === "buy" && order.intent === "entry");
    const confirmOrders = entryOrders.filter((order) => order.triggerType === "CONFIRM");
    const scoutOrders = entryOrders.filter((order) => order.triggerType !== "CONFIRM");
    const exitOrders = orders.filter((order) => order.action === "sell" && order.intent === "exit");
    const positionFills = data.fills.slice().sort(compareFills);
    const buyFills = positionFills.filter((fill) => fill.action === "buy");
    const sellFills = positionFills.filter((fill) => fill.action === "sell");
    const filledCountByOrder = new Map<string, number>();
    for (const fill of positionFills) {
      filledCountByOrder.set(fill.orderId, (filledCountByOrder.get(fill.orderId) ?? 0) + fill.contracts);
    }
    for (const order of orders) {
      if ((filledCountByOrder.get(order.id) ?? 0) !== order.filledContracts) {
        addPositionAnomaly("order_fill_count_mismatch", "Order filledContracts does not equal its actual fill rows.", order.id);
      }
    }
    for (const order of exitOrders) {
      if (order.side !== data.side) {
        addPositionAnomaly("wrong_exit_side", "Exit order side differs from the bought position side.", order.id);
      }
    }

    const lots: Lot[] = buyFills.map((fill) => ({ fill, remaining: fill.contracts }));
    const microAccountingPresent = data.settlements.length > 0 || positionFills.some((fill) =>
      fill.tradeMicros !== undefined || fill.feeMicros !== undefined);
    let realizedMicros = 0n;
    let realizedMicrosKnown = microAccountingPresent;
    const contractsBought = buyFills.reduce((sum, fill) => sum + fill.contracts, 0);
    const contractsSold = sellFills.reduce((sum, fill) => sum + fill.contracts, 0);
    let realized = 0;
    let realizedKnown = true;
    let openCostCents = 0;
    let openCostKnown = true;
    let allocatedSellBasis = 0;
    for (const fill of sellFills) {
      if (!validCents(fill.proceedsCents ?? -1) || !validCents(fill.costBasisCents ?? -1)) {
        addPositionAnomaly("missing_sell_accounting", "Sell fills require proceeds and FIFO cost-basis evidence.", fill.id);
      }
      let quantity = fill.contracts;
      let basis = 0;
      let buyFeesKnown = true;
      let microBasis = 0n;
      let microBuyFees = 0n;
      for (const lot of lots) {
        if (quantity === 0) break;
        if (lot.remaining === 0) continue;
        const take = Math.min(quantity, lot.remaining);
        const before = lot.fill.contracts;
        const consumedBefore = before - lot.remaining;
        const consumedAfter = consumedBefore + take;
        const baseBefore = Math.floor(lot.fill.costCents * consumedBefore / before);
        const baseAfter = consumedAfter === before
          ? lot.fill.costCents
          : Math.floor(lot.fill.costCents * consumedAfter / before);
        basis += baseAfter - baseBefore;
        if (!lot.fill.feeKnown) buyFeesKnown = false;
        else {
          const feeBefore = Math.floor(lot.fill.feeCents * consumedBefore / before);
          const feeAfter = consumedAfter === before
            ? lot.fill.feeCents
            : Math.floor(lot.fill.feeCents * consumedAfter / before);
          basis += feeAfter - feeBefore;
        }
        if (microAccountingPresent) {
          if (validMicros(lot.fill.tradeMicros ?? -1)) {
            microBasis += allocatedMicros(lot.fill.tradeMicros!, consumedBefore, consumedAfter, before);
          } else {
            realizedMicrosKnown = false;
          }
          if (validMicros(lot.fill.feeMicros ?? -1)) {
            microBuyFees += allocatedMicros(lot.fill.feeMicros!, consumedBefore, consumedAfter, before);
          } else {
            // In the micro-dollar ledger, an absent fee is unknown rather than zero.
            realizedMicrosKnown = false;
          }
        }
        lot.remaining -= take;
        quantity -= take;
      }
      if (quantity > 0) {
        addPositionAnomaly("oversell", "Sell fills exceed actual buy fills for this position.", fill.id);
        if (microAccountingPresent) realizedMicrosKnown = false;
      }
      if (microAccountingPresent) {
        if (validMicros(fill.tradeMicros ?? -1) && validMicros(fill.feeMicros ?? -1) && quantity === 0) {
          realizedMicros += BigInt(fill.tradeMicros!) - microBasis - microBuyFees - BigInt(fill.feeMicros!);
        } else {
          realizedMicrosKnown = false;
        }
      }
      allocatedSellBasis += basis;
      if (fill.costBasisCents !== null && fill.costBasisCents !== basis) {
        addPositionAnomaly("sell_basis_mismatch", "Recorded sell cost basis differs from deterministic FIFO basis.", fill.id);
      }
      if (!fill.feeKnown || !buyFeesKnown || fill.proceedsCents === null || quantity > 0) {
        realizedKnown = false;
      } else {
        realized += fill.proceedsCents - basis - fill.feeCents;
      }
    }
    const outstandingSellContracts = exitOrders.filter((order) => ACTIVE.has(order.status))
      .reduce((sum, order) => sum + order.remainingContracts, 0);
    let settlementApplied = false;
    const settlement = settlementByPosition.get(positionId);
    if (settlement) {
      const remainingContracts = lots.reduce((sum, lot) => sum + lot.remaining, 0);
      if (contractsBought <= 0 ||
          settlement.contracts !== contractsBought - contractsSold ||
          settlement.contracts !== remainingContracts) {
        addPositionAnomaly("settlement_quantity_mismatch",
          "Settlement contracts must equal the remaining bought contracts after sells.", positionId);
      } else if (outstandingSellContracts !== 0) {
        addPositionAnomaly("settlement_outstanding_sell",
          "Settlement cannot be applied while sell contracts remain outstanding.", positionId);
      } else {
        let settlementBasis = 0n;
        let settlementBuyFees = 0n;
        for (const lot of lots) {
          if (lot.remaining <= 0) continue;
          const before = lot.fill.contracts - lot.remaining;
          const after = lot.fill.contracts;
          if (validMicros(lot.fill.tradeMicros ?? -1)) {
            settlementBasis += allocatedMicros(lot.fill.tradeMicros!, before, after, lot.fill.contracts);
          } else {
            realizedMicrosKnown = false;
          }
          if (validMicros(lot.fill.feeMicros ?? -1)) {
            settlementBuyFees += allocatedMicros(lot.fill.feeMicros!, before, after, lot.fill.contracts);
          } else {
            realizedMicrosKnown = false;
          }
        }
        if (settlement.feeMicros === null) {
          realizedMicrosKnown = false;
        } else {
          // The settlement fee_cost is the cumulative market trading fee,
          // already attributed to individual fills. It is evidence, not a
          // second fee charged when the remaining contracts settle.
          realizedMicros += BigInt(settlement.payoutMicros) -
            settlementBasis - settlementBuyFees;
        }
        for (const lot of lots) lot.remaining = 0;
        settlementApplied = true;
      }
    }
    const remainingLots = lots.filter((lot) => lot.remaining > 0);
    for (const lot of remainingLots) {
      const consumed = lot.fill.contracts - lot.remaining;
      const baseCost = lot.fill.costCents -
        Math.floor(lot.fill.costCents * consumed / lot.fill.contracts);
      openCostCents += baseCost;
      if (lot.fill.feeKnown) {
        openCostCents += lot.fill.feeCents -
          Math.floor(lot.fill.feeCents * consumed / lot.fill.contracts);
      } else {
        openCostKnown = false;
      }
    }
    const sellableContracts = settlementApplied
      ? 0
      : contractsBought - contractsSold - outstandingSellContracts;
    if (sellableContracts < 0) {
      addPositionAnomaly("oversell_or_over_reserved", "Sell fills and outstanding sell orders exceed actual bought contracts.");
    }
    if (sellFills.some((fill) => !exitOrders.some((order) => order.id === fill.orderId))) {
      addPositionAnomaly("orphan_exit_fill", "Sell fill does not belong to an exit order.");
    }
    const reservedBuyRiskCents = entryOrders.filter((order) => ACTIVE.has(order.status))
      .reduce((sum, order) => sum + order.reservedRiskCents, 0);
    const confirmedFilledCostCents = buyFills.reduce((sum, fill) => sum + fill.costCents, 0);
    const ledgerConsistentForClose = !positionAnomalies.some((item) => [
      "inconsistent_order_counts",
      "invalid_order_risk",
      "inconsistent_order_status",
      "order_fill_count_mismatch",
      "invalid_fill_values",
      "wrong_fill_action",
      "wrong_fill_position",
      "wrong_exit_side",
      "orphan_exit_fill",
      "missing_sell_accounting",
      "sell_basis_mismatch",
      "oversell",
      "oversell_or_over_reserved",
    ].includes(item.code));
    const closed = settlementApplied
      ? outstandingSellContracts === 0 && ledgerConsistentForClose
      : contractsBought > 0 && contractsBought === contractsSold &&
        outstandingSellContracts === 0 && sellableContracts === 0 &&
        ledgerConsistentForClose;
    const computedState = stateFor(entryOrders, confirmOrders, exitOrders, contractsBought, contractsSold, outstandingSellContracts);
    const state = settlementApplied && closed
      ? "settled"
      : computedState === "closed" && !closed ? "exit_partial" : computedState;
    // If the ledger cannot prove closure, retain conservative exposure rather
    // than report zero risk from a contradictory or incomplete sell history.
    if (!closed && contractsBought > 0 &&
        (contractsBought === contractsSold && outstandingSellContracts === 0 || settlementApplied)) {
      openCostCents = Math.max(openCostCents, buyFills.reduce((sum, fill) => sum + fill.costCents, 0));
      openCostKnown = false;
    }
    const mark = input.sellSideMark;
    const unrealizedPnlCents = closed || !remainingLots.length || !mark?.reliable ||
      !Number.isFinite(mark.price) || mark.price < 0 || mark.price > 1 || !openCostKnown
      ? null
      : cents(remainingLots.reduce((sum, lot) => sum + lot.remaining, 0), mark.price) - openCostCents;
    const realizedAccountingConsistent = !positionAnomalies.some((item) =>
      item.code === "oversell" || item.code === "sell_basis_mismatch" || item.code === "missing_sell_accounting");
    const realizedPnlMicrosValue = microAccountingPresent && (sellFills.length > 0 || settlementApplied) &&
      realizedMicrosKnown && realizedAccountingConsistent && Number.isSafeInteger(Number(realizedMicros))
      ? Number(realizedMicros)
      : null;
    const realizedPnlCentsValue = microAccountingPresent
      ? realizedPnlMicrosValue === null ? null : microsToCents(realizedMicros)
      : sellFills.length && realizedKnown && realizedAccountingConsistent ? realized : null;

    if (input.limits?.maxContracts !== undefined && contractsBought > input.limits.maxContracts) {
      addPositionAnomaly("contract_limit_exceeded", "Actual bought contracts exceed the supplied limit.");
    }
    if (input.limits?.maxFilledCostCents !== undefined && confirmedFilledCostCents > input.limits.maxFilledCostCents) {
      addPositionAnomaly("filled_cost_limit_exceeded", "Actual filled cost exceeds the supplied limit.");
    }
    positionAnomalies.sort((a, b) =>
      a.code.localeCompare(b.code) ||
      (a.rowId ?? "").localeCompare(b.rowId ?? "") ||
      a.detail.localeCompare(b.detail));
    results.push({
      positionId,
      marketTicker: data.marketTicker,
      side: data.side,
      state,
      contractsBought,
      contractsSold,
      sellableContracts: Math.max(0, sellableContracts),
      outstandingSellContracts,
      confirmedFilledCostCents,
      openCostCents,
      openExposureCents: openCostCents,
      reservedBuyRiskCents,
      realizedPnlCents: realizedPnlCentsValue,
      realizedPnlMicros: realizedPnlMicrosValue,
      unrealizedPnlCents,
      closed,
      anomalies: positionAnomalies,
    });
  }

  results.sort((a, b) => a.positionId.localeCompare(b.positionId));
  const buyFillCostByOrder = new Map<string, number>();
  for (const fill of uniqueFills.values()) {
    if (fill.action === "buy") {
      buyFillCostByOrder.set(fill.orderId,
        (buyFillCostByOrder.get(fill.orderId) ?? 0) + fill.costCents);
    }
  }
  let outstandingBuyReservationCents = 0;
  for (const order of input.orders) {
    if (order.action !== "buy" || !ACTIVE.has(order.status) ||
        (input.positionId && orderPosition.get(order.id) !== input.positionId)) continue;
    const confirmedFillCost = buyFillCostByOrder.get(order.id) ?? 0;
    const unfilledReservation = order.reservedRiskCents - confirmedFillCost;
    const expectedUnfilledReservation = reservedCents(order.remainingContracts, order.requestedLimitPrice);
    if (!validCents(order.reservedRiskCents) || !validCents(confirmedFillCost) ||
        !validCents(unfilledReservation)) {
      addAnomaly("negative_or_invalid_unfilled_buy_reservation",
        "Active buy reservation is below its confirmed fill cost or is not valid non-negative cents.", order.id);
      continue;
    }
    if (unfilledReservation !== expectedUnfilledReservation) {
      addAnomaly("inconsistent_unfilled_buy_reservation",
        "Active buy reservation does not equal confirmed fill cost plus remaining contracts at the order limit.", order.id);
      continue;
    }
    outstandingBuyReservationCents += unfilledReservation;
  }
  const included = results;
  const pnlMicrosKnown = included.every((position) =>
    position.realizedPnlMicros !== null ||
    (position.contractsSold === 0 && position.state !== "settled"));
  const totalRealizedMicros = included.reduce((sum, position) =>
    sum + BigInt(position.realizedPnlMicros ?? 0), 0n);
  const totalRealizedMicrosNumber = Number(totalRealizedMicros);
  const resultRealizedPnlMicros = pnlMicrosKnown && Number.isSafeInteger(totalRealizedMicrosNumber)
    ? totalRealizedMicrosNumber
    : null;
  const pnlKnown = included.every((position) =>
    position.realizedPnlCents !== null ||
    (position.contractsSold === 0 && position.state !== "settled"));
  const openCostCents = included.reduce((sum, position) => sum + position.openCostCents, 0);
  const effectiveCommittedRiskCents = openCostCents + outstandingBuyReservationCents;
  if (!validCents(openCostCents) || !validCents(effectiveCommittedRiskCents)) {
    addAnomaly("invalid_effective_committed_risk",
      "Effective committed risk must be a non-negative safe integer number of cents.");
  }
  if (input.limits?.maxReservedRiskCents !== undefined &&
      effectiveCommittedRiskCents > input.limits.maxReservedRiskCents) {
    addAnomaly("reserved_risk_limit_exceeded", "Effective committed risk exceeds the supplied limit.");
  }
  anomalies.sort((a, b) =>
    a.code.localeCompare(b.code) ||
    (a.rowId ?? "").localeCompare(b.rowId ?? "") ||
    a.detail.localeCompare(b.detail));
  const result: MicroLivePositionResult = {
    positions: results,
    anomalies,
    reservedBuyRiskCents: included.reduce((sum, position) => sum + position.reservedBuyRiskCents, 0),
    effectiveCommittedRiskCents,
    confirmedFilledCostCents: included.reduce((sum, position) => sum + position.confirmedFilledCostCents, 0),
    openCostCents,
    openExposureCents: included.reduce((sum, position) => sum + position.openExposureCents, 0),
    realizedPnlCents: resultRealizedPnlMicros !== null
      ? microsToCents(totalRealizedMicros)
      : pnlKnown
        ? included.reduce((sum, position) => sum + (position.realizedPnlCents ?? 0), 0)
        : null,
    realizedPnlMicros: resultRealizedPnlMicros,
    unrealizedPnlCents: input.sellSideMark?.reliable && included.every((position) =>
      position.closed || position.contractsBought === 0 || position.unrealizedPnlCents !== null)
      ? included.reduce((sum, position) => sum + (position.unrealizedPnlCents ?? 0), 0)
      : null,
  };
  return result;
}