import { randomUUID } from "node:crypto";
import {
  getScopedKalshiJson,
  KalshiApiError,
  listOpenKalshiMarkets,
  mutateScopedKalshi,
} from "../kalshiAccountClient";
import { predictionsApiTier } from "../kalshiSubaccountInventory";
import { normalizeKalshiMoney } from "./kalshiUserRead";

export const QUALIFICATION_CONFIRMATION = "QUALIFY_ADVANCED_WITH_ONE_1CENT_API_ORDER";
export const QUALIFICATION_ORDER_PATH = "/trade-api/v2/portfolio/events/orders";
export const QUALIFICATION_UPGRADE_PATH = "/trade-api/v2/account/api_usage_level/upgrade";

const ORDER_FIELDS = {
  side: "bid",
  count: "1.00",
  price: "0.0100",
  time_in_force: "good_till_canceled",
  post_only: true,
  cancel_order_on_pause: true,
  reduce_only: false,
  subaccount: 0,
  self_trade_prevention_type: "taker_at_cross",
} as const;

export type QualificationGuardState =
  | "inflight"
  | "order_uncertain"
  | "unexpected_fill"
  | "cancel_uncertain"
  | "upgrade_uncertain"
  | "upgrade_rejected"
  | "canceled";

export interface QualificationGuardRecord {
  state: QualificationGuardState;
  clientOrderId?: string | null;
  orderId?: string | null;
  ticker?: string | null;
  fillCount?: string | null;
  averageFillPrice?: string | null;
}

export interface QualificationGuard {
  claim(connectionId: string): Promise<"claimed" | "blocked">;
  claimUpgrade(connectionId: string): Promise<"claimed" | "blocked">;
  read(connectionId: string): Promise<QualificationGuardRecord | null>;
  transition(connectionId: string, record: QualificationGuardRecord): Promise<void>;
  clear(connectionId: string): Promise<void>;
}

export interface QualificationExchangeResult {
  status: number;
  body: unknown;
  unreadable: boolean;
}

export interface QualificationTransport {
  get(creds: QualificationCreds, path: string, query?: string): Promise<QualificationExchangeResult | "uncertain">;
  post(creds: QualificationCreds, path: string, body?: unknown): Promise<QualificationExchangeResult | "uncertain">;
  delete(creds: QualificationCreds, path: string, query?: string): Promise<QualificationExchangeResult | "uncertain">;
  listOpenMarkets(): Promise<unknown[] | "uncertain">;
}

export interface QualificationCreds {
  keyId: string;
  privateKey: string;
}

export interface QualificationResult {
  status: string;
  usageTier?: string | null;
  qualificationOrderCreated?: boolean;
  qualificationOrderCanceled?: boolean;
  fillCount?: string;
  orderId?: string;
  ticker?: string;
  averageFillPrice?: string;
  marketsScanned?: number;
  openMarkets?: number;
  validCloseTimes?: number;
  validAskPrices?: number;
  safeAskPrices?: number;
}

const QUALIFICATION_BID_UNITS = 100;

/** Exact non-negative fixed-point dollars, at most 4 decimals and at most 1.0000, in ten-thousandths. */
export function dollarTenThousandths(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) return null;
  const [wholeText, fractionText = ""] = value.split(".");
  const units = BigInt(wholeText) * 10000n + BigInt((fractionText + "0000").slice(0, 4));
  if (units > 10000n) return null;
  return Number(units);
}

export interface QualificationMarketScan {
  ticker: string | null;
  marketsScanned: number;
  openMarkets: number;
  validCloseTimes: number;
  validAskPrices: number;
  safeAskPrices: number;
}

function legacyCentAskUnits(value: unknown): number | null {
  const cents = typeof value === "number" ? value : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : null;
  if (cents === null || !Number.isSafeInteger(cents) || cents < 0 || cents > 100) return null;
  return cents * 100;
}

function qualificationAskUnits(row: Record<string, unknown>): number | null {
  if ("yes_ask_dollars" in row && row.yes_ask_dollars != null) {
    return typeof row.yes_ask_dollars === "string" ? dollarTenThousandths(row.yes_ask_dollars) : null;
  }
  if ("yes_ask" in row && row.yes_ask != null) return legacyCentAskUnits(row.yes_ask);
  return null;
}

export function scanQualificationMarkets(markets: unknown[], now: number): QualificationMarketScan {
  const scan: QualificationMarketScan = {
    ticker: null,
    marketsScanned: 0,
    openMarkets: 0,
    validCloseTimes: 0,
    validAskPrices: 0,
    safeAskPrices: 0,
  };
  let bestUnits = QUALIFICATION_BID_UNITS;
  for (const market of markets) {
    scan.marketsScanned += 1;
    if (!market || typeof market !== "object" || Array.isArray(market)) continue;
    const row = market as Record<string, unknown>;
    const ticker = row.ticker;
    if (typeof ticker !== "string" || !/^[A-Z0-9][A-Z0-9._-]{0,120}$/.test(ticker)) continue;
    // The public status=open feed labels a tradable market "active".
    if (row.status !== "open" && row.status !== "active") continue;
    scan.openMarkets += 1;
    const closeAt = typeof row.close_time === "string" ? Date.parse(row.close_time) : Number.NaN;
    if (!Number.isFinite(closeAt) || closeAt <= now + 60_000) continue;
    scan.validCloseTimes += 1;
    const askUnits = qualificationAskUnits(row);
    if (askUnits === null) continue;
    scan.validAskPrices += 1;
    if (askUnits <= QUALIFICATION_BID_UNITS) continue;
    scan.safeAskPrices += 1;
    if (askUnits > bestUnits) {
      bestUnits = askUnits;
      scan.ticker = ticker;
    }
  }
  return scan;
}

export function qualificationOrderBody(ticker: string, clientOrderId: string): Record<string, unknown> {
  return {
    ticker,
    client_order_id: clientOrderId,
    ...ORDER_FIELDS,
  };
}

export function selectQualificationMarket(markets: unknown[], now: number): { ticker: string } | null {
  const scan = scanQualificationMarkets(markets, now);
  return scan.ticker ? { ticker: scan.ticker } : null;
}

export function createMemoryQualificationGuard(): QualificationGuard {
  const rows = new Map<string, QualificationGuardRecord>();
  const chains = new Map<string, Promise<void>>();
  const exclusive = async <T>(id: string, run: () => Promise<T> | T): Promise<T> => {
    const previous = chains.get(id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    chains.set(id, previous.then(() => current));
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  };
  return {
    claim: (id) => exclusive(id, () => {
      if (rows.has(id)) return "blocked";
      rows.set(id, { state: "inflight" });
      return "claimed";
    }),
    claimUpgrade: (id) => exclusive(id, () => {
      const row = rows.get(id);
      if (!row || (row.state !== "canceled" && row.state !== "upgrade_rejected")) return "blocked";
      rows.set(id, { ...row, state: "inflight" });
      return "claimed";
    }),
    read: (id) => exclusive(id, () => rows.get(id) ?? null),
    transition: (id, record) => exclusive(id, () => { rows.set(id, record); }),
    clear: (id) => exclusive(id, () => { rows.delete(id); }),
  };
}

function balanceRecord(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const nested = (payload as Record<string, unknown>).balance;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return payload;
}

function orderRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const nested = record.order;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return record;
}

function fixedPoint(value: unknown): { kind: "zero" } | { kind: "positive"; text: string } | { kind: "invalid" } {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return { kind: "zero" };
    if (value > 0) return { kind: "positive", text: String(value) };
    return { kind: "invalid" };
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return { kind: "invalid" };
  if (/^0+(?:\.0+)?$/.test(value)) return { kind: "zero" };
  return { kind: "positive", text: value };
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function safePrice(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) ? value : undefined;
}

function storedResult(row: QualificationGuardRecord | null): QualificationResult {
  if (!row || row.state === "inflight") return { status: "QUALIFICATION_ALREADY_IN_PROGRESS" };
  if (row.state === "order_uncertain") return { status: "QUALIFICATION_ORDER_OUTCOME_UNCERTAIN" };
  if (row.state === "cancel_uncertain") {
    return { status: "QUALIFICATION_CANCEL_UNCERTAIN", orderId: row.orderId ?? undefined, ticker: row.ticker ?? undefined };
  }
  if (row.state === "unexpected_fill") {
    return {
      status: "UNEXPECTED_QUALIFICATION_FILL",
      qualificationOrderCreated: true,
      orderId: row.orderId ?? undefined,
      ticker: row.ticker ?? undefined,
      fillCount: row.fillCount ?? undefined,
      averageFillPrice: row.averageFillPrice ?? undefined,
    };
  }
  return { status: "UPGRADE_OUTCOME_UNCERTAIN", qualificationOrderCreated: true, qualificationOrderCanceled: true, fillCount: "0.00" };
}

function httpClass(result: QualificationExchangeResult | "uncertain"): "uncertain" | "rejected" | "response" {
  if (result === "uncertain" || result.unreadable || result.status >= 500 || result.status === 429 || result.status === 408) return "uncertain";
  if (result.status >= 400) return "rejected";
  return "response";
}

async function readTier(transport: QualificationTransport, creds: QualificationCreds): Promise<
  { ok: true; tier: string | null; advanced: boolean } | { ok: false; status: string }
> {
  const limits = await transport.get(creds, "/trade-api/v2/account/limits");
  if (limits === "uncertain" || limits.status !== 200 || limits.unreadable) return { ok: false, status: "API_TIER_UNAVAILABLE" };
  const tier = predictionsApiTier(limits.body);
  return { ok: true, tier: tier.apiTier, advanced: tier.subaccountCreationTierEligible };
}

async function finishUpgrade(
  guard: QualificationGuard,
  transport: QualificationTransport,
  creds: QualificationCreds,
  connectionId: string,
  orderMeta: { orderId?: string; ticker?: string },
): Promise<QualificationResult> {
  await guard.transition(connectionId, { state: "upgrade_uncertain", orderId: orderMeta.orderId, ticker: orderMeta.ticker, fillCount: "0.00" });
  const upgrade = await transport.post(creds, QUALIFICATION_UPGRADE_PATH);
  const upgradeClass = httpClass(upgrade);
  if (upgradeClass === "uncertain") {
    return { status: "UPGRADE_OUTCOME_UNCERTAIN", qualificationOrderCreated: true, qualificationOrderCanceled: true, fillCount: "0.00" };
  }
  if (upgradeClass === "rejected" || upgrade === "uncertain" || upgrade.status !== 201) {
    await guard.transition(connectionId, { state: "upgrade_rejected", orderId: orderMeta.orderId, ticker: orderMeta.ticker, fillCount: "0.00" });
    return { status: "UPGRADE_REJECTED", qualificationOrderCreated: true, qualificationOrderCanceled: true, fillCount: "0.00" };
  }
  const verified = await readTier(transport, creds);
  if (!verified.ok || !verified.advanced || !verified.tier) {
    return { status: "UPGRADE_NOT_VERIFIED", qualificationOrderCreated: true, qualificationOrderCanceled: true, fillCount: "0.00", usageTier: verified.ok ? verified.tier : null };
  }
  await guard.clear(connectionId);
  return {
    status: "ADVANCED_VERIFIED",
    usageTier: verified.tier,
    qualificationOrderCreated: true,
    qualificationOrderCanceled: true,
    fillCount: "0.00",
  };
}

export async function qualifyAdvancedApi(input: {
  creds: QualificationCreds;
  connectionId: string;
  confirm: unknown;
  guard: QualificationGuard;
  transport: QualificationTransport;
  now?: number;
  newClientOrderId?: () => string;
}): Promise<QualificationResult> {
  if (input.confirm !== QUALIFICATION_CONFIRMATION) return { status: "CONFIRMATION_REQUIRED" };
  const existing = await input.guard.read(input.connectionId);
  if (existing?.state === "canceled" || existing?.state === "upgrade_rejected") {
    const upgradeClaim = await input.guard.claimUpgrade(input.connectionId);
    if (upgradeClaim !== "claimed") return storedResult(await input.guard.read(input.connectionId));
    return finishUpgrade(input.guard, input.transport, input.creds, input.connectionId, {
      orderId: existing.orderId ?? undefined,
      ticker: existing.ticker ?? undefined,
    });
  }
  if (existing) return storedResult(existing);
  if (await input.guard.claim(input.connectionId) !== "claimed") return storedResult(await input.guard.read(input.connectionId));

  const balance = await input.transport.get(input.creds, "/trade-api/v2/portfolio/balance");
  if (balance === "uncertain" || balance.status !== 200 || balance.unreadable) {
    await input.guard.clear(input.connectionId);
    if (balance !== "uncertain" && balance.status === 401) return { status: "PRIMARY_BALANCE_HTTP_401" };
    if (balance !== "uncertain" && balance.status === 403) return { status: "PRIMARY_BALANCE_HTTP_403" };
    return { status: "PRIMARY_BALANCE_AUTH_FAILED" };
  }
  const money = normalizeKalshiMoney(balanceRecord(balance.body));
  if (money.cashCents === null && money.portfolioValueCents === null) {
    await input.guard.clear(input.connectionId);
    return { status: "PRIMARY_BALANCE_INVALID_RESPONSE" };
  }
  const tier = await readTier(input.transport, input.creds);
  if (!tier.ok) {
    await input.guard.clear(input.connectionId);
    return { status: tier.status };
  }
  if (tier.advanced) {
    await input.guard.clear(input.connectionId);
    return { status: "ALREADY_ADVANCED", usageTier: tier.tier };
  }
  if (tier.tier !== "basic") {
    await input.guard.clear(input.connectionId);
    return { status: "API_TIER_NOT_QUALIFIABLE", usageTier: tier.tier };
  }
  if (money.cashCents === null || money.cashCents < 1) {
    await input.guard.clear(input.connectionId);
    return { status: "INSUFFICIENT_PRIMARY_CASH_FOR_QUALIFICATION" };
  }
  const markets = await input.transport.listOpenMarkets();
  const now = input.now ?? Date.now();
  const scan = markets === "uncertain" ? null : scanQualificationMarkets(markets, now);
  if (!scan?.ticker) {
    await input.guard.clear(input.connectionId);
    return scan ? {
      status: "NO_SAFE_QUALIFICATION_MARKET",
      marketsScanned: scan.marketsScanned,
      openMarkets: scan.openMarkets,
      validCloseTimes: scan.validCloseTimes,
      validAskPrices: scan.validAskPrices,
      safeAskPrices: scan.safeAskPrices,
    } : { status: "NO_SAFE_QUALIFICATION_MARKET" };
  }
  const selected = { ticker: scan.ticker };
  const clientOrderId = (input.newClientOrderId ?? randomUUID)();
  const orderBody = qualificationOrderBody(selected.ticker, clientOrderId);
  await input.guard.transition(input.connectionId, {
    state: "order_uncertain",
    clientOrderId,
    ticker: selected.ticker,
  });
  const created = await input.transport.post(input.creds, QUALIFICATION_ORDER_PATH, orderBody);
  const createdClass = httpClass(created);
  if (createdClass !== "response" || created === "uncertain" || created.status !== 201) {
    if (createdClass === "rejected") await input.guard.clear(input.connectionId);
    return { status: createdClass === "rejected" ? "QUALIFICATION_ORDER_REJECTED" : "QUALIFICATION_ORDER_OUTCOME_UNCERTAIN" };
  }
  const order = orderRecord(created.body);
  const orderId = safeId(order?.order_id);
  const fill = fixedPoint(order?.fill_count);
  const remaining = fixedPoint(order?.remaining_count);
  const averageFillPrice = safePrice(order?.average_fill_price);
  if (!orderId || fill.kind === "invalid" || remaining.kind === "invalid") {
    return { status: "QUALIFICATION_ORDER_OUTCOME_UNCERTAIN", ticker: selected.ticker };
  }
  if (fill.kind === "positive") {
    await input.guard.transition(input.connectionId, {
      state: "unexpected_fill",
      clientOrderId,
      orderId,
      ticker: selected.ticker,
      fillCount: fill.text,
      averageFillPrice,
    });
    return {
      status: "UNEXPECTED_QUALIFICATION_FILL",
      qualificationOrderCreated: true,
      orderId,
      ticker: selected.ticker,
      fillCount: fill.text,
      averageFillPrice,
    };
  }
  if (remaining.kind !== "positive") {
    return { status: "QUALIFICATION_ORDER_OUTCOME_UNCERTAIN", orderId, ticker: selected.ticker, fillCount: "0.00" };
  }
  await input.guard.transition(input.connectionId, {
    state: "cancel_uncertain",
    clientOrderId,
    orderId,
    ticker: selected.ticker,
    fillCount: "0.00",
  });
  const canceled = await input.transport.delete(
    input.creds,
    `${QUALIFICATION_ORDER_PATH}/${orderId}`,
    `?market_ticker=${encodeURIComponent(selected.ticker)}`,
  );
  if (httpClass(canceled) !== "response" || canceled === "uncertain" || (canceled.status !== 200 && canceled.status !== 204)) {
    return {
      status: "QUALIFICATION_CANCEL_UNCERTAIN",
      qualificationOrderCreated: true,
      orderId,
      ticker: selected.ticker,
      fillCount: "0.00",
    };
  }
  const cancelBody = canceled.status === 204 ? null : orderRecord(canceled.body);
  if (canceled.status !== 204) {
    const cancelRemaining = fixedPoint(cancelBody?.remaining_count);
    const cancelStatus = cancelBody?.status;
    const proved = cancelRemaining.kind === "zero" || cancelStatus === "canceled" || cancelStatus === "cancelled";
    if (!proved) {
      return {
        status: "QUALIFICATION_CANCEL_UNCERTAIN",
        qualificationOrderCreated: true,
        orderId,
        ticker: selected.ticker,
        fillCount: "0.00",
      };
    }
  }
  await input.guard.transition(input.connectionId, {
    state: "canceled",
    clientOrderId,
    orderId,
    ticker: selected.ticker,
    fillCount: "0.00",
  });
  if (await input.guard.claimUpgrade(input.connectionId) !== "claimed") {
    return storedResult(await input.guard.read(input.connectionId));
  }
  return finishUpgrade(input.guard, input.transport, input.creds, input.connectionId, { orderId, ticker: selected.ticker });
}

export function createLiveQualificationTransport(fetchImpl: typeof fetch = fetch): QualificationTransport {
  const uncertain = (error: unknown): "uncertain" | QualificationExchangeResult => {
    if (error instanceof KalshiApiError && error.type === "HTTP_ERROR") {
      return { status: error.status ?? 0, body: null, unreadable: false };
    }
    return "uncertain";
  };
  return {
    async get(creds, path, query = "") {
      try {
        return { status: 200, body: await getScopedKalshiJson(creds, path, query, fetchImpl), unreadable: false };
      } catch (error) {
        return uncertain(error);
      }
    },
    async post(creds, path, body) {
      try {
        return await mutateScopedKalshi(creds, "POST", path, { body, fetchImpl });
      } catch {
        return "uncertain";
      }
    },
    async delete(creds, path, query = "") {
      try {
        return await mutateScopedKalshi(creds, "DELETE", path, { query, fetchImpl });
      } catch {
        return "uncertain";
      }
    },
    async listOpenMarkets() {
      try {
        const now = Date.now();
        return await listOpenKalshiMarkets(fetchImpl, (markets) => selectQualificationMarket(markets, now) !== null);
      } catch {
        return "uncertain";
      }
    },
  };
}

export function createSqlQualificationGuard(db: {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}): QualificationGuard {
  const readRow = (row: Record<string, unknown> | undefined): QualificationGuardRecord | null => {
    if (!row || typeof row.state !== "string") return null;
    return {
      state: row.state as QualificationGuardState,
      clientOrderId: typeof row.client_order_id === "string" ? row.client_order_id : null,
      orderId: typeof row.order_id === "string" ? row.order_id : null,
      ticker: typeof row.ticker === "string" ? row.ticker : null,
      fillCount: typeof row.fill_count === "string" ? row.fill_count : null,
      averageFillPrice: typeof row.average_fill_price === "string" ? row.average_fill_price : null,
    };
  };
  return {
    async claim(connectionId) {
      const inserted = await db.query(
        `INSERT INTO private.kalshi_api_qualification_guard (provider_connection_id, state)
         VALUES ($1::uuid, 'inflight')
         ON CONFLICT (provider_connection_id) DO NOTHING
         RETURNING provider_connection_id::text`,
        [connectionId],
      );
      return inserted.rows.length === 1 ? "claimed" : "blocked";
    },
    async claimUpgrade(connectionId) {
      const updated = await db.query(
        `UPDATE private.kalshi_api_qualification_guard
         SET state = 'inflight', updated_at = now()
         WHERE provider_connection_id = $1::uuid AND state IN ('canceled', 'upgrade_rejected')
         RETURNING provider_connection_id::text`,
        [connectionId],
      );
      return updated.rows.length === 1 ? "claimed" : "blocked";
    },
    async read(connectionId) {
      const result = await db.query(
        `SELECT state, client_order_id, order_id, ticker, fill_count, average_fill_price
         FROM private.kalshi_api_qualification_guard
         WHERE provider_connection_id = $1::uuid`,
        [connectionId],
      );
      return readRow(result.rows[0]);
    },
    async transition(connectionId, record) {
      await db.query(
        `UPDATE private.kalshi_api_qualification_guard
         SET state = $2, client_order_id = $3, order_id = $4, ticker = $5,
             fill_count = $6, average_fill_price = $7, updated_at = now()
         WHERE provider_connection_id = $1::uuid`,
        [
          connectionId, record.state, record.clientOrderId ?? null, record.orderId ?? null,
          record.ticker ?? null, record.fillCount ?? null, record.averageFillPrice ?? null,
        ],
      );
    },
    async clear(connectionId) {
      await db.query(
        `DELETE FROM private.kalshi_api_qualification_guard WHERE provider_connection_id = $1::uuid`,
        [connectionId],
      );
    },
  };
}
