import { predictionsApiTier } from "../kalshiSubaccountInventory";
import type { QualificationGuardRecord } from "./qualifyAdvancedApi";

export type DiagnosticReadOutcome = "OK" | "HTTP_401" | "HTTP_404" | "HTTP_4XX" | "HTTP_5XX" | "UNREADABLE" | "UNCERTAIN";

export interface DiagnosticRead {
  outcome: DiagnosticReadOutcome;
  body?: unknown;
}

export interface SanitizedQualificationOrder {
  orderId?: string;
  clientOrderId?: string;
  ticker?: string;
  status?: string;
  subaccountNumber?: number | null;
  exchangeIndex?: number | null;
  createdTime?: string;
  lastUpdateTime?: string;
  fillCount?: string;
  remainingCount?: string;
  initialCount?: string;
  yesPriceDollars?: string;
  noPriceDollars?: string;
  bookSide?: string;
  outcomeSide?: string;
  cancelOrderOnPause?: boolean;
}

export interface QualificationDiagnostic {
  status: string;
  guard: {
    state: string | null;
    orderId: string | null;
    clientOrderId: string | null;
    ticker: string | null;
    fillCount: string | null;
    residualRiskAcceptedAt: string | null;
    advancedVerifiedAt: string | null;
  };
  tier: {
    readOutcome: DiagnosticReadOutcome;
    apiUsageTier: string | null;
    predictionsGrantLevel: string | null;
    predictionsGrantSource: string | null;
    predictionsGrantExpiresAt: number | null;
  };
  exactOrder: {
    readOutcome: DiagnosticReadOutcome;
    orderFound: boolean;
    orderIdMatchesGuard: boolean | null;
    clientOrderIdMatchesGuard: boolean | null;
    tickerMatchesGuard: boolean | null;
    isPrimarySubaccount: boolean | null;
    order: SanitizedQualificationOrder | null;
  };
  currentPrimaryOrders: {
    readOutcome: DiagnosticReadOutcome;
    count: number | null;
    storedOrderFound: boolean;
    orderIdMatchesGuard: boolean | null;
    clientOrderIdMatchesGuard: boolean | null;
    tickerMatchesGuard: boolean | null;
    isPrimarySubaccount: boolean | null;
    status: string | null;
    createdTime: string | null;
  };
  historicalOrders: {
    readOutcome: DiagnosticReadOutcome;
    countForStoredTicker: number | null;
    storedOrderFound: boolean;
    orderIdMatchesGuard: boolean | null;
    clientOrderIdMatchesGuard: boolean | null;
    tickerMatchesGuard: boolean | null;
    isPrimarySubaccount: boolean | null;
    order: SanitizedQualificationOrder | null;
  };
  conclusions: {
    storedQualificationEvidenceExists: boolean;
    exactOrderVisibleToAuthenticatedKalshiUser: boolean;
    exactOrderMatchesGuard: boolean;
    primarySubaccountConfirmed: boolean;
    visibleInCurrentOrHistoricalOrders: boolean;
    kalshiExposesApiCreatedFlag: false;
  };
}

const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TICKER = /^[A-Za-z0-9._-]{1,128}$/;
const CONTRACT = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const DOLLARS = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;
const TOKEN = /^[A-Za-z0-9_+.:-]{1,64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function classifyDiagnosticRead(status: number, unreadable: boolean): DiagnosticReadOutcome {
  if (unreadable) return "UNREADABLE";
  if (status === 200) return "OK";
  if (status === 401) return "HTTP_401";
  if (status === 404) return "HTTP_404";
  if (status >= 500) return "HTTP_5XX";
  if (status >= 400) return "HTTP_4XX";
  return "UNCERTAIN";
}

function textToken(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 40 && TIMESTAMP.test(value) ? value : undefined;
}

function contractText(record: Record<string, unknown>, fixedKey: string, legacyKey: string): string | undefined {
  if (fixedKey in record && record[fixedKey] != null) {
    return typeof record[fixedKey] === "string" && CONTRACT.test(record[fixedKey]) ? record[fixedKey] : undefined;
  }
  if (legacyKey in record && record[legacyKey] != null) {
    return typeof record[legacyKey] === "string" && CONTRACT.test(record[legacyKey]) ? record[legacyKey] : undefined;
  }
  return undefined;
}

function dollarText(value: unknown): string | undefined {
  if (typeof value !== "string" || !DOLLARS.test(value)) return undefined;
  const [wholeText, fractionText = ""] = value.split(".");
  const units = BigInt(wholeText) * 10000n + BigInt((fractionText + "0000").slice(0, 4));
  return units <= 10000n ? value : undefined;
}

function safeInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const units = BigInt(value);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(units);
}

function sanitizeOrder(value: unknown): SanitizedQualificationOrder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const subaccountPresent = "subaccount_number" in row && row.subaccount_number != null;
  const exchangePresent = "exchange_index" in row && row.exchange_index != null;
  const order: SanitizedQualificationOrder = {};
  if (typeof row.order_id === "string" && ORDER_ID.test(row.order_id)) order.orderId = row.order_id;
  if (typeof row.client_order_id === "string" && ORDER_ID.test(row.client_order_id)) order.clientOrderId = row.client_order_id;
  if (typeof row.ticker === "string" && TICKER.test(row.ticker)) order.ticker = row.ticker;
  const status = textToken(row.status);
  if (status) order.status = status;
  order.subaccountNumber = subaccountPresent ? safeInteger(row.subaccount_number) : null;
  order.exchangeIndex = exchangePresent ? safeInteger(row.exchange_index) : null;
  const created = timestamp(row.created_time);
  if (created) order.createdTime = created;
  const updated = timestamp(row.last_update_time);
  if (updated) order.lastUpdateTime = updated;
  const fill = contractText(row, "fill_count_fp", "fill_count");
  if (fill) order.fillCount = fill;
  const remaining = contractText(row, "remaining_count_fp", "remaining_count");
  if (remaining) order.remainingCount = remaining;
  const initial = contractText(row, "initial_count_fp", "initial_count");
  if (initial) order.initialCount = initial;
  const yes = dollarText(row.yes_price_dollars);
  if (yes) order.yesPriceDollars = yes;
  const no = dollarText(row.no_price_dollars);
  if (no) order.noPriceDollars = no;
  const book = textToken(row.book_side);
  if (book) order.bookSide = book;
  const outcome = textToken(row.outcome_side);
  if (outcome) order.outcomeSide = outcome;
  if (typeof row.cancel_order_on_pause === "boolean") order.cancelOrderOnPause = row.cancel_order_on_pause;
  return order;
}

function orderList(body: unknown): { ok: true; orders: unknown[] } | { ok: false } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  const orders = (body as Record<string, unknown>).orders;
  if (!Array.isArray(orders)) return { ok: false };
  return { ok: true, orders };
}

function nestedOrder(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (body as Record<string, unknown>).order ?? null;
}

function matches(left: string | null | undefined, right: string | null | undefined): boolean | null {
  if (!left || !right) return null;
  return left === right;
}

function primary(order: SanitizedQualificationOrder | null): boolean | null {
  if (!order || order.subaccountNumber == null) return null;
  return order.subaccountNumber === 0;
}

function predictionsGrant(body: unknown): {
  level: string | null;
  source: string | null;
  expiresAt: number | null;
} {
  const empty = { level: null, source: null, expiresAt: null };
  if (!body || typeof body !== "object" || Array.isArray(body)) return empty;
  const grants = (body as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return empty;
  const lane = grants.find((grant) => grant && typeof grant === "object" && !Array.isArray(grant)
    && (grant as Record<string, unknown>).exchange_instance === "event_contract") as Record<string, unknown> | undefined;
  if (!lane) return empty;
  return {
    level: textToken(lane.level) ?? null,
    source: textToken(lane.source) ?? null,
    expiresAt: "expires_ts" in lane && lane.expires_ts != null ? safeInteger(lane.expires_ts) : null,
  };
}

export async function readQualificationDiagnostics(input: {
  guard: QualificationGuardRecord | null;
  get?: (path: string, query: string) => Promise<DiagnosticRead>;
}): Promise<QualificationDiagnostic> {
  const guard = input.guard;
  const orderId = typeof guard?.orderId === "string" && ORDER_ID.test(guard.orderId) ? guard.orderId : null;
  const clientOrderId = typeof guard?.clientOrderId === "string" && ORDER_ID.test(guard.clientOrderId) ? guard.clientOrderId : null;
  const ticker = typeof guard?.ticker === "string" && TICKER.test(guard.ticker) ? guard.ticker : null;
  const skipped = async (): Promise<DiagnosticRead> => ({ outcome: "UNCERTAIN" });
  const get = input.get ?? skipped;
  const tierRead = await get("/trade-api/v2/account/limits", "");
  const exactRead = orderId
    ? await get(`/trade-api/v2/portfolio/orders/${orderId}`, "")
    : await skipped();
  const currentRead = await get("/trade-api/v2/portfolio/orders", "?limit=100&subaccount=0");
  const historicalRead = ticker
    ? await get("/trade-api/v2/historical/orders", `?ticker=${encodeURIComponent(ticker)}&limit=100`)
    : await skipped();

  const grant = tierRead.outcome === "OK" ? predictionsGrant(tierRead.body) : { level: null, source: null, expiresAt: null };
  const tier = tierRead.outcome === "OK" ? predictionsApiTier(tierRead.body).apiTier : null;

  const rawExact = exactRead.outcome === "OK" ? nestedOrder(exactRead.body) : null;
  const exactOrder = rawExact == null ? null : sanitizeOrder(rawExact);
  const exactOutcome: DiagnosticReadOutcome = exactRead.outcome === "OK" && rawExact == null ? "UNREADABLE" : exactRead.outcome;
  const exact = {
    readOutcome: exactOutcome,
    orderFound: exactOrder?.orderId != null,
    orderIdMatchesGuard: matches(orderId, exactOrder?.orderId),
    clientOrderIdMatchesGuard: matches(clientOrderId, exactOrder?.clientOrderId),
    tickerMatchesGuard: matches(ticker, exactOrder?.ticker),
    isPrimarySubaccount: primary(exactOrder),
    order: exactOrder,
  };

  const currentList = currentRead.outcome === "OK" ? orderList(currentRead.body) : null;
  const currentFound = currentList?.ok
    ? currentList.orders.map(sanitizeOrder).find((order) => order?.orderId === orderId) ?? null
    : null;
  const historicalList = historicalRead.outcome === "OK" ? orderList(historicalRead.body) : null;
  const historicalFound = historicalList?.ok
    ? historicalList.orders.map(sanitizeOrder).find((order) => order?.orderId === orderId) ?? null
    : null;
  const exactMatches = exact.orderFound
    && exact.orderIdMatchesGuard === true
    && exact.tickerMatchesGuard === true
    && (clientOrderId === null || exact.clientOrderIdMatchesGuard === true);
  const subaccounts = [exact.order, currentFound, historicalFound]
    .map((order) => order?.subaccountNumber)
    .filter((value): value is number => value != null);
  const primaryConfirmed = subaccounts.length > 0 && subaccounts.every((value) => value === 0);

  return {
    status: "QUALIFICATION_DIAGNOSTIC_READY",
    guard: {
      state: guard?.state ?? null,
      orderId,
      clientOrderId,
      ticker,
      fillCount: typeof guard?.fillCount === "string" && CONTRACT.test(guard.fillCount) ? guard.fillCount : null,
      residualRiskAcceptedAt: typeof guard?.residualRiskAcceptedAt === "string" ? guard.residualRiskAcceptedAt : null,
      advancedVerifiedAt: typeof guard?.advancedVerifiedAt === "string" ? guard.advancedVerifiedAt : null,
    },
    tier: {
      readOutcome: tierRead.outcome,
      apiUsageTier: tier,
      predictionsGrantLevel: grant.level,
      predictionsGrantSource: grant.source,
      predictionsGrantExpiresAt: grant.expiresAt,
    },
    exactOrder: exact,
    currentPrimaryOrders: {
      readOutcome: currentRead.outcome === "OK" && currentList && !currentList.ok ? "UNREADABLE" : currentRead.outcome,
      count: currentList?.ok ? currentList.orders.length : null,
      storedOrderFound: currentFound != null,
      orderIdMatchesGuard: matches(orderId, currentFound?.orderId),
      clientOrderIdMatchesGuard: matches(clientOrderId, currentFound?.clientOrderId),
      tickerMatchesGuard: matches(ticker, currentFound?.ticker),
      isPrimarySubaccount: primary(currentFound),
      status: currentFound?.status ?? null,
      createdTime: currentFound?.createdTime ?? null,
    },
    historicalOrders: {
      readOutcome: historicalRead.outcome === "OK" && historicalList && !historicalList.ok ? "UNREADABLE" : historicalRead.outcome,
      countForStoredTicker: historicalList?.ok ? historicalList.orders.length : null,
      storedOrderFound: historicalFound != null,
      orderIdMatchesGuard: matches(orderId, historicalFound?.orderId),
      clientOrderIdMatchesGuard: matches(clientOrderId, historicalFound?.clientOrderId),
      tickerMatchesGuard: matches(ticker, historicalFound?.ticker),
      isPrimarySubaccount: primary(historicalFound),
      order: historicalFound,
    },
    conclusions: {
      storedQualificationEvidenceExists: guard != null && orderId != null && ticker != null,
      exactOrderVisibleToAuthenticatedKalshiUser: exact.orderFound && exact.readOutcome === "OK",
      exactOrderMatchesGuard: exactMatches,
      primarySubaccountConfirmed: primaryConfirmed,
      visibleInCurrentOrHistoricalOrders: currentFound != null || historicalFound != null,
      kalshiExposesApiCreatedFlag: false,
    },
  };
}
