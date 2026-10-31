import {reportOwnedHistoryCapacity} from "./ownedHistoryCapacityDiagnostics";
import {ENTRY_CASH_RISK_VERSION,cashRiskModelFingerprint,cashRiskFeeFingerprint} from "../v13EntryCashRisk";
import {requestQuantityHundredths} from "../v13-production/requestQuantity";
import { getScopedKalshiJson, KalshiApiError } from "../kalshiAccountClient";
import { verifyOwnedFeeMetadata } from "./ownedMarketFeeMetadata";
import { maximumEntryFeePerContractMicros, maximumExitFeePerContractMicros, maximumEntryCashDebitPerContractMicros } from "../microLiveEntryFees";
import { planV13IocEntry } from "../v13ExecutionPlanner";
import { canonical, digest, requireProof, type Identity, type MarketEvidence, type Request, type Snapshot } from "../v13-production/types";
import { marketEvidenceFromBook, parseKalshiOrderBook, readSubaccountSpendableCash } from "./personalMarketAdapter";

export const PERSONAL_KALSHI_HOST = "https://external-api.kalshi.com";
export const PERSONAL_MARKET_METADATA_HOST = "https://external-api.kalshi.com/trade-api/v2";

const BALANCE_PATH = "/trade-api/v2/portfolio/balance";
const ORDER_PATH = "/trade-api/v2/portfolio/orders";
const FILL_PATH = "/trade-api/v2/portfolio/fills";
const POSITION_PATH = "/trade-api/v2/portfolio/positions";
const SETTLEMENT_PATH = "/trade-api/v2/portfolio/settlements";
const HISTORICAL_ORDER_PATH = "/trade-api/v2/historical/orders";
const HISTORICAL_FILL_PATH = "/trade-api/v2/historical/fills";
const PAIR_QUERY = "limit=200&subaccount=1&exchange_index=2";
const PAGE_CAP = 20;

/** Read unsettled and settled (non-archived) market inventory. Kalshi's
 * default positions read is unsettled-only; a fully reduced IOC can disappear
 * from that default view while order/fill history remains. Keep the
 * exchange's nonzero-position OR traded-count filter, and require complete
 * cursor pagination; a missing ticker STILL cannot be imputed as zero.
 */
export function ownedPositionHistoryQuery(cursor: string | null = null): string {
 return `?${PAIR_QUERY}&settlement_status=all&count_filter=position%2Ctotal_traded${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`;
}

/** No response body or secret is surfaced in release diagnostics. Every
 * category still blocks the signed account read; a 429 is not a reason to
 * resubmit another request inside this qualification attempt.
 */
export function classifyOwnedKalshiReadFailure(error:unknown):string{
 if(!(error instanceof KalshiApiError))return "kalshi_read_failed";
 if(error.type==="NOT_CONFIGURED")return "kalshi_read_signer_not_configured";
 if(error.type==="INVALID_CREDENTIALS")return "kalshi_read_signer_invalid";
 if(error.type==="NETWORK_ERROR")return "kalshi_read_network_unavailable";
 if(error.type==="HTTP_ERROR"){
  if(error.status===429)return "kalshi_read_rate_limited";
  if(error.status===401)return "kalshi_read_authentication_rejected";
  if(error.status===403)return "kalshi_read_permission_denied";
  if(typeof error.status==="number"&&error.status>=500&&error.status<=599)
    return "kalshi_read_provider_unavailable";
 }
 return "kalshi_read_failed";
}

export interface OwnedKalshiRead {
  /** Explicit archival coverage; absent is UNKNOWN for administrative recovery. */
  historicalCoverageComplete?: boolean;
  ok: true;
  observedAtMs: number;
  cashMicros: string;
  orders: unknown[];
  fills: unknown[];
  positions: unknown[];
  settlements: unknown[];
}

/** Authenticated Exchange Index 2 reads. A truncated page is a blocker, not an empty account. */
export async function readOwnedKalshiFeeds(
  creds: { keyId: string; privateKey: string },
  nowMs: number,
  get: typeof getScopedKalshiJson = getScopedKalshiJson,
): Promise<OwnedKalshiRead | { ok: false; reason: string }> {
  let balance: unknown;
  try {
    balance = await get(creds, BALANCE_PATH, "?subaccount=1&exchange_index=2");
  } catch(error) {
    return { ok: false, reason: classifyOwnedKalshiReadFailure(error) };
  }
  if (!scopeEcho(balance)) return { ok: false, reason: "account_target_pair_mismatch" };
  const cash = readSubaccountSpendableCash({
    subaccount: 1,
    exchangeIndex: 2,
    observedAtMs: nowMs,
    nowMs,
    maxAgeMs: 15_000,
    subaccountBalance: balance,
    primaryBalance: {},
  });
  if (!cash.ok) return cash;
  // Failure must stop the entire signed scan before any additional Kalshi
  // GET is sent. In particular, a provider 429 must not fan out into five
  // unnecessary signed history requests.
  const orders = await pages(get, creds, ORDER_PATH, ["orders"]);
  if ("failed" in orders) return {ok:false,reason:orders.failed};
  const archivedOrders = await pages(get, creds, HISTORICAL_ORDER_PATH, ["orders"]);
  if ("failed" in archivedOrders) return {ok:false,reason:archivedOrders.failed};
  const fills = await pages(get, creds, FILL_PATH, ["fills"]);
  if ("failed" in fills) return {ok:false,reason:fills.failed};
  const archivedFills = await pages(get, creds, HISTORICAL_FILL_PATH, ["fills"]);
  if ("failed" in archivedFills) return {ok:false,reason:archivedFills.failed};
  const positions = await pages(get, creds, POSITION_PATH, ["market_positions", "positions"]);
  if ("failed" in positions) return {ok:false,reason:positions.failed};
  const settlements = await pages(get, creds, SETTLEMENT_PATH, ["settlements"]);
  if ("failed" in settlements) return {ok:false,reason:settlements.failed};
  const currentEmpty = orders.rows.length === 0 && fills.rows.length === 0 &&
    settlements.rows.length === 0 && !openPositions(positions.rows);
  if ((archivedOrders.unavailable || archivedFills.unavailable) && !currentEmpty) {
    return { ok: false, reason: "personal_exchange_history_unreconciled" };
  }
  const mergedOrders = mergeRows(orders.rows, archivedOrders.unavailable ? [] : archivedOrders.rows, ["order_id"]);
  const mergedFills = mergeRows(fills.rows, archivedFills.unavailable ? [] : archivedFills.rows, ["trade_id", "fill_id"]);
  if (!mergedOrders || !mergedFills) return { ok: false, reason: "personal_exchange_history_unreconciled" };
  if (!scopedRows(mergedOrders) || !scopedRows(mergedFills) || !scopedRows(positions.rows) || !scopedRows(settlements.rows)) {
    return { ok: false, reason: "account_target_pair_mismatch" };
  }
  return {
    ok: true,
    observedAtMs: nowMs,
    cashMicros: cash.cashMicros,
    historicalCoverageComplete: !archivedOrders.unavailable && !archivedFills.unavailable,
    orders: mergedOrders,
    fills: mergedFills,
    positions: positions.rows,
    settlements: settlements.rows,
  };
}

/**
 * Maps exchange rows onto stored intent requests. Unmatched history returns a
 * reason and no snapshot, so the ledger cannot freeze on a fabricated order.
 */
export function personalAccountSnapshot(
  identity: Identity,
  read: OwnedKalshiRead,
  requests: Request[],
): Snapshot | { ok: false; reason: string } {
  try {
    const orders = new Map<string, Snapshot["orders"][number]>();
    for (const row of read.orders) {
      const record = recordOf(row);
      const request = storedRequest(requests, text(record.client_order_id));
      const status = text(record.status);
      if (!request || !status || !["executed", "canceled", "cancelled", "resting", "pending"].includes(status)) {
        return { ok: false, reason: "personal_exchange_history_unreconciled" };
      }
      if (text(record.ticker) !== request.market || bookSide(request) !== bookSideOf(record) ||
          yesPriceMicros(record) !== yesLimit(request) ||
          countHundredths(record.initial_count_fp ?? record.initial_count) !== requestQuantityHundredths(request) ||
          (request.reduceOnly && record.reduce_only !== undefined &&
            record.reduce_only !== true && record.reduce_only !== "true")) {
        return { ok: false, reason: "personal_exchange_history_unreconciled" };
      }
      const orderId = text(record.order_id);
      const filled = countHundredths(record.fill_count_fp ?? record.fill_count);
      if (!orderId || filled === null) return { ok: false, reason: "personal_exchange_history_unreconciled" };
      const order = {
        orderId,
        request,
        terminal: ["executed", "canceled", "cancelled"].includes(status),
        filledHundredths: String(filled),
      };
      const prior = orders.get(orderId);
      if (prior && canonical(prior) !== canonical(order)) return { ok: false, reason: "personal_exchange_history_unreconciled" };
      orders.set(orderId, order);
    }
    const fills: Snapshot["fills"] = [];
    const seenFills = new Set<string>();
    for (const row of read.fills) {
      const record = recordOf(row);
      const order = orders.get(text(record.order_id) ?? "");
      const id = text(record.trade_id) ?? text(record.fill_id);
      const qty = countHundredths(record.count_fp ?? record.count);
      const price = rowPriceMicros(record, order?.request.side);
      const fee = feeMicros(record.fee_cost ?? record.fee_cost_dollars);
      const occurredAtMs = Date.parse(text(record.created_time) ?? text(record.ts) ?? "");
      if (!order || !id || seenFills.has(id) || qty === null || qty <= 0n || price === null || fee === null ||
          !Number.isSafeInteger(occurredAtMs)) {
        return { ok: false, reason: "personal_exchange_history_unreconciled" };
      }
      if (text(record.ticker) !== order.request.market) return { ok: false, reason: "personal_exchange_history_unreconciled" };
      const gross = qty * BigInt(price) / 100n;
      if (qty * BigInt(price) % 100n !== 0n) return { ok: false, reason: "personal_exchange_history_unreconciled" };
      seenFills.add(id);
      fills.push({
        id, orderId: order.orderId, clientOrderId: order.request.clientOrderId, market: order.request.market,
        side: order.request.side, action: order.request.action, quantityHundredths: String(qty),
        priceMicros: price, grossMicros: String(gross), feeMicros: fee, occurredAtMs,
      });
    }
    const settlements: Snapshot["settlements"] = [];
    for (const row of read.settlements) {
      const record = recordOf(row);
      const yes = countHundredths(record.yes_count_fp);
      const no = countHundredths(record.no_count_fp);
      const result = text(record.market_result);
      const id = text(record.ticker);
      const occurredAtMs = Date.parse(text(record.settled_time) ?? "");
      if (yes === null || no === null || (yes > 0n) === (no > 0n) || (result !== "yes" && result !== "no") ||
          !id || !Number.isSafeInteger(occurredAtMs)) {
        return { ok: false, reason: "personal_exchange_history_unreconciled" };
      }
      const side = yes > 0n ? "YES" : "NO";
      const payout = payoutMicros(record);
      if (payout === null) return { ok: false, reason: "personal_exchange_history_unreconciled" };
      settlements.push({
        id: `${id}:${text(record.settled_time)}`, market: id, side, result: result === "yes" ? "YES" : "NO",
        quantityHundredths: String(yes || no), payoutMicros: payout, feeMicros: "0", occurredAtMs,
      });
    }
    const positions = read.positions.flatMap((row) => {
      const record = recordOf(row);
      const raw = text(record.position_fp) ?? text(record.position);
      if (!raw || !/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error("personal_exchange_history_unreconciled");
      const qty = countHundredths(raw.replace(/^-/, ""));
      const market = text(record.ticker);
      if (qty === null || !market) throw new Error("personal_exchange_history_unreconciled");
      return qty === 0n ? [] : [{ market, side: raw.startsWith("-") ? "NO" as const : "YES" as const, quantityHundredths: String(qty) }];
    });
    return {
      identity, observedAtMs: read.observedAtMs, complete: true, authenticated: true, historyFromMs: 0,
      cashMicros: read.cashMicros, cashExact: true, orders: [...orders.values()], fills, settlements, positions,
      unexplainedCashActivity: false,
    };
  } catch (error) {
    const reason = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message : "personal_exchange_history_unreconciled";
    return { ok: false, reason };
  }
}

export function emptySnapshot(
  identity: Identity,
  read: OwnedKalshiRead,
  requests: Request[] = [],
): Snapshot | { ok: false; reason: string } {
  return personalAccountSnapshot(identity, read, requests);
}

type Page = { rows: unknown[]; unavailable: boolean };

async function pages(
  get: typeof getScopedKalshiJson,
  creds: { keyId: string; privateKey: string },
  path: string,
  keys: string[],
): Promise<Page | { failed: string }> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const query = path === POSITION_PATH ? ownedPositionHistoryQuery(cursor) : `?${PAIR_QUERY}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let payload: unknown;
    try {
      payload = await get(creds, path, query);
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : NaN;
      if (status === 404 && rows.length === 0 && (path === HISTORICAL_ORDER_PATH || path === HISTORICAL_FILL_PATH)) {
        return { rows: [], unavailable: true };
      }
      return { failed: classifyOwnedKalshiReadFailure(error) };
    }
    const parsed = pageOf(payload, keys);
    if (!parsed || (parsed.cursor && seen.has(parsed.cursor))) {
      return { failed: "personal_exchange_history_unreconciled" };
    }
    rows.push(...parsed.rows);
    reportOwnedHistoryCapacity(creds.keyId,path.includes("/historical/") ? `historical_${keys[0]}` : path.split("/").at(-1)!,page+1,rows.length,Boolean(parsed.cursor));
    if (!parsed.cursor) return { rows, unavailable: false };
    seen.add(parsed.cursor);
    cursor = parsed.cursor;
  }
  return { failed: "personal_exchange_history_unreconciled" };
}

function pageOf(payload: unknown, keys: string[]): { rows: unknown[]; cursor: string | null } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const cursor = typeof body.cursor === "string" && body.cursor.trim() ? body.cursor : null;
  for (const key of keys) {
    if (Array.isArray(body[key])) return { rows: body[key] as unknown[], cursor };
  }
  return null;
}

function mergeRows(current: unknown[], archived: unknown[], idKeys: string[]): unknown[] | null {
  const merged = new Map<string, unknown>();
  for (const row of [...current, ...archived]) {
    const record = recordOf(row);
    const id = idKeys.map((key) => text(record[key])).find((value) => value) ?? "";
    if (!id) return null;
    const prior = merged.get(id);
    if (prior && canonical(prior) !== canonical(row)) return null;
    merged.set(id, row);
  }
  return [...merged.values()];
}

export function scopeEcho(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const body = payload as Record<string, unknown>;
  const subaccount = body.subaccount ?? body.subaccount_number;
  const exchange = body.exchange_index;
  if (subaccount !== undefined && Number(subaccount) !== 1) return false;
  if (exchange !== undefined && Number(exchange) !== 2) return false;
  return true;
}

function scopedRows(rows: unknown[]): boolean {
  return rows.every((row) => scopeEcho(row));
}

/** Binds the verified fee artifact to the live book. A failed metadata read is a blocker. */
export function ownedMarketEvidence(input: {
  market: string;
  side: "YES" | "NO";
  bookPayload: unknown;
  seriesPayload: unknown;
  marketPayload: unknown;
  eventPayload: unknown;
  seriesChangesPayload: unknown;
  eventChangesPayload: unknown;
  observedAtMs: number;
  nowMs: number;
  configuredStakeCents: number;
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
  artifactDigest: string;
  policyHash: string;
  verifiedAtMs: number;
}): MarketEvidence {
  // All fee metadata is bound to the SAME market used for the book and the
  // final POST re-read. Never rely on series multiplier alone.
  const feeProof = verifyOwnedFeeMetadata({
    marketTicker: input.market, seriesPayload: input.seriesPayload,
    marketPayload: input.marketPayload, eventPayload: input.eventPayload,
    seriesChangesPayload: input.seriesChangesPayload,
    eventChangesPayload: input.eventChangesPayload,
    observedAtMs: input.observedAtMs, nowMs: input.nowMs,
  });
  if (!feeProof.ok) throw new Error(feeProof.reason);
  const seriesBody = object(input.seriesPayload);
  const marketBody = object(input.marketPayload);
  const series = object(seriesBody.series);
  const metadata = object(marketBody.market);
  const structure = metadata.price_level_structure;
  requireProof(series.ticker === "KXBTC15M" && series.fee_type === "quadratic" &&
    String(series.fee_multiplier) === "1" && metadata.ticker === input.market &&
    metadata.exchange_index === 2 && metadata.status === "active" &&
    (structure === "deci_cent" || structure === "tapered_deci_cent"), "production_fee_or_market_grid_unproven");
  const ticks = structure === "deci_cent" && metadata.price_ranges === undefined
    ? undefined
    : ticksFromRanges(metadata.price_ranges);
  requireProof(ticks === undefined || (ticks !== null && ticks.length > 0), "production_fee_or_market_grid_unproven");
  const book = parseKalshiOrderBook(input.bookPayload);
  const asks = asksFor(input.side, book);
  const bestAsk = asks[0]?.priceDollars ?? null;
  const plan = planV13IocEntry({
    signal: Number(bestAsk) <= 0.52 ? "SCOUT" : "CONFIRM",
    direction: input.side === "YES" ? "UP" : "DOWN",
    referenceOffer: Number(bestAsk),
    maxStakeCents: input.configuredStakeCents,
    bestAskDollars: bestAsk,
    askLevels: asks,
  });
  const count = plan.ok ? plan.plan.contracts : 1;
  const limit = plan.ok ? plan.plan.limitPrice : Number(bestAsk);
  const side = input.side.toLowerCase() as "yes" | "no";
  const entry = maximumEntryFeePerContractMicros(1, limit.toFixed(4), ticks ?? undefined, side);
  const exit = maximumExitFeePerContractMicros(1, ticks ?? undefined, side);
  requireProof(entry !== null && exit !== null && Number.isSafeInteger(input.verifiedAtMs), "fee_evidence_missing");
  const ranges=metadata.price_ranges??[{start:"0.0000",end:"1.0000",step:"0.0001"}];
  const cash=maximumEntryCashDebitPerContractMicros(1,limit.toFixed(4),ranges,side);
  requireProof(cash!==null,"fee_cash_bound_unproven");
  const identity={version:ENTRY_CASH_RISK_VERSION,marketTicker:input.market,side:input.side,
    policyHash:input.policyHash,artifactDigest:input.artifactDigest,feeMetadataDigest:feeProof.fingerprint,
    seriesDigest:digest(series),gridDigest:digest({structure,ranges})};
  const cashRisk={...identity,modelFingerprint:cashRiskModelFingerprint(identity),
    entryCashDebitPerContractMicros:cash,entryTradeFeePerContractMicros:entry,exitLossPerContractMicros:exit};
  const fingerprint=cashRiskFeeFingerprint({contracts:count,limitPrice:limit,cashRisk});
  return marketEvidenceFromBook({
    market: input.market,
    side: input.side,
    book,
    observedAtMs: input.observedAtMs,
    nowMs: input.nowMs,
    maxAgeMs: 15_000,
    fee: {
      policyVersion: input.policyVersion,
      sourceUrl: input.sourceUrl,
      formulaVersion: input.formulaVersion,
      fingerprint, cashRisk,
      verifiedAtMs: input.verifiedAtMs,
      contracts: count,
      limitPrice: limit,
      reservedEntryFeeCents: Math.ceil(entry * count / 10_000),
      reservedExitFeeCents: Math.ceil(exit * count / 10_000),
    },
  });
}

function ticksFromRanges(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const ticks = new Set<number>();
  let previousEnd = -1;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const band = item as Record<string, unknown>;
    const start = fourDecimalTick(band.start);
    const end = fourDecimalTick(band.end);
    const step = fourDecimalTick(band.step);
    if (start === null || end === null || step === null || step === 0 ||
        start > end || start < previousEnd || (end - start) % step !== 0) return null;
    for (let tick = start; tick <= end; tick += step) ticks.add(tick);
    previousEnd = end;
  }
  const orderable = [...ticks].filter((tick) => tick > 0 && tick < 10_000).sort((a, b) => a - b);
  return orderable.length > 0 ? orderable : null;
}

function fourDecimalTick(value: unknown): number | null {
  if (typeof value !== "string" || !/^(\d)\.(\d{4})$/.test(value)) return null;
  const tick = Number(value[0]) * 10_000 + Number(value.slice(2));
  return Number.isSafeInteger(tick) && tick >= 0 && tick <= 10_000 ? tick : null;
}

function asksFor(side: "YES" | "NO", book: ReturnType<typeof parseKalshiOrderBook>) {
  const opposite = side === "YES" ? book.noBids : book.yesBids;
  return opposite.map((level) => {
    const complementary = (10_000 - Math.round(Number(level.priceDollars) * 10_000)) / 10_000;
    return { priceDollars: complementary.toFixed(4), availableContracts: level.availableContracts };
  }).sort((a, b) => Number(a.priceDollars) - Number(b.priceDollars));
}

function object(value: unknown): Record<string, unknown> {
  requireProof(value && typeof value === "object" && !Array.isArray(value), "production_market_metadata_invalid");
  return value as Record<string, unknown>;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("personal_exchange_history_unreconciled");
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : null;
}

function storedRequest(requests: Request[], clientOrderId: string | null): Request | null {
  if (!clientOrderId) return null;
  const found = requests.filter((request) => request.clientOrderId === clientOrderId);
  return found.length === 1 ? found[0]! : null;
}

function bookSide(request: Request): "bid" | "ask" {
  return (request.action === "BUY") === (request.side === "YES") ? "bid" : "ask";
}

function bookSideOf(record: Record<string, unknown>): string | null {
  const side = text(record.book_side) ?? text(record.side);
  return side === "bid" || side === "ask" ? side : null;
}

function yesLimit(request: Request): number {
  return request.side === "YES" ? request.limitMicros : 1_000_000 - request.limitMicros;
}

function dollarMicros(value: unknown): number | null {
  const raw = typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : value;
  if (typeof raw !== "string" || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > 6 || !whole) return null;
  const micros = Number(BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")));
  return Number.isSafeInteger(micros) ? micros : null;
}

function yesPriceMicros(record: Record<string, unknown>): number | null {
  return dollarMicros(record.yes_price_dollars ?? record.price_dollars ?? record.price);
}

function rowPriceMicros(record: Record<string, unknown>, side: "YES" | "NO" | undefined): number | null {
  if (!side) return null;
  const named = dollarMicros(side === "YES" ? record.yes_price_dollars : record.no_price_dollars);
  if (named !== null) return named;
  const yes = dollarMicros(record.price_dollars ?? record.price);
  if (yes === null) return null;
  return side === "YES" ? yes : 1_000_000 - yes;
}

function countHundredths(value: unknown): bigint | null {
  const raw = text(value);
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > 2 || !whole) return null;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function feeMicros(value: unknown): string | null {
  const micros = dollarMicros(value);
  return micros === null ? null : String(micros);
}

function payoutMicros(record: Record<string, unknown>): string | null {
  if (typeof record.revenue === "number" && Number.isSafeInteger(record.revenue) && record.revenue >= 0) {
    return String(BigInt(record.revenue) * 10_000n);
  }
  const dollars = dollarMicros(record.revenue_dollars);
  return dollars === null ? null : String(dollars);
}

function openPositions(rows: unknown[]): boolean {
  return rows.some((row) => {
    if (!row || typeof row !== "object") return true;
    const position = (row as Record<string, unknown>).position_fp ?? (row as Record<string, unknown>).position;
    return position !== undefined && position !== 0 && position !== "0" && position !== "0.00";
  });
}
