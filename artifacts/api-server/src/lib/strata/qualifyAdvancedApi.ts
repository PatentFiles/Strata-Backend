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
export const RESIDUAL_RISK_CONFIRMATION = "PROCEED_WITH_ADVANCED_UPGRADE_DESPITE_UNCERTAIN_1CENT_CANCEL";
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
  | "canceled"
  | "advanced_verified_with_cancel_uncertain";

export interface QualificationGuardRecord {
  state: QualificationGuardState;
  clientOrderId?: string | null;
  orderId?: string | null;
  ticker?: string | null;
  fillCount?: string | null;
  averageFillPrice?: string | null;
  residualRiskAcceptedAt?: string | null;
  advancedVerifiedAt?: string | null;
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
  qualificationOrderCancellationUncertain?: boolean;
  acceptedResidualOrderRisk?: boolean;
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

/** Exact contract quantity in hundredths. Rejects floats, negatives, and more than two decimals. */
function contractHundredths(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return null;
  const [wholeText, fractionText = ""] = value.split(".");
  const units = BigInt(wholeText) * 100n + BigInt((fractionText + "00").slice(0, 2));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(units);
}

function cancelV2Proved(
  result: QualificationExchangeResult | "uncertain",
  expected: { orderId: string; clientOrderId?: string | null },
): boolean {
  if (result === "uncertain" || result.unreadable || result.status !== 200) return false;
  if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) return false;
  const body = result.body as Record<string, unknown>;
  if (body.order_id !== expected.orderId) return false;
  if ("client_order_id" in body && body.client_order_id != null && body.client_order_id !== expected.clientOrderId) return false;
  if (body.reduced_by !== "1.00" || contractHundredths(body.reduced_by) !== 100) return false;
  if ("ts_ms" in body && (typeof body.ts_ms !== "number" || !Number.isSafeInteger(body.ts_ms))) return false;
  return true;
}

function nestedOrder(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const nested = (body as Record<string, unknown>).order;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  return nested as Record<string, unknown>;
}

function matchesWhenPresent(record: Record<string, unknown>, key: string, expected: string | null | undefined): boolean {
  if (!(key in record) || record[key] == null) return true;
  return record[key] === expected;
}

type ReconciledOrder =
  | { kind: "canceled" }
  | { kind: "resting" }
  | { kind: "fill"; fillCount?: string; averageFillPrice?: string }
  | { kind: "unknown" };

function reconcileQualificationOrder(
  body: unknown,
  stored: { orderId: string; clientOrderId?: string | null; ticker?: string | null },
): ReconciledOrder {
  const order = nestedOrder(body);
  if (!order || order.order_id !== stored.orderId) return { kind: "unknown" };
  if (!matchesWhenPresent(order, "ticker", stored.ticker)) return { kind: "unknown" };
  if (!matchesWhenPresent(order, "client_order_id", stored.clientOrderId)) return { kind: "unknown" };
  const fill = contractHundredths(order.fill_count);
  const remaining = contractHundredths(order.remaining_count);
  const status = order.status;
  const fillCount = typeof order.fill_count === "string" && fill !== null ? order.fill_count : undefined;
  const averageFillPrice = safePrice(order.average_fill_price);
  if (fill !== null && fill > 0) return { kind: "fill", fillCount, averageFillPrice };
  if (status === "executed" || status === "filled" || status === "partially_executed") {
    return { kind: "fill", fillCount, averageFillPrice };
  }
  if (fill === 0 && remaining === 0 && status === "canceled") return { kind: "canceled" };
  if (fill === 0 && remaining === 100 && status === "resting") return { kind: "resting" };
  return { kind: "unknown" };
}

function safeTicker(value: string | null | undefined): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function residualEvidence(row: { orderId?: string | null; ticker?: string | null }): Omit<QualificationResult, "status"> {
  return {
    qualificationOrderCreated: true,
    qualificationOrderCancellationUncertain: true,
    acceptedResidualOrderRisk: true,
    orderId: safeId(row.orderId) ?? undefined,
    ticker: safeTicker(row.ticker),
  };
}

function storedResult(row: QualificationGuardRecord | null): QualificationResult {
  if (!row || row.state === "inflight") return { status: "QUALIFICATION_ALREADY_IN_PROGRESS" };
  if (row.state === "order_uncertain") return { status: "QUALIFICATION_ORDER_OUTCOME_UNCERTAIN" };
  if (row.state === "advanced_verified_with_cancel_uncertain") return { status: "ADVANCED_VERIFIED", ...residualEvidence(row) };
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
  if (row.residualRiskAcceptedAt) {
    return {
      status: row.state === "upgrade_rejected" ? "UPGRADE_REJECTED" : "UPGRADE_OUTCOME_UNCERTAIN",
      ...residualEvidence(row),
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

async function upgradeCanceledAttempt(
  guard: QualificationGuard,
  transport: QualificationTransport,
  creds: QualificationCreds,
  connectionId: string,
  orderMeta: { clientOrderId?: string | null; orderId: string; ticker: string },
): Promise<QualificationResult> {
  await guard.transition(connectionId, {
    state: "canceled",
    clientOrderId: orderMeta.clientOrderId,
    orderId: orderMeta.orderId,
    ticker: orderMeta.ticker,
    fillCount: "0.00",
  });
  if (await guard.claimUpgrade(connectionId) !== "claimed") return storedResult(await guard.read(connectionId));
  return finishUpgrade(guard, transport, creds, connectionId, { orderId: orderMeta.orderId, ticker: orderMeta.ticker });
}

async function recoverCancelUncertain(
  input: {
    creds: QualificationCreds;
    connectionId: string;
    guard: QualificationGuard;
    transport: QualificationTransport;
  },
  existing: QualificationGuardRecord,
): Promise<QualificationResult> {
  const orderId = safeId(existing.orderId);
  const ticker = typeof existing.ticker === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(existing.ticker) ? existing.ticker : null;
  const stopped = {
    status: "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN",
    qualificationOrderCreated: true,
    orderId: orderId ?? undefined,
    ticker: existing.ticker ?? undefined,
    fillCount: "0.00",
  };
  if (!orderId || !ticker) return stopped;
  const read = await input.transport.get(input.creds, `/trade-api/v2/portfolio/orders/${orderId}`);
  if (read === "uncertain" || read.unreadable || read.status !== 200) return stopped;
  const picture = reconcileQualificationOrder(read.body, {
    orderId,
    clientOrderId: existing.clientOrderId,
    ticker,
  });
  if (picture.kind === "unknown") return stopped;
  if (picture.kind === "fill") {
    await input.guard.transition(input.connectionId, {
      state: "unexpected_fill",
      clientOrderId: existing.clientOrderId,
      orderId,
      ticker,
      fillCount: picture.fillCount,
      averageFillPrice: picture.averageFillPrice,
    });
    return {
      status: "UNEXPECTED_QUALIFICATION_FILL",
      qualificationOrderCreated: true,
      orderId,
      ticker,
      fillCount: picture.fillCount,
      averageFillPrice: picture.averageFillPrice,
    };
  }
  if (picture.kind === "resting") {
    const canceled = await input.transport.delete(
      input.creds,
      `${QUALIFICATION_ORDER_PATH}/${orderId}`,
      `?market_ticker=${encodeURIComponent(ticker)}`,
    );
    if (!cancelV2Proved(canceled, { orderId, clientOrderId: existing.clientOrderId })) {
      return {
        status: "QUALIFICATION_CANCEL_UNCERTAIN",
        qualificationOrderCreated: true,
        orderId,
        ticker,
        fillCount: "0.00",
      };
    }
  }
  return upgradeCanceledAttempt(input.guard, input.transport, input.creds, input.connectionId, {
    clientOrderId: existing.clientOrderId,
    orderId,
    ticker,
  });
}

async function requestResidualUpgrade(
  input: {
    creds: QualificationCreds;
    connectionId: string;
    guard: QualificationGuard;
    transport: QualificationTransport;
    now?: number;
  },
  existing: QualificationGuardRecord,
): Promise<QualificationResult> {
  const orderId = safeId(existing.orderId);
  const ticker = safeTicker(existing.ticker);
  const openEvidence = {
    status: "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN",
    ...residualEvidence({ ...existing, orderId, ticker }),
  };
  if (!orderId || !ticker) return openEvidence;
  const kept = {
    clientOrderId: existing.clientOrderId ?? null,
    orderId,
    ticker,
    fillCount: "0.00",
    residualRiskAcceptedAt: existing.residualRiskAcceptedAt ?? new Date(input.now ?? Date.now()).toISOString(),
  };
  const visible = residualEvidence(kept);
  const tier = await readTier(input.transport, input.creds);
  if (!tier.ok) return { status: tier.status, ...visible };
  if (!tier.advanced && tier.tier !== "basic") {
    return { status: "API_TIER_NOT_QUALIFIABLE", usageTier: tier.tier, ...visible };
  }
  if (tier.advanced) {
    await input.guard.transition(input.connectionId, {
      ...kept,
      state: "advanced_verified_with_cancel_uncertain",
      advancedVerifiedAt: new Date(input.now ?? Date.now()).toISOString(),
    });
    return { status: "ALREADY_ADVANCED", usageTier: tier.tier, ...visible };
  }
  await input.guard.transition(input.connectionId, { ...kept, state: "upgrade_uncertain" });
  const upgrade = await input.transport.post(input.creds, QUALIFICATION_UPGRADE_PATH);
  const upgradeClass = httpClass(upgrade);
  if (upgradeClass === "uncertain") return { status: "UPGRADE_OUTCOME_UNCERTAIN", ...visible };
  if (upgradeClass === "rejected" || upgrade === "uncertain" || upgrade.status !== 201) {
    await input.guard.transition(input.connectionId, { ...kept, state: "upgrade_rejected" });
    return { status: "UPGRADE_REJECTED", ...visible };
  }
  const verified = await readTier(input.transport, input.creds);
  if (!verified.ok || !verified.advanced || !verified.tier) {
    return { status: "UPGRADE_NOT_VERIFIED", usageTier: verified.ok ? verified.tier : null, ...visible };
  }
  await input.guard.transition(input.connectionId, {
    ...kept,
    state: "advanced_verified_with_cancel_uncertain",
    advancedVerifiedAt: new Date(input.now ?? Date.now()).toISOString(),
  });
  return { status: "ADVANCED_VERIFIED", usageTier: verified.tier, ...visible };
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
  const normal = input.confirm === QUALIFICATION_CONFIRMATION;
  const residual = input.confirm === RESIDUAL_RISK_CONFIRMATION;
  if (!normal && !residual) return { status: "CONFIRMATION_REQUIRED" };
  const existing = await input.guard.read(input.connectionId);
  if (existing?.state === "advanced_verified_with_cancel_uncertain") {
    return { status: "ADVANCED_VERIFIED", ...residualEvidence(existing) };
  }
  if (existing?.residualRiskAcceptedAt && existing.state === "upgrade_uncertain") {
    return { status: "UPGRADE_OUTCOME_UNCERTAIN", ...residualEvidence(existing) };
  }
  if (existing?.residualRiskAcceptedAt && existing.state === "upgrade_rejected") {
    if (!residual) return { status: "UPGRADE_REJECTED", ...residualEvidence(existing) };
    return requestResidualUpgrade(input, existing);
  }
  if (residual) {
    if (existing?.state !== "cancel_uncertain") return { status: "RESIDUAL_RISK_CONFIRMATION_NOT_APPLICABLE" };
    return requestResidualUpgrade(input, existing);
  }
  if (existing?.state === "canceled" || existing?.state === "upgrade_rejected") {
    const upgradeClaim = await input.guard.claimUpgrade(input.connectionId);
    if (upgradeClaim !== "claimed") return storedResult(await input.guard.read(input.connectionId));
    return finishUpgrade(input.guard, input.transport, input.creds, input.connectionId, {
      orderId: existing.orderId ?? undefined,
      ticker: existing.ticker ?? undefined,
    });
  }
  if (existing?.state === "cancel_uncertain") return recoverCancelUncertain(input, existing);
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
  if (!cancelV2Proved(canceled, { orderId, clientOrderId })) {
    return {
      status: "QUALIFICATION_CANCEL_UNCERTAIN",
      qualificationOrderCreated: true,
      orderId,
      ticker: selected.ticker,
      fillCount: "0.00",
    };
  }
  return upgradeCanceledAttempt(input.guard, input.transport, input.creds, input.connectionId, {
    clientOrderId,
    orderId,
    ticker: selected.ticker,
  });
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
  const timestamp = (value: unknown): string | null => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const readRow = (row: Record<string, unknown> | undefined): QualificationGuardRecord | null => {
    if (!row || typeof row.state !== "string") return null;
    return {
      state: row.state as QualificationGuardState,
      clientOrderId: typeof row.client_order_id === "string" ? row.client_order_id : null,
      orderId: typeof row.order_id === "string" ? row.order_id : null,
      ticker: typeof row.ticker === "string" ? row.ticker : null,
      fillCount: typeof row.fill_count === "string" ? row.fill_count : null,
      averageFillPrice: typeof row.average_fill_price === "string" ? row.average_fill_price : null,
      residualRiskAcceptedAt: timestamp(row.residual_risk_accepted_at),
      advancedVerifiedAt: timestamp(row.advanced_verified_at),
    };
  };
  const undefinedAuditColumn = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    if ("code" in error && (error as { code?: unknown }).code === "42703") return true;
    return error instanceof Error && /residual_risk_accepted_at|advanced_verified_at/.test(error.message);
  };
  const BASE_READ = `SELECT state, client_order_id, order_id, ticker, fill_count, average_fill_price
         FROM private.kalshi_api_qualification_guard
         WHERE provider_connection_id = $1::uuid`;
  const AUDIT_READ = `SELECT state, client_order_id, order_id, ticker, fill_count, average_fill_price,
            residual_risk_accepted_at, advanced_verified_at
         FROM private.kalshi_api_qualification_guard
         WHERE provider_connection_id = $1::uuid`;
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
      try {
        const result = await db.query(AUDIT_READ, [connectionId]);
        return readRow(result.rows[0]);
      } catch (error) {
        if (!undefinedAuditColumn(error)) throw error;
        const result = await db.query(BASE_READ, [connectionId]);
        return readRow(result.rows[0]);
      }
    },
    async transition(connectionId, record) {
      if (record.residualRiskAcceptedAt || record.advancedVerifiedAt || record.state === "advanced_verified_with_cancel_uncertain") {
        await db.query(
          `UPDATE private.kalshi_api_qualification_guard
           SET residual_risk_accepted_at = COALESCE($2::timestamptz, residual_risk_accepted_at),
               advanced_verified_at = COALESCE($3::timestamptz, advanced_verified_at),
               updated_at = now()
           WHERE provider_connection_id = $1::uuid`,
          [connectionId, record.residualRiskAcceptedAt ?? null, record.advancedVerifiedAt ?? null],
        );
      }
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
