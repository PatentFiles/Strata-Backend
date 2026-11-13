import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  microLiveConfigTable,
  microLiveDecisionTable,
  microLiveFillTable,
  microLiveOrderTable,
  microLiveSettlementTable,
} from "@workspace/db";
import {
  readKalshiAccount,
  readKalshiAccountActivity,
  readKalshiDedicatedPairEvidence,
  readKalshiSubmissionEvidence,
  readKalshiSettlements,
  type KalshiAccountActivity,
  type KalshiAccountSnapshot,
  type KalshiDedicatedPairEvidence,
  type KalshiSubmissionEvidence,
  type KalshiSettlementsSnapshot,
} from "./kalshiAccountClient";
import { dollarsToMicros, fillTradeMicros } from "./microLiveMoney";
import { invalidateMicroLiveReadiness } from "./microLive";
import { reconstructMicroLivePositions } from "./microLivePosition";
import { proveSettlementMarketOwnership } from "./microLiveSettlementOwnership";
import {
  compatibleOptionalDirection, compatibleOptionalPrice, microLiveOrderLegFillPrice,
} from "./microLiveFillNormalization";

export type MicroLiveSettlementDependencies = {
  readSettlements?: () => Promise<SettlementEvidenceSnapshot>;
  readAccount?: () => Promise<KalshiAccountSnapshot>;
  readAccountActivity?: () => Promise<KalshiAccountActivity>;
  readMarketEvidence?: (ticker: string) => Promise<KalshiSubmissionEvidence>;
  readDedicatedPairEvidence?: (
    subaccountNumber: number,
    ticker: string,
  ) => Promise<KalshiDedicatedPairEvidence>;
  afterEvidenceRead?: () => Promise<void>;
};

type SettlementEvidenceSnapshot = Omit<KalshiSettlementsSnapshot, "settlements"> & {
  settlements: Array<Omit<KalshiSettlementsSnapshot["settlements"][number], "feeCostDollars"> & {
    feeCostDollars: string | null;
  }>;
};

export type MicroLiveSettlementResult = {
  status: "blocked" | "recorded" | "already_recorded";
  reason: string;
  positionId: string;
};

function sameSettlementFill(
  left: KalshiSubmissionEvidence["fills"][number],
  right: KalshiAccountActivity["fills"][number],
): boolean {
  return left.id === right.id && left.orderId === right.orderId &&
    left.ticker === right.ticker && left.side === right.side &&
    left.action === right.action && parseWholeDecimal(left.countFp) !== null &&
    parseWholeDecimal(left.countFp) === parseWholeDecimal(right.countFp) &&
    dollarsToMicros(left.priceDollars ?? "") !== null &&
    dollarsToMicros(left.priceDollars ?? "") ===
      dollarsToMicros(right.priceDollars ?? "") &&
    (left.createdAt ?? null) === (right.createdAt ?? null) &&
    compatibleOptionalDirection(left, right) &&
    compatibleOptionalPrice(left.yesPriceDollars, right.yesPriceDollars) &&
    compatibleOptionalPrice(left.noPriceDollars, right.noPriceDollars) &&
    (left.feeCostDollars == null || right.feeCostDollars == null ||
      dollarsToMicros(left.feeCostDollars) === dollarsToMicros(right.feeCostDollars));
}

const environmentGatesOff = () =>
  process.env.MICRO_LIVE_PRODUCTION_ENABLED !== "true" &&
  process.env.LIVE_EXECUTION_ENABLED !== "true";

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function ledgerFingerprint(
  orders: Array<typeof microLiveOrderTable.$inferSelect>,
  fills: Array<typeof microLiveFillTable.$inferSelect>,
): string {
  return sha256({
    orders: [...orders].sort((left, right) => left.id.localeCompare(right.id)),
    fills: [...fills].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function parseWholeDecimal(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (/[1-9]/.test(fraction)) return null;
  const parsed = BigInt(whole!);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

function validDate(value: string): Date | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function fillMatchesExchange(
  local: typeof microLiveFillTable.$inferSelect,
  order: typeof microLiveOrderTable.$inferSelect,
  exchange: KalshiAccountSnapshot["fills"][number],
  marketOrder: KalshiSubmissionEvidence["orders"][number] | undefined,
): boolean {
  const count = parseWholeDecimal(exchange.countFp);
  const legPrice = marketOrder ? microLiveOrderLegFillPrice(exchange, marketOrder) : null;
  const price = legPrice === null ? NaN : Number(legPrice);
  const tradeMicros = count === null ? null : fillTradeMicros(count, legPrice);
  return exchange.id === local.exchangeFillId &&
    exchange.orderId === order.exchangeOrderId &&
    exchange.ticker === order.marketTicker &&
    exchange.action === order.action &&
    marketOrder?.side === (order.side === "UP" ? "yes" : "no") &&
    legPrice !== null &&
    count === local.contracts &&
    tradeMicros !== null && local.tradeMicros === tradeMicros &&
    Number.isFinite(price) && price > 0 && price <= 1 &&
    Math.abs(price - local.fillPrice) < 0.0001 &&
    (local.feeMicros === null || dollarsToMicros(exchange.feeCostDollars) === local.feeMicros) &&
    Boolean(exchange.createdAt) &&
    validDate(exchange.createdAt!)?.getTime() === local.filledAt.getTime();
}

function exactExistingRow(
  current: typeof microLiveSettlementTable.$inferSelect,
  candidate: typeof microLiveSettlementTable.$inferInsert,
): boolean {
  return current.positionId === candidate.positionId &&
    current.marketTicker === candidate.marketTicker &&
    current.side === candidate.side &&
    current.marketResult === candidate.marketResult &&
    current.contracts === candidate.contracts &&
    current.payoutMicros === candidate.payoutMicros &&
    current.feeMicros === candidate.feeMicros &&
    current.settledAt.getTime() === candidate.settledAt.getTime() &&
    current.evidenceDigest === candidate.evidenceDigest;
}

function isOpenPosition(position: ReturnType<typeof reconstructMicroLivePositions>["positions"][number]) {
  return !position.closed && (position.contractsBought > position.contractsSold ||
    position.reservedBuyRiskCents > 0 || position.outstandingSellContracts > 0);
}

function environmentFlags(): { microLiveProductionEnabled: boolean; liveExecutionEnabled: boolean } {
  return {
    microLiveProductionEnabled: process.env.MICRO_LIVE_PRODUCTION_ENABLED === "true",
    liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED === "true",
  };
}

export function verifyPrimarySettlementMarketActivity(
  activity: KalshiAccountActivity,
  history: KalshiSubmissionEvidence,
  ticker: string,
): string | null {
  if (!activity.available || activity.truncated || activity.selectedSubaccount !== 0) {
    return "micro_live_primary_nonexclusive_accounting_unresolved:account_history_incomplete_or_wrong_subaccount";
  }
  if (history.truncated || history.historicalFillsAvailable !== true ||
      !Array.isArray(history.historicalFills)) {
    return "micro_live_primary_nonexclusive_accounting_unresolved:market_history_incomplete";
  }
  const startedAt = activity.scanStartedAt ? Date.parse(activity.scanStartedAt) : NaN;
  const finishedAt = activity.scanFinishedAt ? Date.parse(activity.scanFinishedAt) : NaN;
  const now = Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) ||
      startedAt > finishedAt || finishedAt > now || now - startedAt > 5_000 ||
      finishedAt - startedAt > 15_000) {
    return "micro_live_primary_nonexclusive_accounting_unresolved:account_history_scan_stale_or_incomplete";
  }

  const marketOrders = history.orders.filter((order) => order.ticker === ticker);
  const activityOrders = activity.orders.filter((order) => order.ticker === ticker);
  const sameOrder = (left: typeof marketOrders[number], right: typeof activityOrders[number]) =>
    left.id === right.id && left.clientOrderId === right.clientOrderId &&
    left.ticker === right.ticker && left.side === right.side &&
    left.action === right.action && left.type === right.type &&
    left.status === right.status &&
    (left.priceDollars === null || right.priceDollars === null
      ? left.priceDollars === right.priceDollars
      : dollarsToMicros(left.priceDollars) === dollarsToMicros(right.priceDollars)) &&
    left.initialCount === right.initialCount && left.filledCount === right.filledCount &&
    left.remainingCount === right.remainingCount;
  if (marketOrders.length !== activityOrders.length ||
      marketOrders.some((order) =>
        !activityOrders.some((activityOrder) => sameOrder(order, activityOrder)))) {
    return "micro_live_primary_nonexclusive_accounting_unresolved:account_market_order_history_conflict";
  }

  const historyFills = new Map<string, KalshiSubmissionEvidence["fills"][number]>();
  for (const fill of [...history.fills, ...(history.historicalFills ?? [])]) {
    if (fill.ticker !== ticker) continue;
    const previous = historyFills.get(fill.id);
    if (previous && !sameSettlementFill(previous, fill)) {
      return "micro_live_primary_nonexclusive_accounting_unresolved:account_market_fill_history_conflict";
    }
    historyFills.set(fill.id, previous ?? fill);
  }
  const activityFills = activity.fills.filter((fill) => fill.ticker === ticker);
  if (historyFills.size !== activityFills.length ||
      activityFills.some((fill) => {
        const historical = historyFills.get(fill.id);
        return !historical ||
          !sameSettlementFill(historical, fill);
      })) {
    return "micro_live_primary_nonexclusive_accounting_unresolved:account_market_fill_history_conflict";
  }
  return null;
}

function exchangeIndexOf(record: unknown): number | null {
  if (!record || typeof record !== "object") return null;
  const value = record as Record<string, unknown>;
  const index = value.exchangeIndex ?? value.exchange_index;
  return typeof index === "number" && Number.isSafeInteger(index) ? index : null;
}

function pairRowsHaveExplicitShard(
  rows: readonly unknown[],
  ticker: string,
): boolean {
  return rows.every((row) => {
    if (!row || typeof row !== "object" ||
        (row as Record<string, unknown>).ticker !== ticker) return true;
    return exchangeIndexOf(row) === 2;
  });
}

/**
 * A dedicated settlement is accepted only with complete pair identity and
 * explicit shard evidence on every relevant normalized record. The raw
 * read-only pair scan independently validates exchange_index on all account
 * inventory rows because the ordinary account DTOs intentionally omit it.
 */
export function verifyDedicatedSettlementPairActivity(input: {
  config: typeof microLiveConfigTable.$inferSelect;
  pairEvidence: KalshiDedicatedPairEvidence;
  account: KalshiAccountSnapshot;
  activity: KalshiAccountActivity;
  history: KalshiSubmissionEvidence;
  settlements: SettlementEvidenceSnapshot["settlements"];
  ticker: string;
  nowMs?: number;
}): string | null {
  const { config, pairEvidence, account, activity, history, settlements, ticker } = input;
  const subaccountNumber = config.microLiveSelectedSubaccount;
  const nowMs = input.nowMs ?? Date.now();
  const pairIsValid = Number.isSafeInteger(subaccountNumber) &&
    subaccountNumber !== null && subaccountNumber >= 1 && subaccountNumber <= 63 &&
    config.microLiveAccountMode === "exclusive" &&
    config.microLiveSelectedExchangeIndex === 2 &&
    config.microLiveRestrictedApiKeyId !== null &&
    config.microLiveRestrictedApiKeyId.trim() !== "" &&
    config.microLiveRestrictedKeyFingerprint !== null &&
    /^[0-9a-f]{64}$/.test(config.microLiveRestrictedKeyFingerprint) &&
    config.microLiveFundingAnchorSubaccount === subaccountNumber &&
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
    config.microLiveAccountActivityCheckpointSubaccount === subaccountNumber &&
    config.microLiveAccountActivityCheckpointExchangeIndex === 2;
  if (!pairIsValid || subaccountNumber === null) {
    return "micro_live_dedicated_pair_identity_missing_or_invalid";
  }
  if (pairEvidence.pair.subaccountNumber !== subaccountNumber ||
      pairEvidence.pair.exchangeIndex !== 2 ||
      pairEvidence.marketExchangeIndex !== 2 ||
      !pairEvidence.keyRestrictionVerified || !pairEvidence.tradePermissionVerified ||
      pairEvidence.balance.subaccountNumber !== subaccountNumber ||
      pairEvidence.balance.exchangeIndex !== 2) {
    return "micro_live_dedicated_pair_exchange_evidence_mismatch";
  }
  const scanStartedAt = Date.parse(pairEvidence.scanStartedAt);
  const scanFinishedAt = Date.parse(pairEvidence.scanFinishedAt);
  if (!Number.isFinite(scanStartedAt) || !Number.isFinite(scanFinishedAt) ||
      scanStartedAt > scanFinishedAt || scanFinishedAt > nowMs ||
      nowMs - scanFinishedAt > 5_000 ||
      !Object.values(pairEvidence.recordCounts).every((count) =>
        Number.isSafeInteger(count) && count >= 0)) {
    return "micro_live_dedicated_pair_evidence_stale_or_incomplete";
  }
  if (!activity.available || activity.truncated ||
      activity.selectedSubaccount !== subaccountNumber ||
      !history || history.truncated || history.historicalFillsAvailable !== true ||
      !Array.isArray(history.historicalFills) ||
      !settlements.some((settlement) => settlement.ticker === ticker)) {
    return "micro_live_dedicated_pair_account_history_unproven";
  }
  const settlementRows = settlements.filter((item) => item.ticker === ticker);
  const accountOrders = account.openOrders.filter((item) => item.ticker === ticker);
  const accountFills = account.fills.filter((item) => item.ticker === ticker);
  const accountPositions = account.positions.filter((item) => item.ticker === ticker);
  const activityOrders = activity.orders.filter((item) => item.ticker === ticker);
  const activityFills = activity.fills.filter((item) => item.ticker === ticker);
  const historyOrders = history.orders.filter((item) => item.ticker === ticker);
  const historyFills = [...history.fills, ...(history.historicalFills ?? [])]
    .filter((item) => item.ticker === ticker);
  if (![settlementRows, accountOrders, accountFills, accountPositions, activityOrders,
    activityFills, historyOrders, historyFills].every((rows) =>
    pairRowsHaveExplicitShard(rows, ticker))) {
    return "micro_live_dedicated_pair_record_exchange_index_unproven";
  }
  return null;
}

export async function reconcileMicroLiveSettlement(
  positionId: string,
  actorId: string,
  deps: MicroLiveSettlementDependencies = {},
): Promise<MicroLiveSettlementResult> {
  const blocked = (reason: string): MicroLiveSettlementResult =>
    ({ status: "blocked", reason, positionId });
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(positionId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(actorId)) {
    return blocked("micro_live_settlement_invalid_request");
  }

  const auditOnly = async (reason: string): Promise<MicroLiveSettlementResult> =>
    db.transaction(async (tx) => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      let responseReason = reason;
      if (config?.microLiveAccountMode === "primary_nonexclusive" ||
          config?.microLiveAccountMode === "exclusive") {
        responseReason = reason.startsWith(
          "micro_live_primary_nonexclusive_accounting_unresolved:",
        ) || reason.startsWith("micro_live_dedicated_pair_accounting_unresolved:")
          ? reason
          : config.microLiveAccountMode === "exclusive"
            ? `micro_live_dedicated_pair_accounting_unresolved:${reason}`
            : `micro_live_primary_nonexclusive_accounting_unresolved:${reason}`;
        await tx.update(microLiveConfigTable).set({
          manualKillSwitch: true,
          microLiveProductionEnabled: false,
          liveExecutionEnabled: false,
          microLiveAccountingUnresolved: true,
          microLiveAccountingUnresolvedReason: responseReason,
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }
      await tx.insert(microLiveDecisionTable).values({
        id: randomUUID(),
        status: "BLOCK",
        reason: `${responseReason};actor=${actorId}`,
        evaluationId: null,
        orderId: null,
      });
      return blocked(responseReason);
    });

  if (!environmentGatesOff()) {
    return auditOnly("micro_live_settlement_requires_environment_gates_off");
  }

  const [initialConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (!initialConfig || !initialConfig.manualKillSwitch ||
      initialConfig.microLiveProductionEnabled || initialConfig.liveExecutionEnabled) {
    return auditOnly("micro_live_settlement_requires_database_gates_off_and_kill_on");
  }

  const [orders, fills] = await Promise.all([
    db.select().from(microLiveOrderTable),
    db.select().from(microLiveFillTable),
  ]);
  const startingFingerprint = ledgerFingerprint(orders, fills);
  let candidate: typeof microLiveSettlementTable.$inferInsert | null = null;
  let evidenceDigest: string | null = null;
  let outcomeReason = "micro_live_settlement_evidence_invalid";
  const primaryNonexclusive = initialConfig.microLiveAccountMode === "primary_nonexclusive";
  const dedicatedPairMode = initialConfig.microLiveAccountMode === "exclusive" &&
    initialConfig.microLiveSelectedExchangeIndex === 2;
  if (primaryNonexclusive && initialConfig.microLiveSelectedSubaccount !== 0) {
    outcomeReason =
      "micro_live_primary_nonexclusive_accounting_unresolved:configured_subaccount_mismatch";
  } else if (primaryNonexclusive && initialConfig.microLiveAccountingUnresolved) {
    const priorReason = initialConfig.microLiveAccountingUnresolvedReason ??
      "prior_unresolved_accounting";
    outcomeReason = priorReason.startsWith(
      "micro_live_primary_nonexclusive_accounting_unresolved:",
    ) ? priorReason : `micro_live_primary_nonexclusive_accounting_unresolved:${priorReason}`;
  } else if (!primaryNonexclusive && !dedicatedPairMode) {
    outcomeReason = "micro_live_dedicated_pair_accounting_unresolved:pair_identity_missing";
  } else if (dedicatedPairMode && initialConfig.microLiveAccountingUnresolved) {
    outcomeReason = initialConfig.microLiveAccountingUnresolvedReason ??
      "micro_live_dedicated_pair_accounting_unresolved:prior_unresolved_accounting";
  }

  try {
    if (primaryNonexclusive &&
        (initialConfig.microLiveSelectedSubaccount !== 0 ||
         initialConfig.microLiveAccountingUnresolved)) {
      throw new Error(outcomeReason);
    }
    if (!primaryNonexclusive && !dedicatedPairMode) {
      throw new Error(outcomeReason);
    }
    if (dedicatedPairMode && initialConfig.microLiveAccountingUnresolved) {
      throw new Error(outcomeReason);
    }
    const [settlements, account, activity] = await Promise.all([
      (deps.readSettlements ?? readKalshiSettlements)(),
      (deps.readAccount ?? readKalshiAccount)(),
      primaryNonexclusive || dedicatedPairMode
        ? (deps.readAccountActivity ?? readKalshiAccountActivity)()
        : Promise.resolve(null),
    ]);
    await deps.afterEvidenceRead?.();

    if (settlements.truncated || Object.values(account.truncated).some(Boolean)) {
      outcomeReason = "micro_live_settlement_snapshot_incomplete";
    } else if (new Set(account.positions.map((position) => position.ticker)).size !==
        account.positions.length) {
      outcomeReason = "micro_live_settlement_duplicate_exchange_positions";
    } else {
      const ledger = reconstructMicroLivePositions({ orders, fills });
      const selected = ledger.positions.filter((position) => position.positionId === positionId);
      const openOnTicker = ledger.positions.filter((position) =>
        isOpenPosition(position) && position.marketTicker === selected[0]?.marketTicker);
      const settlementMatches = settlements.settlements.filter((settlement) =>
        settlement.ticker === selected[0]?.marketTicker);
      const position = selected[0];

      if (ledger.anomalies.length > 0 || !position || selected.length !== 1 || !position.marketTicker ||
          position.side !== "UP" && position.side !== "DOWN" ||
          !isOpenPosition(position) || position.contractsBought <= 0 ||
          position.contractsSold < 0 || position.contractsSold >= position.contractsBought ||
          position.outstandingSellContracts !== 0 || position.reservedBuyRiskCents !== 0 ||
          position.anomalies.length > 0 || openOnTicker.length !== 1) {
        outcomeReason = "micro_live_settlement_local_position_not_uniquely_open";
      } else if (settlementMatches.length !== 1 ||
          settlements.settlements.filter((settlement) =>
            settlement.ticker === position.marketTicker).length !== 1) {
        outcomeReason = "micro_live_settlement_not_unique_for_market";
      } else {
        const settlement = settlementMatches[0]!;
        const marketHistory = await (deps.readMarketEvidence ?? readKalshiSubmissionEvidence)(
          position.marketTicker);
        if (primaryNonexclusive) {
          const accountHistoryFailure = activity
            ? verifyPrimarySettlementMarketActivity(activity, marketHistory, position.marketTicker)
            : "micro_live_primary_nonexclusive_accounting_unresolved:account_history_unavailable";
          if (accountHistoryFailure) {
            outcomeReason = accountHistoryFailure;
            throw new Error(accountHistoryFailure);
          }
        }
        if (dedicatedPairMode) {
          const pairEvidence = await (deps.readDedicatedPairEvidence ??
            readKalshiDedicatedPairEvidence)(
            initialConfig.microLiveSelectedSubaccount!,
            position.marketTicker,
          );
          const pairFailure = activity
            ? verifyDedicatedSettlementPairActivity({
              config: initialConfig,
              pairEvidence,
              account,
              activity,
              history: marketHistory,
              settlements: settlements.settlements,
              ticker: position.marketTicker,
            })
            : "micro_live_dedicated_pair_account_history_unproven";
          if (pairFailure) {
            outcomeReason = `micro_live_dedicated_pair_accounting_unresolved:${pairFailure}`;
            throw new Error(pairFailure);
          }
        }
        const tickerOrders = orders.filter((order) => {
          if (order.marketTicker !== position.marketTicker) return false;
          if (order.action === "sell") return order.exitPositionId === positionId;
          const linkedFill = fills.find((fill) => fill.orderId === order.id && fill.positionId)?.positionId;
          const resolvedPositionId = order.positionId ?? linkedFill ??
            `position:${order.marketTicker}:${order.crossingKey}`;
          return resolvedPositionId === positionId;
        });
        const tickerOrderIds = new Set(tickerOrders.map((order) => order.id));
        const positionFills = fills.filter((fill) => tickerOrderIds.has(fill.orderId));
        const positionBuyFills = positionFills.filter((fill) => fill.action === "buy");
        const positionSellFills = positionFills.filter((fill) => fill.action === "sell");
        const ownership = proveSettlementMarketOwnership({
          ticker: position.marketTicker,
          localMarketOrders: orders.filter((order) =>
            order.marketTicker === position.marketTicker),
          positionOrders: tickerOrders,
          positionFills,
          accountFills: account.fills,
          history: marketHistory,
        });
        const exchangeTickerFills = ownership.verified ? ownership.fills : [];
        const fillIds = new Set<string>();
        const orderById = new Map(tickerOrders.map((order) => [order.id, order]));
        const localFillsValid = positionFills.every((fill) => {
          const order = orderById.get(fill.orderId);
          const exchange = exchangeTickerFills.find((item) => item.id === fill.exchangeFillId);
          if (!order || !order.exchangeOrderId || fillIds.has(fill.exchangeFillId) ||
              fill.action !== order.action ||
              (fill.positionId !== null && fill.positionId !== positionId) ||
               !exchange || !fillMatchesExchange(fill, order, exchange,
                 ownership.verified ? ownership.orders.find((item) =>
                   item.id === order.exchangeOrderId) : undefined)) return false;
          fillIds.add(fill.exchangeFillId);
          return true;
        });
        const relevantExchangeOrderIds = new Set(tickerOrders.flatMap((order) =>
          order.exchangeOrderId ? [order.exchangeOrderId] : []));
        const relevantExchangeFills = exchangeTickerFills.filter((exchangeFill) =>
          exchangeFill.orderId !== null && relevantExchangeOrderIds.has(exchangeFill.orderId));
        const allExchangeFillsAccounted = relevantExchangeFills.every((exchangeFill) =>
          positionFills.some((fill) => fill.exchangeFillId === exchangeFill.id &&
            orderById.get(fill.orderId)?.exchangeOrderId === exchangeFill.orderId));
        // This endpoint reports the account's entire market, not one local
        // strategy. Do not certify a position if other orders traded it.
        const exclusiveMarketFills = exchangeTickerFills.length === positionFills.length &&
          new Set(exchangeTickerFills.map((fill) => fill.id)).size === exchangeTickerFills.length &&
          exchangeTickerFills.every((fill) => fill.orderId !== null &&
            relevantExchangeOrderIds.has(fill.orderId) &&
            positionFills.some((local) => local.exchangeFillId === fill.id));
        const exchangePositionRecords = account.positions.filter((item) =>
          item.ticker === position.marketTicker);
        const exchangePosition = exchangePositionRecords[0];
        const exchangePositionAmount = exchangePosition ? Number(exchangePosition.positionFp) : NaN;
        const noOpenExchangeOrder = !account.openOrders.some((item) =>
          item.ticker === position.marketTicker);
        const activeLocalOrder = tickerOrders.some((order) =>
          ["pending", "unknown", "partial"].includes(order.status) &&
          order.remainingContracts > 0);

        if (!ownership.verified) {
          outcomeReason = primaryNonexclusive
            ? `micro_live_primary_nonexclusive_accounting_unresolved:${ownership.reason}`
            : ownership.reason;
        } else if (!positionBuyFills.length || positionBuyFills.reduce((sum, fill) =>
          sum + fill.contracts, 0) !== position.contractsBought ||
          positionSellFills.reduce((sum, fill) => sum + fill.contracts, 0) !== position.contractsSold ||
           !localFillsValid || !allExchangeFillsAccounted || !exclusiveMarketFills || activeLocalOrder ||
          !noOpenExchangeOrder ||
          (exchangePosition !== undefined && (!Number.isFinite(exchangePositionAmount) ||
            exchangePositionAmount !== 0))) {
          outcomeReason = primaryNonexclusive
            ? "micro_live_primary_nonexclusive_accounting_unresolved:actual_fills_or_zero_position_unproven"
            : "micro_live_settlement_actual_fills_or_zero_position_unproven";
        } else {
          const result = settlement.marketResult;
          const yesCount = parseWholeDecimal(settlement.yesCountFp);
          const noCount = parseWholeDecimal(settlement.noCountFp);
          const revenueCents = /^-?\d+$/.test(settlement.revenueCents)
            ? BigInt(settlement.revenueCents) : null;
          const settledAt = validDate(settlement.settledAt);
          const ownCount = position.side === "UP" ? yesCount : noCount;
          const oppositeCount = position.side === "UP" ? noCount : yesCount;
          const winningCount = result === "yes" ? yesCount : result === "no" ? noCount : null;
          const expectedRevenueCents = winningCount === null
            ? null : BigInt(winningCount) * 100n;
          const contractsRemaining = position.contractsBought - position.contractsSold;
          const feeMicros = settlement.feeCostDollars === null ||
            settlement.feeCostDollars === undefined
            ? null : dollarsToMicros(settlement.feeCostDollars);
          const feeEvidenceValid = settlement.feeCostDollars === null ||
            settlement.feeCostDollars === undefined ||
            (/^\d+(?:\.\d{1,6})?$/.test(settlement.feeCostDollars) && feeMicros !== null);
          const localFeesKnown = positionFills.every((fill) =>
            fill.feeKnown && fill.feeMicros !== null);
          const localFeeTotalMicros = positionFills.reduce((sum, fill) =>
            sum + BigInt(fill.feeMicros ?? 0), 0n);
          const payoutMicros = (position.side === "UP" ? "yes" : "no") === result
            ? BigInt(contractsRemaining) * 1_000_000n : 0n;

          if ((result !== "yes" && result !== "no") ||
              !Number.isSafeInteger(contractsRemaining) || contractsRemaining <= 0 ||
              ownCount !== contractsRemaining || oppositeCount !== 0 ||
              winningCount === null || revenueCents === null ||
              expectedRevenueCents === null || revenueCents !== expectedRevenueCents ||
              !settledAt || payoutMicros > BigInt(Number.MAX_SAFE_INTEGER) ||
              !feeEvidenceValid ||
              feeMicros !== null && (!Number.isSafeInteger(feeMicros) || feeMicros < 0) ||
              !settlement.eventTicker ||
              !/^\d+(?:\.\d{1,6})?$/.test(settlement.yesTotalCostDollars) ||
              !/^\d+(?:\.\d{1,6})?$/.test(settlement.noTotalCostDollars)) {
            outcomeReason = "micro_live_settlement_counts_result_or_revenue_mismatch";
          } else if (feeMicros !== null &&
              (!localFeesKnown || BigInt(feeMicros) !== localFeeTotalMicros)) {
            // Exchange settlement fee_cost covers the account's trading fees
            // on this market; it is not a new settlement debit.
            outcomeReason = "micro_live_settlement_fee_aggregate_mismatch";
          } else {
            const evidence = {
              position: {
                positionId,
                marketTicker: position.marketTicker,
                side: position.side,
                contractsBought: position.contractsBought,
                contractsSold: position.contractsSold,
              },
              localOrders: tickerOrders,
              localFills: positionFills,
              settlement,
              marketOrders: ownership.orders,
              marketFills: ownership.fills,
              accountPosition: exchangePosition ?? null,
              accountOpenOrders: account.openOrders.filter((item) =>
                item.ticker === position.marketTicker),
            };
            evidenceDigest = sha256(evidence);
            candidate = {
              positionId,
              marketTicker: position.marketTicker,
              side: position.side,
              marketResult: result,
              contracts: contractsRemaining,
              payoutMicros: Number(payoutMicros),
              feeMicros,
              settledAt,
              evidenceDigest,
            };
            outcomeReason = "micro_live_settlement_evidence_verified";
          }
        }
      }
    }
  } catch {
    candidate = null;
    if (!outcomeReason.startsWith("micro_live_primary_nonexclusive_accounting_unresolved:") &&
        !outcomeReason.startsWith("micro_live_dedicated_pair_accounting_unresolved:")) {
      outcomeReason = primaryNonexclusive
        ? "micro_live_primary_nonexclusive_accounting_unresolved:exchange_read_failed"
        : "micro_live_settlement_exchange_read_failed";
    }
  }

  const result = await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    const flags = environmentFlags();
    if (!environmentGatesOff() || !config || !config.manualKillSwitch ||
        config.microLiveProductionEnabled || config.liveExecutionEnabled ||
        flags.microLiveProductionEnabled || flags.liveExecutionEnabled) {
      candidate = null;
      outcomeReason = "micro_live_settlement_requires_database_gates_off_and_kill_on";
    }
    if (primaryNonexclusive && config?.microLiveAccountingUnresolved) {
      candidate = null;
      const unresolvedReason = config.microLiveAccountingUnresolvedReason ??
        "prior_unresolved_accounting";
      outcomeReason = unresolvedReason.startsWith(
        "micro_live_primary_nonexclusive_accounting_unresolved:",
      ) ? unresolvedReason :
        `micro_live_primary_nonexclusive_accounting_unresolved:${unresolvedReason}`;
    } else if (primaryNonexclusive &&
        (config?.microLiveAccountMode !== "primary_nonexclusive" ||
         config.microLiveSelectedSubaccount !== 0)) {
      candidate = null;
      outcomeReason =
        "micro_live_primary_nonexclusive_accounting_unresolved:account_mode_changed";
    } else if (dedicatedPairMode && (
      config?.microLiveAccountMode !== "exclusive" ||
      config.microLiveSelectedSubaccount !== initialConfig.microLiveSelectedSubaccount ||
      config.microLiveSelectedExchangeIndex !== 2 ||
      config.microLiveRestrictedApiKeyId !== initialConfig.microLiveRestrictedApiKeyId ||
      config.microLiveRestrictedKeyFingerprint !== initialConfig.microLiveRestrictedKeyFingerprint ||
      config.microLiveFundingAnchorSubaccount !== initialConfig.microLiveFundingAnchorSubaccount ||
      config.microLiveFundingAnchorExchangeIndex !== 2 ||
      config.microLiveFundingAnchorTransferId !== initialConfig.microLiveFundingAnchorTransferId ||
      config.microLiveFundingAnchorTransferAt?.getTime() !==
        initialConfig.microLiveFundingAnchorTransferAt?.getTime() ||
      config.microLiveFundingAnchorAmountCents !== 2500 ||
      config.microLivePairCashBaselineRunId !== initialConfig.microLivePairCashBaselineRunId ||
      config.microLivePairCashBaselineMicros !== initialConfig.microLivePairCashBaselineMicros ||
      config.microLivePairCashBaselineAt?.getTime() !==
        initialConfig.microLivePairCashBaselineAt?.getTime() ||
      config.microLivePairCashBaselineEvidenceDigest !==
        initialConfig.microLivePairCashBaselineEvidenceDigest ||
      config.microLiveAccountActivityCheckpointRunId !==
        initialConfig.microLiveAccountActivityCheckpointRunId ||
      config.microLiveAccountActivityCheckpointCursor !==
        initialConfig.microLiveAccountActivityCheckpointCursor ||
      config.microLiveAccountActivityCheckpointAt?.getTime() !==
        initialConfig.microLiveAccountActivityCheckpointAt?.getTime() ||
      config.microLiveAccountActivityCheckpointEvidenceDigest !==
        initialConfig.microLiveAccountActivityCheckpointEvidenceDigest ||
      config.microLiveAccountActivityCheckpointSubaccount !==
        initialConfig.microLiveAccountActivityCheckpointSubaccount ||
      config.microLiveAccountActivityCheckpointExchangeIndex !== 2 ||
      config.microLiveAccountingUnresolved
    )) {
      candidate = null;
      outcomeReason = "micro_live_dedicated_pair_accounting_unresolved:account_identity_changed";
    }

    // Serialize ledger writers that use the singleton config lock and fence
    // any concurrent direct ledger mutation while the evidence is committed.
    // The evidence GETs intentionally happen before these locks are held.
    await tx.execute(sql`LOCK TABLE ${microLiveOrderTable}, ${microLiveFillTable},
      ${microLiveSettlementTable} IN SHARE ROW EXCLUSIVE MODE`);
    const currentOrders = await tx.select().from(microLiveOrderTable);
    const currentFills = await tx.select().from(microLiveFillTable);
    if (ledgerFingerprint(currentOrders, currentFills) !== startingFingerprint) {
      candidate = null;
      outcomeReason = "micro_live_settlement_ledger_changed_during_evidence_read";
    }

    let status: MicroLiveSettlementResult["status"] = "blocked";
    let reason = outcomeReason;
    if (candidate) {
      const [existing] = await tx.select().from(microLiveSettlementTable)
        .where(and(eq(microLiveSettlementTable.positionId, positionId),
          eq(microLiveSettlementTable.marketTicker, candidate.marketTicker)))
        .limit(1);
      if (existing) {
        if (exactExistingRow(existing, candidate)) {
          status = "already_recorded";
          reason = "micro_live_settlement_already_recorded_exact_match";
        } else {
          reason = "micro_live_settlement_existing_record_mismatch";
        }
      } else {
        await tx.insert(microLiveSettlementTable).values(candidate).onConflictDoNothing();
        const [committed] = await tx.select().from(microLiveSettlementTable)
          .where(eq(microLiveSettlementTable.positionId, positionId)).limit(1);
        if (committed && exactExistingRow(committed, candidate)) {
          status = "recorded";
          reason = "micro_live_settlement_recorded";
        } else {
          reason = "micro_live_settlement_conflicting_record_exists";
        }
      }
    }
    if ((primaryNonexclusive || dedicatedPairMode) && status === "blocked") {
      const reasonPrefix = dedicatedPairMode
        ? "micro_live_dedicated_pair_accounting_unresolved:"
        : "micro_live_primary_nonexclusive_accounting_unresolved:";
      await tx.update(microLiveConfigTable).set({
        manualKillSwitch: true,
        microLiveProductionEnabled: false,
        liveExecutionEnabled: false,
        microLiveAccountingUnresolved: true,
        microLiveAccountingUnresolvedReason: reason.startsWith(
          reasonPrefix,
        ) ? reason : `${reasonPrefix}${reason}`,
      }).where(eq(microLiveConfigTable.id, "singleton"));
      if (!reason.startsWith(reasonPrefix)) {
        reason = `${reasonPrefix}${reason}`;
      }
    }
    await tx.insert(microLiveDecisionTable).values({
      id: randomUUID(),
      status: status === "blocked" ? "BLOCK" : "ALLOW",
      reason: `${reason};actor=${actorId}${evidenceDigest ? `;evidence_sha256=${evidenceDigest}` : ""}`,
      evaluationId: null,
      orderId: null,
    });
    return { status, reason, positionId };
  });
  if (result.status !== "blocked") {
    invalidateMicroLiveReadiness("settlement_requires_manual_reactivation_review");
  }
  return result;
}