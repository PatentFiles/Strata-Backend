import {
  constants as cryptoConstants,
  createPrivateKey,
  createHash,
  createSign,
  sign,
} from "node:crypto";
import {
  compatibleOptionalDirection, compatibleOptionalPrice, mergeDirectionAndPrices,
} from "./microLiveFillNormalization";
import {
  blockingSubaccountTransferDetail,
  cleanPairInventoryDiagnosis,
  provePreBoundaryRoundTrip,
  type BlockingSubaccountTransfer,
} from "./strata/commissioning";

export type KalshiAccountSnapshot = {
  balance: {
    availableCashDollars: string;
    portfolioValueDollars: string | null;
  };
  openOrders: Array<{
    id: string;
    ticker: string;
    /** Explicit API shard identity; null is unproven and is never inferred. */
    exchangeIndex?: number | null;
    side: string;
    action: string;
    priceDollars: string | null;
    remainingCount: string | null;
    status: string;
    createdAt: string | null;
  }>;
  positions: Array<{
    ticker: string;
    /** Explicit API shard identity; null is unproven and is never inferred. */
    exchangeIndex?: number | null;
    positionFp: string;
    marketExposureDollars: string | null;
    realizedPnlDollars: string | null;
  }>;
  fills: Array<{
    id: string;
    orderId: string | null;
    ticker: string;
    /** Explicit API shard identity; null is unproven and is never inferred. */
    exchangeIndex?: number | null;
    side: string;
    action: string;
    countFp: string;
    priceDollars: string | null;
    createdAt: string | null;
    feeCostDollars?: string | null;
    outcomeSide?: string | null;
    bookSide?: string | null;
    yesPriceDollars?: string | null;
    noPriceDollars?: string | null;
  }>;
  truncated: {
    openOrders: boolean;
    positions: boolean;
    fills: boolean;
  };
};

export type KalshiDedicatedPairEvidence = {
  pair: { subaccountNumber: number; exchangeIndex: 2 };
  balance: {
    subaccountNumber: number;
    exchangeIndex: 2;
    /** Balance from the subaccount inventory response; not a cash fallback. */
    balanceDollars: string | null;
    /** Available balance from the scoped /portfolio/balance response. */
    availableCashDollars?: string | null;
    balanceSemantics?: "subaccount_inventory_plus_scoped_available_cash";
    updatedTs: number;
  };
  /** Exact cash/position values read for the pair; micros are canonical integers. */
  collateralSnapshot?: {
    availableCashMicros: string | null;
    inventoryBalanceMicros: string | null;
    restingEntryReserveMicros: string | null;
    restingExitContractsByTicker: Record<string, string>;
    capturedAt: string;
  };
  marketExchangeIndex: 2 | null;
  keyRestrictionVerified: boolean;
  tradePermissionVerified: boolean;
  /**
   * True only when every required page and record since the persisted anchor
   * was read and attributed. `exclusiveControlVerified` remains false: an API
   * inventory cannot prove that no other actor can submit between reads.
   */
  allTimeHistoryExhaustive: boolean;
  exclusiveControlVerified: false;
  complete?: boolean;
  reason?: string | null;
  reasons?: string[];
  /** Stable normalized account history; no raw credential material is included. */
  records?: KalshiPairEvidenceRecord[];
  feeEvidence?: Array<{
    source: "fill" | "settlement";
    id: string;
    ticker: string;
    feeCostDollars: string | null;
    feeMicros: string | null;
    classification: KalshiPairEvidenceClassification;
  }>;
  postAnchorCashDeltaMicros?: string | null;
  checkpointDigest?: string | null;
  historyCoveredFrom?: string | null;
  fundingAnchor?: {
    transferId: string;
    transferredAt: string;
    amountCents: 2500;
    baselineCashMicros: "25000000";
    baselineAt: string;
    preFundingZeroSnapshot?: {
      availableCashMicros: "0";
      capturedAt: string;
      evidenceDigest: string;
      authenticated: true;
      balanceSemantics: "available_cash";
    };
    postFundingSnapshot?: {
      availableCashMicros: "25000000";
      capturedAt: string;
      evidenceDigest: string;
      authenticated: true;
      balanceSemantics: "available_cash";
    };
  } | null;
  recordCounts: {
    positions: number;
    orders: number;
    fills: number;
    settlements: number;
    transfers: number;
  };
  scanStartedAt: string;
  scanFinishedAt: string;
};

/**
 * Server-observed prospective boundary for a newly provisioned pair before
 * funding. The digest is emitted only when the signed read set proves zero
 * available cash, no exposure, no prior pair activity, and complete coverage.
 * This shape intentionally carries no caller-assertable `authenticated` flag.
 */
export type KalshiProspectiveCleanPairSnapshot = {
  pair: { subaccountNumber: number; exchangeIndex: 2 };
  status: "clean" | "blocked";
  capturedAt: string;
  scanStartedAt: string;
  scanFinishedAt: string;
  availableCashMicros: "0" | null;
  inventoryCashMicros: "0" | null;
  portfolioValueMicros?: "0" | null;
  zeroPositions: boolean;
  zeroOrders: boolean;
  zeroFills: boolean;
  zeroSettlements: boolean;
  zeroPriorPairTransfers: boolean;
  keyRestrictionVerified: boolean;
  tradePermissionVerified: boolean;
  marketExchangeIndex: 2 | null;
  evidenceDigest: string | null;
  reasons: string[];
  records: KalshiPairEvidenceRecord[];
  /** Diagnostic only. Omitted from the clean-boundary evidence digest. */
  blockingTransfer?: BlockingSubaccountTransfer | null;
  /** True only when the persisted two-transfer round trip was reproven and nothing else blocked. */
  preBoundaryRoundTripSatisfied?: boolean;
};

export type KalshiPairEvidenceClassification = "pair" | "elsewhere" | "ambiguous";

export type KalshiPairEvidenceRecord = {
  feed: "balance" | "scoped_balance" | "position" | "current_order" | "historical_order" |
    "current_fill" | "historical_fill" | "settlement" | "subaccount_transfer" |
    "cross_exchange_transfer";
  id: string;
  classification: KalshiPairEvidenceClassification;
  attribution: "record_fields" | "settlement_subaccount_filter" |
    "balance_subaccount_exchange_filter" | "unscoped";
  subaccountNumber: number | null;
  exchangeIndex: number | null;
  sourceExchangeIndex?: number | null;
  destinationExchangeIndex?: number | null;
  occurredAt: string | null;
  /** Exact signed cash effect in micros; null for non-cash records. */
  cashDeltaMicros: string | null;
  feeCostDollars?: string | null;
  feeMicros?: string | null;
  payloadDigest: string;
  details: Record<string, string | null>;
};

export type KalshiDedicatedPairFundingAnchor = {
  transferId: string;
  transferredAt: string;
  amountCents: 2500;
  baselineCashMicros: "25000000";
  baselineAt: string;
  /** Authenticated available-cash read immediately before the exact transfer. */
  preFundingZeroSnapshot?: {
    availableCashMicros: "0";
    capturedAt: string;
    evidenceDigest: string;
    authenticated: true;
    balanceSemantics: "available_cash";
  };
  /** Authenticated available-cash read after the transfer; this is the baseline. */
  postFundingSnapshot?: {
    availableCashMicros: "25000000";
    capturedAt: string;
    evidenceDigest: string;
    authenticated: true;
    balanceSemantics: "available_cash";
  };
};

export type KalshiSettlementsSnapshot = {
  settlements: Array<{
    ticker: string;
    eventTicker: string;
    /** Explicit API shard identity; null is unproven and is never inferred. */
    exchangeIndex?: number | null;
    marketResult: string;
    yesCountFp: string;
    yesTotalCostDollars: string;
    noCountFp: string;
    noTotalCostDollars: string;
    revenueCents: string;
    settledAt: string;
    feeCostDollars: string | null;
  }>;
  truncated: boolean;
};

export type KalshiOrderbookLevel = {
  priceDollars: string;
  availableContracts: string;
};

export type KalshiOrderbook = {
  yesAskDollars: string | null;
  noAskDollars: string | null;
  yesBidDollars: string | null;
  noBidDollars: string | null;
  yesAskAvailableContracts: string | null;
  noAskAvailableContracts: string | null;
  /** Full normalized depth, best-to-worst. Optional only for legacy test seams. */
  yesBidLevels?: KalshiOrderbookLevel[];
  noBidLevels?: KalshiOrderbookLevel[];
  yesAskLevels?: KalshiOrderbookLevel[];
  noAskLevels?: KalshiOrderbookLevel[];
  observedAt: string;
};

/** Read-only evidence for an ID-less POST. Never infer rejection from an empty list. */
export type KalshiSubmissionEvidence = {
  orders: Array<{
    id: string; clientOrderId: string | null; ticker: string; side: string; action: string;
    type: string; status: string; priceDollars: string | null;
    initialCount: string; filledCount: string; remainingCount: string;
    /** Explicit API shard identity; null is unproven and is never inferred. */
    exchangeIndex?: number | null;
    outcomeSide?: string | null; bookSide?: string | null;
  }>;
  fills: Array<KalshiAccountSnapshot["fills"][number] & { feeCostDollars: string | null }>;
  /** Fills returned directly by the authenticated historical endpoint. */
  historicalFills?: Array<KalshiAccountSnapshot["fills"][number] & { feeCostDollars: string | null }>;
  truncated: boolean;
  historicalFillsAvailable?: boolean;
};

export type KalshiHistoricalFillsSnapshot = {
  fills: KalshiAccountSnapshot["fills"];
  truncated: boolean;
  available: boolean;
};

/** Account-wide current + archived evidence for the selected bot subaccount. */
type AccountOrderSource = {
  endpoint: "portfolio/orders" | "historical/orders";
  page: number;
};

export type KalshiAccountActivity = {
  orders: Array<KalshiSubmissionEvidence["orders"][number] & {
    createdAt: string | null;
    /** Every authenticated page that supplied this exact order record. */
    sources?: AccountOrderSource[];
  }>;
  fills: KalshiSubmissionEvidence["fills"];
  available: boolean;
  truncated: boolean;
  /** Differing records for an order ID; the order is excluded and the scan is unusable. */
  orderOverlapConflicts?: Array<{ sources: AccountOrderSource[] }>;
  /** Owner-visible metadata check; not proof that no other authorized actor can trade. */
  keyRestrictionVerified?: boolean;
  /** The selected key is recorded with read and trade scopes. */
  tradePermissionVerified?: boolean;
  /** Subaccount selector used for every history request in this scan. */
  selectedSubaccount?: number;
  /** Wall-clock bounds of the account-wide activity scan. */
  scanStartedAt?: string;
  scanFinishedAt?: string;
  /** Deliberately false until independent exclusive-control/race safety is proven. */
  exclusiveControlVerified: boolean;
};

export class KalshiApiError extends Error {
  constructor(
    readonly type: "NOT_CONFIGURED" | "INVALID_CREDENTIALS" | "NETWORK_ERROR" |
      "HTTP_ERROR" | "INVALID_JSON" | "INVALID_RESPONSE",
    readonly status?: number,
  ) {
    super(status === undefined
      ? `Kalshi request failed (${type})`
      : `Kalshi request failed (${type}, HTTP ${status})`);
    this.name = "KalshiApiError";
  }
}

const API_PREFIX = "/trade-api/v2";
const PAGE_LIMIT = 100;
const MAX_ACCOUNT_PAGES = 20;
const MAX_ACCOUNT_RECORDS = 1_000;
const ACCOUNT_TIMEOUT_MS = 15_000;

type Credentials = { keyId: string; privateKey: string };
type JsonObject = Record<string, unknown>;

export function getConfiguredKalshiSubaccount(): number {
  const configured = process.env.KALSHI_BOT_SUBACCOUNT;
  if (configured === undefined || configured === "") throw new KalshiApiError("NOT_CONFIGURED");
  if (!/^(?:0|[1-9]\d*)$/.test(configured)) throw new KalshiApiError("INVALID_CREDENTIALS");
  const subaccount = Number(configured);
  if (!Number.isSafeInteger(subaccount) || subaccount < 0 || subaccount > 63) {
    throw new KalshiApiError("INVALID_CREDENTIALS");
  }
  return subaccount;
}

export function getKalshiCredentialsState(): "NOT_CONFIGURED" | "CONFIGURED" {
  return process.env.KALSHI_API_KEY_ID?.trim() &&
      process.env.KALSHI_API_PRIVATE_KEY?.trim()
    ? "CONFIGURED"
    : "NOT_CONFIGURED";
}

function credentials(): Credentials {
  const keyId = process.env.KALSHI_API_KEY_ID?.trim();
  const privateKey = process.env.KALSHI_API_PRIVATE_KEY?.trim();
  if (!keyId || !privateKey) throw new KalshiApiError("NOT_CONFIGURED");
  return { keyId, privateKey: normalizeKalshiPem(privateKey) };
}

function baseUrl(): string {
  const environment = process.env.KALSHI_API_ENVIRONMENT ?? "demo";
  if (environment !== "demo" && environment !== "production") {
    throw new KalshiApiError("INVALID_CREDENTIALS");
  }
  return environment === "production"
    ? "https://external-api.kalshi.com"
    : "https://external-api.demo.kalshi.co";
}

function normalizeKalshiPem(privateKey: string): string {
  return privateKey.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
}

function signRequest(creds: Credentials, method: "GET" | "POST" | "DELETE", path: string, timestamp: string): string {
  try {
    const key = createPrivateKey(normalizeKalshiPem(creds.privateKey));
    const message = Buffer.from(`${timestamp}${method}${path}`);
    if (key.asymmetricKeyType === "ed25519") return sign(null, message, key).toString("base64");
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
      throw new Error("Unsupported signing key");
    }
    const signer = createSign("sha256");
    signer.update(message);
    signer.end();
    return signer.sign({
      key,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64");
  } catch {
    throw new KalshiApiError("INVALID_CREDENTIALS");
  }
}

function isAllowedGetPath(path: string): boolean {
  return path === `${API_PREFIX}/portfolio/balance` ||
    path === `${API_PREFIX}/portfolio/subaccounts/balances` ||
    path === `${API_PREFIX}/portfolio/subaccounts/transfers` ||
    path === `${API_PREFIX}/portfolio/intra_exchange_instance_transfers` ||
    path === `${API_PREFIX}/portfolio/orders` ||
    path === `${API_PREFIX}/portfolio/positions` ||
    path === `${API_PREFIX}/portfolio/fills` ||
    path === `${API_PREFIX}/portfolio/settlements` ||
    path === `${API_PREFIX}/historical/orders` ||
    path === `${API_PREFIX}/historical/fills` ||
    path === `${API_PREFIX}/api_keys` ||
    path === `${API_PREFIX}/account/limits` ||
    /^\/trade-api\/v2\/markets\/[^/]+$/.test(path) ||
    /^\/trade-api\/v2\/markets\/[^/]+\/orderbook$/.test(path);
}

const SCOPED_GET_ORDER_PATH = /^\/trade-api\/v2\/portfolio\/orders\/[A-Za-z0-9_-]{1,128}$/;

export async function getScopedKalshiJson(
  creds: { keyId: string; privateKey: string },
  path: string,
  query = "",
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (!isAllowedGetPath(path) && !SCOPED_GET_ORDER_PATH.test(path)) throw new KalshiApiError("INVALID_RESPONSE");
  const timestamp = Date.now().toString();
  const signature = signRequest(creds, "GET", path, timestamp);
  const response = await fetchImpl(`${baseUrl()}${path}${query}`, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "KALSHI-ACCESS-KEY": creds.keyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    },
  });
  if (!response.ok) throw new KalshiApiError("HTTP_ERROR", response.status);
  return await response.json() as unknown;
}

const QUALIFICATION_ORDER_PATH = `${API_PREFIX}/portfolio/events/orders`;
const QUALIFICATION_UPGRADE_PATH = `${API_PREFIX}/account/api_usage_level/upgrade`;
const SUBACCOUNT_CREATION_PATH = `${API_PREFIX}/portfolio/subaccounts`;

function isAllowedQualificationMutation(method: "POST" | "DELETE", path: string): boolean {
  if (method === "POST") return path === QUALIFICATION_ORDER_PATH || path === QUALIFICATION_UPGRADE_PATH;
  return /^\/trade-api\/v2\/portfolio\/events\/orders\/[A-Za-z0-9_-]{1,128}$/.test(path);
}

/** Signed qualification POST or DELETE. Any other path is refused before the network. */
export async function mutateScopedKalshi(
  creds: { keyId: string; privateKey: string },
  method: "POST" | "DELETE",
  path: string,
  options: { query?: string; body?: unknown; fetchImpl?: typeof fetch } = {},
): Promise<{ status: number; body: unknown; unreadable: boolean }> {
  if (!isAllowedQualificationMutation(method, path)) throw new KalshiApiError("INVALID_RESPONSE");
  const timestamp = Date.now().toString();
  const signature = signRequest(creds, method, path, timestamp);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": creds.keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
  let body: string | undefined;
  if (method === "POST" && options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl()}${path}${options.query ?? ""}`, {
    method,
    cache: "no-store",
    redirect: "manual",
    headers,
    body,
  });
  if (response.status >= 300 && response.status < 400) return { status: response.status, body: null, unreadable: true };
  const text = await response.text();
  if (!text) return { status: response.status, body: null, unreadable: false };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown, unreadable: false };
  } catch {
    return { status: response.status, body: null, unreadable: true };
  }
}

/**
 * The only user-scoped setup mutation transport. The path and exchange index
 * are fixed so callers cannot turn account setup authorization into a general
 * Kalshi write capability.
 */
export async function createScopedKalshiSubaccountOne(
  creds: { keyId: string; privateKey: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: unknown; unreadable: boolean }> {
  const timestamp = Date.now().toString();
  const signature = signRequest(creds, "POST", SUBACCOUNT_CREATION_PATH, timestamp);
  const response = await fetchImpl(`${baseUrl()}${SUBACCOUNT_CREATION_PATH}`, {
    method: "POST",
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": creds.keyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    },
    body: JSON.stringify({ exchange_index: 2 }),
  });
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, body: null, unreadable: true };
  }
  const text = await response.text();
  if (!text) return { status: response.status, body: null, unreadable: false };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown, unreadable: false };
  } catch {
    return { status: response.status, body: null, unreadable: true };
  }
}

export const OPEN_MARKET_PAGE_LIMIT = 1000;
export const OPEN_MARKET_MAX_PAGES = 3;
export const OPEN_MARKET_MAX_MARKETS = 3000;

const OPEN_MARKET_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/** Public open-market pages. Stops early when stopWhen is satisfied. No user credential is sent. */
export async function listOpenKalshiMarkets(
  fetchImpl: typeof fetch = fetch,
  stopWhen?: (markets: unknown[]) => boolean,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < OPEN_MARKET_MAX_PAGES && collected.length < OPEN_MARKET_MAX_MARKETS; page += 1) {
    const params = new URLSearchParams({
      status: "open",
      mve_filter: "exclude",
      limit: String(OPEN_MARKET_PAGE_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);
    const response = await fetchImpl(`${baseUrl()}/trade-api/v2/markets?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
    });
    if (response.status !== 200) throw new KalshiApiError("HTTP_ERROR", response.status);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new KalshiApiError("INVALID_RESPONSE");
    const record = payload as Record<string, unknown>;
    if (!Array.isArray(record.markets)) throw new KalshiApiError("INVALID_RESPONSE");
    const room = OPEN_MARKET_MAX_MARKETS - collected.length;
    collected.push(...record.markets.slice(0, room));
    if (stopWhen?.(collected)) break;
    if (!("cursor" in record) || record.cursor == null || record.cursor === "") break;
    if (typeof record.cursor !== "string" || !OPEN_MARKET_CURSOR.test(record.cursor)) {
      throw new KalshiApiError("INVALID_RESPONSE");
    }
    cursor = record.cursor;
  }
  return collected;
}

async function getJson(path: string, query = "", signal?: AbortSignal): Promise<unknown> {
  if (!isAllowedGetPath(path)) throw new KalshiApiError("INVALID_RESPONSE");
  return getJsonWithCredentials(path, query, credentials(), signal);
}

async function getJsonWithCredentials(
  path: string,
  query: string,
  creds: Credentials,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!isAllowedGetPath(path)) throw new KalshiApiError("INVALID_RESPONSE");
  const timestamp = Date.now().toString();
  const signature = signRequest(creds, "GET", path, timestamp);
  const url = `${baseUrl()}${path}${query}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal,
      headers: {
        Accept: "application/json",
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      },
    });
  } catch {
    throw new KalshiApiError("NETWORK_ERROR");
  }
  if (!response.ok) throw new KalshiApiError("HTTP_ERROR", response.status);
  try {
    return await response.json() as unknown;
  } catch {
    throw new KalshiApiError("INVALID_JSON");
  }
}

function verifierCredentials(): Credentials {
  const keyId = process.env.KALSHI_VERIFIER_API_KEY_ID?.trim();
  const privateKey = process.env.KALSHI_VERIFIER_API_PRIVATE_KEY?.trim();
  if (!keyId || !privateKey) throw new KalshiApiError("NOT_CONFIGURED");
  const pem = privateKey.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  return { keyId, privateKey: pem };
}

/** Verify key restrictions with separate, optional owner credentials. */
export async function verifyKalshiTradingKeyRestriction(): Promise<boolean> {
  try {
    const subaccount = getConfiguredKalshiSubaccount();
    if (subaccount === 0) return false;
    return await verifyKalshiTradingKeyRestrictionForSubaccount(subaccount);
  } catch {
    return false;
  }
}

/**
 * Verify read+trade scope for the selected key without asserting that it is
 * restricted to a subaccount or that the account is exclusively controlled.
 * This is evidence for a separate mutation authorization gate, not ownership.
 */
export async function verifyKalshiTradingKeyTradePermission(): Promise<boolean> {
  try {
    return await verifyKalshiTradingKeyTradePermissionForSubaccount(
      getConfiguredKalshiSubaccount(),
    );
  } catch {
    return false;
  }
}

/** Independently verify the selected restricted key's exact N and scope set. */
export async function verifyKalshiRestrictedTradingKeyForSubaccount(
  subaccount: number,
  source: "shared" | "index2" = "shared",
): Promise<boolean> {
  const verifierKeyId = process.env.KALSHI_VERIFIER_API_KEY_ID?.trim();
  const verifierPrivateKey = process.env.KALSHI_VERIFIER_API_PRIVATE_KEY?.trim();
  const targetKeyId = process.env[source === "index2"
    ? "KALSHI_INDEX2_API_KEY_ID" : "KALSHI_API_KEY_ID"]?.trim();
  if (!Number.isSafeInteger(subaccount) || subaccount < 1 || subaccount > 63 ||
      !verifierKeyId || !verifierPrivateKey || !targetKeyId) return false;
  try {
    const pem = verifierPrivateKey.replaceAll("\\n", "\n")
      .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
      .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
    const creds = { keyId: verifierKeyId, privateKey: pem };
    const path = `${API_PREFIX}/api_keys`;
    const timestamp = Date.now().toString();
    const response = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signRequest(creds, "GET", path, timestamp),
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      },
    });
    if (!response.ok) return false;
    const payload = object(await response.json() as unknown);
    if (!Array.isArray(payload.api_keys)) return false;
    const key = payload.api_keys.map(object).find((record) =>
      record.api_key_id === targetKeyId);
    if (!key || key.subaccount !== subaccount || !Array.isArray(key.scopes)) return false;
    if (source === "index2" && key.name !== "Strata INDEX2") return false;
    const scopes = key.scopes;
    const exactScopes = scopes.length === 2 && scopes.includes("read") &&
      scopes.includes("write::trade") && scopes.every((scope) =>
        scope === "read" || scope === "write::trade");
    if (!exactScopes) return false;

    // Metadata only proves the key record's declared binding. Prove that the
    // configured private key actually authenticates as that key ID by making a
    // read-only request to the exact pair-scoped balance endpoint.
    const selectedCredentials = source === "index2"
      ? (() => {
          const raw = process.env.KALSHI_INDEX2_PRIVATE_KEY?.trim();
          if (!raw) throw new KalshiApiError("NOT_CONFIGURED");
          return {
            keyId: targetKeyId,
            privateKey: raw.replaceAll("\\n", "\n")
              .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
              .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1"),
          };
        })()
      : credentials();
    if (selectedCredentials.keyId !== targetKeyId) return false;
    const balancePath = `${API_PREFIX}/portfolio/balance`;
    const balanceQuery = `?subaccount=${subaccount}&exchange_index=2`;
    const balancePayload = object(await getJsonWithCredentials(
      balancePath,
      balanceQuery,
      selectedCredentials,
      AbortSignal.timeout(15_000),
    ));
    const balance = balancePayload.balance && typeof balancePayload.balance === "object" &&
        !Array.isArray(balancePayload.balance)
      ? object(balancePayload.balance)
      : balancePayload;
    const returnedSubaccounts = [
      balance.subaccount_number, balance.subaccount,
      balancePayload.subaccount_number, balancePayload.subaccount,
    ].filter((value) => value !== undefined && value !== null);
    const returnedIndexes = [
      balance.exchange_index, balancePayload.exchange_index,
    ].filter((value) => value !== undefined && value !== null);
    if (returnedSubaccounts.some((value) =>
      evidenceInteger(value) !== subaccount)) return false;
    if (returnedIndexes.some((value) => evidenceInteger(value) !== 2)) return false;
    return firstDecimal(balance, ["balance_dollars", "balance"]) !== null;
  } catch {
    return false;
  }
}

async function verifyKalshiTradingKeyTradePermissionForSubaccount(
  subaccount: number,
  source: "shared" | "index2" = "shared",
): Promise<boolean> {
  const verifierKeyId = process.env.KALSHI_VERIFIER_API_KEY_ID?.trim();
  const verifierPrivateKey = process.env.KALSHI_VERIFIER_API_PRIVATE_KEY?.trim();
  if (!verifierKeyId || !verifierPrivateKey) return false;

  try {
    const targetKeyId = process.env[source === "index2"
      ? "KALSHI_INDEX2_API_KEY_ID" : "KALSHI_API_KEY_ID"]?.trim();
    if (!targetKeyId) return false;
    const pem = verifierPrivateKey.replaceAll("\\n", "\n")
      .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
      .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
    const creds = { keyId: verifierKeyId, privateKey: pem };
    const path = `${API_PREFIX}/api_keys`;
    const timestamp = Date.now().toString();
    const signature = signRequest(creds, "GET", path, timestamp);
    const response = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      },
    });
    if (!response.ok) return false;
    const payload = object(await response.json() as unknown);
    if (!Array.isArray(payload.api_keys)) return false;
    const record = payload.api_keys.map(object).find((item) =>
      item.api_key_id === targetKeyId);
    if (!record || !Array.isArray(record.scopes) ||
        (subaccount === 0 && !record.scopes.every((scope) => typeof scope === "string"))) {
      return false;
    }
    const hasSubaccount = Object.prototype.hasOwnProperty.call(record, "subaccount");
    // Kalshi documents absent/null as unrestricted. Only primary mode accepts
    // omission; numbered subaccount verification retains its existing policy.
    if (subaccount === 0
      ? (hasSubaccount && record.subaccount !== null && record.subaccount !== 0)
      : (!hasSubaccount ||
        (record.subaccount !== null && record.subaccount !== subaccount))) {
      return false;
    }
    const scopes = record.scopes;
    return scopes.includes("read") &&
      (scopes.includes("write") || scopes.includes("write::trade"));
  } catch {
    return false;
  }
}

async function verifyKalshiTradingKeyRestrictionForSubaccount(
  subaccount: number,
  source: "shared" | "index2" = "shared",
): Promise<boolean> {
  const verifierKeyId = process.env.KALSHI_VERIFIER_API_KEY_ID?.trim();
  const verifierPrivateKey = process.env.KALSHI_VERIFIER_API_PRIVATE_KEY?.trim();
  if (!verifierKeyId || !verifierPrivateKey) return false;

  try {
    const targetKeyId = process.env[source === "index2"
      ? "KALSHI_INDEX2_API_KEY_ID" : "KALSHI_API_KEY_ID"]?.trim();
    if (!targetKeyId) return false;
    const pem = verifierPrivateKey.replaceAll("\\n", "\n")
      .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
      .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
    const creds = { keyId: verifierKeyId, privateKey: pem };
    const path = `${API_PREFIX}/api_keys`;
    const timestamp = Date.now().toString();
    const signature = signRequest(creds, "GET", path, timestamp);
    const response = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      },
    });
    if (!response.ok) return false;
    const payload = object(await response.json() as unknown);
    if (!Array.isArray(payload.api_keys)) return false;
    const record = payload.api_keys.map(object).find((item) =>
      item.api_key_id === targetKeyId);
    if (!record || record.subaccount !== subaccount || !Array.isArray(record.scopes)) {
      return false;
    }
    const scopes = record.scopes;
    return scopes.includes("read") &&
      (scopes.includes("write") || scopes.includes("write::trade"));
  } catch {
    return false;
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  return value as JsonObject;
}

function assertMatchingSubaccount(value: JsonObject, expectedSubaccount?: number): void {
  const selectedSubaccount = expectedSubaccount ?? getConfiguredKalshiSubaccount();
  if (value.subaccount !== undefined && value.subaccount !== null &&
      value.subaccount !== selectedSubaccount) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
}

function requiredString(source: JsonObject, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  throw new KalshiApiError("INVALID_RESPONSE");
}

function optionalString(source: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  return null;
}

function decimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    if (value === null || value === undefined) return null;
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  return text;
}

function firstDecimal(source: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return decimal(source[key]);
  }
  return null;
}

function requiredDecimal(source: JsonObject, keys: string[]): string {
  const value = firstDecimal(source, keys);
  if (value === null) throw new KalshiApiError("INVALID_RESPONSE");
  return value;
}

function centsToDollars(value: unknown): string | null {
  const cents = decimal(value);
  if (cents === null) return null;
  if (!/^-?\d+$/.test(cents)) throw new KalshiApiError("INVALID_RESPONSE");
  const amount = BigInt(cents);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function dollarsOrCents(
  source: JsonObject,
  dollarKeys: string[],
  centKeys: string[],
): string | null {
  const dollars = firstDecimal(source, dollarKeys);
  return dollars !== null ? dollars : centsToDollars(firstDecimal(source, centKeys));
}

function exactDollarStringToCents(dollars: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(dollars);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if ([...fraction.slice(2)].some((digit) => digit !== "0")) return null;
  const cents = BigInt(match[2]!) * 100n + BigInt((fraction + "00").slice(0, 2));
  const signed = match[1] === "-" ? -cents : cents;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(signed);
}

/** Fixed-point dollar fields win. Integer fields are already cents. Malformed values are null. */
export function reviewedKalshiCents(
  source: Record<string, unknown>,
  dollarKeys: string[],
  centKeys: string[],
): number | null {
  try {
    const dollars = dollarsOrCents(source, dollarKeys, centKeys);
    if (dollars === null) return null;
    return exactDollarStringToCents(dollars);
  } catch {
    return null;
  }
}

function dateString(source: JsonObject, keys: string[]): string | null {
  const value = optionalString(source, keys);
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new KalshiApiError("INVALID_RESPONSE");
  return new Date(timestamp).toISOString();
}

function listPage(
  payload: unknown,
  keys: string[],
  expectedSubaccount?: number,
): { values: JsonObject[]; cursor: string | null } {
  const root = object(payload);
  assertMatchingSubaccount(root, expectedSubaccount);
  let value: unknown;
  for (const key of keys) {
    if (root[key] !== undefined) {
      value = root[key];
      break;
    }
  }
  if (!Array.isArray(value) || value.length > PAGE_LIMIT) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const cursor = root.cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  return {
    values: value.map((record) => {
      const item = object(record);
      assertMatchingSubaccount(item, expectedSubaccount);
      return item;
    }),
    cursor: typeof cursor === "string" && cursor.length > 0 ? cursor : null,
  };
}

class PaginationTimeoutError extends KalshiApiError {
  constructor() {
    super("NETWORK_ERROR");
  }
}

type PageCollection = {
  values: JsonObject[];
  pageNumbers: number[];
  truncated: boolean;
  truncationReason: string | null;
};

async function getJsonWithTimeout(
  path: string,
  query: string,
  timeoutMs: number,
  credentials?: Credentials,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      credentials
        ? getJsonWithCredentials(path, query, credentials, controller.signal)
        : getJson(path, query, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PaginationTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function getJsonWithCredentialsTimeout(
  path: string,
  query: string,
  timeoutMs: number,
  creds: Credentials,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getJsonWithCredentials(path, query, creds, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PaginationTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function listAllPages(
  path: string,
  baseQuery: string,
  keys: string[],
  dedupeId?: (value: JsonObject) => string,
  duplicateKey?: (value: JsonObject) => string,
  expectedSubaccount?: number,
  requestPage: (path: string, query: string, timeoutMs: number) => Promise<unknown> =
    getJsonWithTimeout,
): Promise<PageCollection> {
  const values: JsonObject[] = [];
  const pageNumbers: number[] = [];
  const ids = new Map<string, string>();
  const duplicateKeys = new Set<string>();
  const cursors = new Set<string>();
  const startedAt = Date.now();
  let cursor: string | null = null;
  let pageCount = 0;
  let truncated = false;
  let truncationReason: string | null = null;

  while (true) {
    if (pageCount >= MAX_ACCOUNT_PAGES) {
      truncated = true;
      truncationReason = "page_cap_reached";
      break;
    }
    if (values.length >= MAX_ACCOUNT_RECORDS) {
      truncated = true;
      truncationReason = "record_cap_reached";
      break;
    }
    const remainingMs = ACCOUNT_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      truncated = true;
      truncationReason = "timeout";
      break;
    }

    const query = `${baseQuery}${cursor === null ? "" : `${baseQuery.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`}`;
    let payload: unknown;
    try {
      payload = await requestPage(path, query, remainingMs);
    } catch (error) {
      if (error instanceof PaginationTimeoutError && pageCount > 0) {
        truncated = true;
        truncationReason = "timeout";
        break;
      }
      throw error;
    }
    pageCount += 1;
    const page = listPage(payload, keys, expectedSubaccount);
    const remainingRecords = MAX_ACCOUNT_RECORDS - values.length;
    const records = page.values.slice(0, remainingRecords);
    for (const record of records) {
      if (dedupeId) {
        const id = dedupeId(record);
        const fingerprint = canonicalJson(record);
        const previous = ids.get(id);
        if (previous !== undefined) {
          if (previous === fingerprint) continue;
          truncated = true;
          truncationReason = "conflicting_duplicate";
        } else {
          ids.set(id, fingerprint);
        }
      }
      if (duplicateKey) {
        const key = duplicateKey(record);
        if (duplicateKeys.has(key)) truncated = true;
        else duplicateKeys.add(key);
      }
      values.push(record);
      pageNumbers.push(pageCount);
    }
    if (page.values.length > remainingRecords) {
      truncated = true;
      truncationReason = "record_cap_reached";
      break;
    }
    if (page.cursor === null) break;
    if (cursors.has(page.cursor)) {
      truncated = true;
      truncationReason = "cursor_loop";
      break;
    }
    if (pageCount >= MAX_ACCOUNT_PAGES) {
      truncated = true;
      truncationReason = "page_cap_reached";
      break;
    }
    if (values.length >= MAX_ACCOUNT_RECORDS) {
      truncated = true;
      truncationReason = "record_cap_reached";
      break;
    }
    cursor = page.cursor;
    cursors.add(cursor);
  }
  return { values, pageNumbers, truncated, truncationReason };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const source = value as JsonObject;
    return `{${Object.keys(source).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function mergeAccountOrderHistory(
  current: { values: JsonObject[]; pageNumbers: number[] },
  archived: { values: JsonObject[]; pageNumbers: number[] },
): { orders: KalshiAccountActivity["orders"]; orderOverlapConflicts: Array<{ sources: AccountOrderSource[] }> } {
  const byId = new Map<string, { value: JsonObject; fingerprint: string; sources: AccountOrderSource[] }>();
  const conflicts = new Map<string, AccountOrderSource[]>();
  for (const [batch, endpoint] of [
    [current, "portfolio/orders"],
    [archived, "historical/orders"],
  ] as const) {
    batch.values.forEach((value, index) => {
      const id = orderId(value);
      const source: AccountOrderSource = { endpoint, page: batch.pageNumbers[index]! };
      const conflictSources = conflicts.get(id);
      if (conflictSources) {
        conflictSources.push(source);
        return;
      }
      const fingerprint = canonicalJson(value);
      const prior = byId.get(id);
      if (prior) {
        if (prior.fingerprint === fingerprint) {
          prior.sources.push(source);
        } else {
          // Never select either version when any field differs.
          conflicts.set(id, [...prior.sources, source]);
          byId.delete(id);
        }
      } else {
        byId.set(id, { value, fingerprint, sources: [source] });
      }
    });
  }
  return {
    orders: [...byId.values()].map(({ value, sources }) => ({
      ...normalizeOrder(value),
      clientOrderId: value.client_order_id === "" ? null : optionalString(value, ["client_order_id"]),
      type: requiredString(value, ["type"]),
      initialCount: requiredDecimal(value, ["initial_count_fp", "initial_count"]),
      filledCount: requiredDecimal(value, ["fill_count_fp", "fill_count"]),
      remainingCount: requiredDecimal(value, ["remaining_count_fp", "remaining_count"]),
      sources,
    })),
    orderOverlapConflicts: [...conflicts.values()].map((sources) => ({ sources })),
  };
}

function sameFillImmutableFields(
  left: KalshiAccountSnapshot["fills"][number],
  right: KalshiAccountSnapshot["fills"][number],
): boolean {
  return left.id === right.id && left.orderId === right.orderId &&
    left.ticker === right.ticker && left.exchangeIndex === right.exchangeIndex &&
    left.side === right.side &&
    left.action === right.action && Number(left.countFp) === Number(right.countFp) &&
    (left.priceDollars === null || right.priceDollars === null
      ? left.priceDollars === right.priceDollars
      : Number(left.priceDollars) === Number(right.priceDollars)) &&
    left.createdAt === right.createdAt &&
    compatibleOptionalDirection(left, right) &&
    compatibleOptionalPrice(left.yesPriceDollars, right.yesPriceDollars) &&
    compatibleOptionalPrice(left.noPriceDollars, right.noPriceDollars);
}

function mergeFillSnapshots(
  current: KalshiAccountSnapshot["fills"],
  historical: KalshiAccountSnapshot["fills"],
): KalshiAccountSnapshot["fills"] {
  const fills = new Map<string, KalshiAccountSnapshot["fills"][number]>();
  for (const fill of [...current, ...historical]) {
    const previous = fills.get(fill.id);
    if (!previous) {
      fills.set(fill.id, fill);
      continue;
    }
    if (!sameFillImmutableFields(previous, fill) ||
        (previous.feeCostDollars != null && fill.feeCostDollars != null &&
          Number(previous.feeCostDollars) !== Number(fill.feeCostDollars))) {
      throw new KalshiApiError("INVALID_RESPONSE");
    }
    // A fee may be promoted from unknown only when the other authenticated
    // endpoint supplies one consistent value.
    fills.set(fill.id, {
      ...mergeDirectionAndPrices(previous, fill),
      feeCostDollars: previous.feeCostDollars ?? fill.feeCostDollars ?? null,
    });
  }
  return [...fills.values()];
}

function orderId(value: JsonObject): string {
  return requiredString(value, ["order_id", "id"]);
}

function fillId(value: JsonObject): string {
  return requiredString(value, ["trade_id", "fill_id", "id"]);
}

function positionTicker(value: JsonObject): string {
  return requiredString(value, ["ticker", "market_ticker"]);
}

function sidePrice(
  value: JsonObject,
  side: string,
): string | null {
  if (side !== "yes" && side !== "no") throw new KalshiApiError("INVALID_RESPONSE");
  const prefix = side === "yes" ? "yes" : "no";
  return dollarsOrCents(
    value,
    [`${prefix}_price_dollars`, "price_dollars"],
    [`${prefix}_price`, "price"],
  );
}

function normalizeOrder(value: JsonObject) {
  const side = requiredString(value, ["side"]);
  return {
    id: requiredString(value, ["order_id", "id"]),
    ticker: requiredString(value, ["ticker", "market_ticker"]),
    exchangeIndex: normalizedExchangeIndex(value.exchange_index),
    side,
    action: requiredString(value, ["action"]),
    outcomeSide: optionalString(value, ["outcome_side"]),
    bookSide: optionalString(value, ["book_side"]),
    priceDollars: sidePrice(value, side),
    remainingCount: firstDecimal(value, ["remaining_count_fp", "remaining_count"]),
    status: requiredString(value, ["status"]),
    createdAt: dateString(value, ["created_time", "created_at"]),
  };
}

function normalizePosition(value: JsonObject) {
  return {
    ticker: requiredString(value, ["ticker", "market_ticker"]),
    exchangeIndex: normalizedExchangeIndex(value.exchange_index),
    positionFp: requiredDecimal(value, ["position_fp", "position"]),
    marketExposureDollars: dollarsOrCents(
      value,
      ["market_exposure_dollars"],
      ["market_exposure"],
    ),
    realizedPnlDollars: dollarsOrCents(value, ["realized_pnl_dollars"], ["realized_pnl"]),
  };
}

function normalizeFill(value: JsonObject) {
  const side = requiredString(value, ["side"]);
  return {
    id: requiredString(value, ["trade_id", "fill_id", "id"]),
    orderId: optionalString(value, ["order_id"]),
    ticker: requiredString(value, ["ticker", "market_ticker"]),
    exchangeIndex: normalizedExchangeIndex(value.exchange_index),
    side,
    action: requiredString(value, ["action"]),
    outcomeSide: optionalString(value, ["outcome_side"]),
    bookSide: optionalString(value, ["book_side"]),
    yesPriceDollars: dollarsOrCents(value, ["yes_price_dollars"], ["yes_price"]),
    noPriceDollars: dollarsOrCents(value, ["no_price_dollars"], ["no_price"]),
    countFp: requiredDecimal(value, ["count_fp", "count"]),
    priceDollars: sidePrice(value, side),
    createdAt: dateString(value, ["created_time", "created_at"]),
    feeCostDollars: fixedPointFeeCost(value),
  };
}

/**
 * Preserve only an explicit nonnegative integer shard index. Missing or
 * malformed values stay unproven; ticker is never used as a fallback.
 */
function normalizedExchangeIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function fixedPointFeeCost(source: JsonObject): string | null {
  const value = source.fee_cost;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  return decimal(value);
}

function settlementTicker(value: JsonObject): string {
  return requiredString(value, ["ticker"]);
}

function normalizeSettlement(value: JsonObject) {
  const marketResult = requiredString(value, ["market_result"]);
  if (!["yes", "no", "scalar"].includes(marketResult)) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const revenue = value.revenue;
  if (typeof revenue !== "number" || !Number.isSafeInteger(revenue)) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const payoutValue = value.value;
  if (payoutValue !== undefined && payoutValue !== null &&
      (typeof payoutValue !== "number" || !Number.isSafeInteger(payoutValue))) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const feeCostDollars = fixedPointFeeCost(value);
  const settledAt = dateString(value, ["settled_time"]);
  if (settledAt === null) throw new KalshiApiError("INVALID_RESPONSE");
  return {
    ticker: settlementTicker(value),
    eventTicker: requiredString(value, ["event_ticker"]),
    exchangeIndex: normalizedExchangeIndex(value.exchange_index),
    marketResult,
    yesCountFp: requiredDecimal(value, ["yes_count_fp"]),
    yesTotalCostDollars: requiredDecimal(value, ["yes_total_cost_dollars"]),
    noCountFp: requiredDecimal(value, ["no_count_fp"]),
    noTotalCostDollars: requiredDecimal(value, ["no_total_cost_dollars"]),
    revenueCents: String(revenue),
    settledAt,
    feeCostDollars,
  };
}

export async function readKalshiSettlements(): Promise<KalshiSettlementsSnapshot> {
  const subaccount = getConfiguredKalshiSubaccount();
  const result = await listAllPages(
    `${API_PREFIX}/portfolio/settlements`,
    `?limit=${PAGE_LIMIT}&subaccount=${subaccount}`,
    ["settlements"],
    undefined,
    settlementTicker,
  );
  return {
    settlements: result.values.map(normalizeSettlement),
    truncated: result.truncated,
  };
}

export async function readKalshiSubmissionEvidence(ticker: string): Promise<KalshiSubmissionEvidence> {
  if (!/^KXBTC15M[A-Za-z0-9._-]*$/.test(ticker)) throw new KalshiApiError("INVALID_RESPONSE");
  const subaccount = getConfiguredKalshiSubaccount();
  const query = `?ticker=${encodeURIComponent(ticker)}&limit=${PAGE_LIMIT}&subaccount=${subaccount}`;
  // Some exchange environments return 404 for /historical/fills despite
  // serving /historical/orders. This is not evidence that no fill occurred:
  // the resolver still requires current fills to equal the order's fill count.
  const [currentOrders, historicalOrders, currentFills, historicalFills] = await Promise.all([
    listAllPages(`${API_PREFIX}/portfolio/orders`, query, ["orders"], orderId),
    listAllPages(`${API_PREFIX}/historical/orders`, query, ["orders"], orderId),
    listAllPages(`${API_PREFIX}/portfolio/fills`, query, ["fills"], fillId),
    listAllPages(`${API_PREFIX}/historical/fills`, query, ["fills"], fillId).then(
      (page) => ({ ...page, available: true }),
      (error: unknown) => {
        if (error instanceof KalshiApiError && error.type === "HTTP_ERROR" && error.status === 404) {
          return { values: [], truncated: false, available: false };
        }
        throw error;
      },
    ),
  ]);
  const orders = [...currentOrders.values, ...historicalOrders.values].map((value) => {
    const base = normalizeOrder(value);
    return {
      ...base,
      // Older or externally placed orders can have an empty client ID. They
      // cannot match our reservation but must not hide other history records.
      clientOrderId: value.client_order_id === ""
        ? null : optionalString(value, ["client_order_id"]),
      type: requiredString(value, ["type"]),
      initialCount: requiredDecimal(value, ["initial_count_fp", "initial_count"]),
      filledCount: requiredDecimal(value, ["fill_count_fp", "fill_count"]),
      remainingCount: requiredDecimal(value, ["remaining_count_fp", "remaining_count"]),
    };
  });
  const normalizedCurrentFills = currentFills.values.map((value) => ({
    ...normalizeFill(value),
    feeCostDollars: fixedPointFeeCost(value),
  }));
  const normalizedHistoricalFills = historicalFills.values.map((value) => ({
    ...normalizeFill(value),
    feeCostDollars: fixedPointFeeCost(value),
  }));
  const fills = mergeFillSnapshots(normalizedCurrentFills, normalizedHistoricalFills);
  return {
    orders,
    fills: fills.map((fill) => ({ ...fill, feeCostDollars: fill.feeCostDollars ?? null })),
    historicalFills: normalizedHistoricalFills,
    historicalFillsAvailable: historicalFills.available,
    truncated: currentOrders.truncated || historicalOrders.truncated ||
      currentFills.truncated || historicalFills.truncated,
  };
}

export async function readKalshiAccountActivity(): Promise<KalshiAccountActivity> {
  const subaccount = getConfiguredKalshiSubaccount();
  const scanStartedAt = new Date().toISOString();
  const query = `?limit=${PAGE_LIMIT}&subaccount=${subaccount}`;
  const archived = async (path: string, key: string, id: (value: JsonObject) => string) => {
    try {
      return {
        ...await listAllPages(path, query, [key], id, undefined, subaccount),
        available: true,
      };
    } catch (error) {
      if (error instanceof KalshiApiError && error.type === "HTTP_ERROR" && error.status === 404) {
        return { values: [] as JsonObject[], pageNumbers: [] as number[], truncated: false, available: false };
      }
      throw error;
    }
  };
  const [currentOrders, oldOrders, currentFills, oldFills, keyRestrictionVerified,
    tradePermissionVerified] = await Promise.all([
    listAllPages(`${API_PREFIX}/portfolio/orders`, query, ["orders"], orderId, undefined, subaccount),
    archived(`${API_PREFIX}/historical/orders`, "orders", orderId),
    listAllPages(`${API_PREFIX}/portfolio/fills`, query, ["fills"], fillId, undefined, subaccount),
    archived(`${API_PREFIX}/historical/fills`, "fills", fillId),
    subaccount === 0
      ? Promise.resolve(false)
      : verifyKalshiTradingKeyRestrictionForSubaccount(subaccount),
    verifyKalshiTradingKeyTradePermissionForSubaccount(subaccount),
  ]);
  const { orders, orderOverlapConflicts } = mergeAccountOrderHistory(currentOrders, oldOrders);
  const fills = mergeFillSnapshots(
    currentFills.values.map(normalizeFill),
    oldFills.values.map(normalizeFill),
  );
  return {
    orders, orderOverlapConflicts,
    fills: fills.map((fill) => ({ ...fill, feeCostDollars: fill.feeCostDollars ?? null })),
    selectedSubaccount: subaccount,
    scanStartedAt,
    scanFinishedAt: new Date().toISOString(),
    available: oldOrders.available && oldFills.available,
    truncated: orderOverlapConflicts.length > 0 || currentOrders.truncated || oldOrders.truncated ||
      currentFills.truncated || oldFills.truncated,
    keyRestrictionVerified,
    tradePermissionVerified,
    // A scoped key does not stop the owner, sub-users, or unrestricted keys
    // from trading here after our read. Keep the recovery execution gate shut.
    exclusiveControlVerified: false,
  };
}

/** Read historical fills for only the locally linked order tickers supplied. */
export async function readKalshiHistoricalFills(
  tickers: string[],
): Promise<KalshiHistoricalFillsSnapshot> {
  const subaccount = getConfiguredKalshiSubaccount();
  const uniqueTickers = [...new Set(tickers)].sort();
  if (uniqueTickers.some((ticker) => !/^KXBTC15M[A-Za-z0-9._-]*$/.test(ticker))) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const pages = await Promise.all(uniqueTickers.map(async (ticker) => {
    try {
      const result = await listAllPages(
        `${API_PREFIX}/historical/fills`,
        `?ticker=${encodeURIComponent(ticker)}&limit=${PAGE_LIMIT}&subaccount=${subaccount}`,
        ["fills"],
        fillId,
      );
      const fills = result.values.map(normalizeFill);
      if (fills.some((fill) => fill.ticker !== ticker)) {
        throw new KalshiApiError("INVALID_RESPONSE");
      }
      return { fills, truncated: result.truncated, available: true };
    } catch (error) {
      if (error instanceof KalshiApiError && error.type === "HTTP_ERROR" && error.status === 404) {
        return { fills: [], truncated: false, available: false };
      }
      throw error;
    }
  }));
  return {
    fills: pages.flatMap((page) => page.fills),
    truncated: pages.some((page) => page.truncated),
    available: pages.every((page) => page.available),
  };
}

export async function readKalshiAccount(): Promise<KalshiAccountSnapshot> {
  const subaccount = getConfiguredKalshiSubaccount();
  const [balanceRaw, orders, positions, fills] = await Promise.all([
    getJsonWithTimeout(`${API_PREFIX}/portfolio/balance`, `?subaccount=${subaccount}`, ACCOUNT_TIMEOUT_MS),
    listAllPages(`${API_PREFIX}/portfolio/orders`, `?status=resting&limit=${PAGE_LIMIT}&subaccount=${subaccount}`, ["orders"], orderId),
    listAllPages(
      `${API_PREFIX}/portfolio/positions`,
      `?limit=${PAGE_LIMIT}&subaccount=${subaccount}`,
      ["market_positions", "positions"],
      undefined,
      positionTicker,
    ),
    listAllPages(`${API_PREFIX}/portfolio/fills`, `?limit=${PAGE_LIMIT}&subaccount=${subaccount}`, ["fills"], fillId),
  ]);
  const balance = object(balanceRaw);
  assertMatchingSubaccount(balance);
  const availableCashDollars = dollarsOrCents(
    balance,
    ["balance_dollars", "available_balance_dollars"],
    ["balance", "available_balance"],
  );
  if (availableCashDollars === null) throw new KalshiApiError("INVALID_RESPONSE");
  return {
    balance: {
      availableCashDollars,
      portfolioValueDollars: dollarsOrCents(
        balance,
        ["portfolio_value_dollars"],
        ["portfolio_value"],
      ),
    },
    openOrders: orders.values.map(normalizeOrder),
    positions: positions.values.map(normalizePosition),
    fills: fills.values.map(normalizeFill),
    truncated: {
      openOrders: orders.truncated,
      positions: positions.truncated,
      fills: fills.truncated,
    },
  };
}

function evidenceInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

function evidenceSubaccount(value: JsonObject): number | null {
  return evidenceInteger(value.subaccount_number ?? value.subaccount);
}

function evidenceTimestamp(value: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    try {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        const millis = raw < 100_000_000_000 ? raw * 1000 : raw;
        return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
      }
      if (typeof raw === "string" && raw.trim()) {
        const millis = Date.parse(raw);
        return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
      }
    } catch {
      return null;
    }
    return null;
  }
  return null;
}

function decimalMicros(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new KalshiApiError("INVALID_RESPONSE");
  const absolute = BigInt(match[2]!) * 1_000_000n +
    BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] === "-" ? -absolute : absolute;
}

function exactContractAmountMicros(count: string, price: string): bigint {
  const countMicros = decimalMicros(count);
  const priceMicros = decimalMicros(price);
  if (countMicros <= 0n || priceMicros <= 0n || priceMicros > 1_000_000n) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const product = countMicros * priceMicros;
  if (product % 1_000_000n !== 0n) throw new KalshiApiError("INVALID_RESPONSE");
  return product / 1_000_000n;
}

function centsMicros(value: unknown): bigint {
  const cents = decimal(value);
  if (cents === null || !/^-?\d+$/.test(cents)) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  return BigInt(cents) * 10_000n;
}

function microString(value: bigint): string {
  return value.toString();
}

function evidenceDetails(value: JsonObject, keys: string[]): Record<string, string | null> {
  const details: Record<string, string | null> = {};
  for (const key of keys) {
    const raw = value[key];
    details[key] = raw === undefined || raw === null ? null : String(raw);
  }
  return details;
}

function classifyEvidence(
  subaccountNumber: number | null,
  exchangeIndex: number | null,
  expectedSubaccount: number,
  settlementFilterAttested = false,
  balanceFilterAttested = false,
): { classification: KalshiPairEvidenceClassification; attribution: KalshiPairEvidenceRecord["attribution"] } {
  if (subaccountNumber !== null && subaccountNumber !== expectedSubaccount) {
    return { classification: "elsewhere", attribution: "record_fields" };
  }
  if (exchangeIndex !== null && exchangeIndex !== 2) {
    return { classification: "elsewhere", attribution: "record_fields" };
  }
  if (subaccountNumber === expectedSubaccount && exchangeIndex === 2) {
    return { classification: "pair", attribution: "record_fields" };
  }
  if (settlementFilterAttested && exchangeIndex === 2 && subaccountNumber === null) {
    return { classification: "pair", attribution: "settlement_subaccount_filter" };
  }
  if (balanceFilterAttested) {
    return {
      classification: "pair",
      attribution: subaccountNumber === expectedSubaccount && exchangeIndex === 2
        ? "record_fields" : "balance_subaccount_exchange_filter",
    };
  }
  return { classification: "ambiguous", attribution: "unscoped" };
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function verifiedFundingSnapshotShape(
  snapshot: unknown,
  expectedCashMicros: "0" | "25000000",
): snapshot is {
  availableCashMicros: "0" | "25000000";
  capturedAt: string;
  evidenceDigest: string;
  authenticated: true;
  balanceSemantics: "available_cash";
} {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const value = snapshot as Record<string, unknown>;
  return value.availableCashMicros === expectedCashMicros &&
    typeof value.capturedAt === "string" && Number.isFinite(Date.parse(value.capturedAt)) &&
    typeof value.evidenceDigest === "string" &&
    /^[0-9a-f]{64}$/.test(value.evidenceDigest) &&
    value.authenticated === true &&
    value.balanceSemantics === "available_cash";
}

function evidenceRecord(
  feed: KalshiPairEvidenceRecord["feed"],
  value: JsonObject,
  expectedSubaccount: number,
  id: string,
  keys: string[],
  settlementFilterAttested = false,
  balanceFilterAttested = false,
): KalshiPairEvidenceRecord {
  const subaccountNumber = evidenceSubaccount(value);
  const exchangeIndex = normalizedExchangeIndex(value.exchange_index);
  const attribution = classifyEvidence(
    subaccountNumber,
    exchangeIndex,
    expectedSubaccount,
    settlementFilterAttested,
    balanceFilterAttested,
  );
  return {
    feed,
    id,
    classification: attribution.classification,
    attribution: attribution.attribution,
    subaccountNumber,
    exchangeIndex,
    occurredAt: evidenceTimestamp(value, [
      "created_ts", "created_time", "created_at", "settled_time", "updated_ts",
    ]),
    cashDeltaMicros: null,
    payloadDigest: digestOf(value),
    details: evidenceDetails(value, keys),
  };
}

function pairFillCashDelta(value: JsonObject): { cashDelta: bigint; feeDollars: string | null; feeMicros: bigint | null } {
  const action = requiredString(value, ["action"]).toLowerCase();
  const count = requiredDecimal(value, ["count_fp", "count"]);
  const price = sidePrice(value, requiredString(value, ["side"]));
  const feeDollars = fixedPointFeeCost(value);
  if (price === null) throw new KalshiApiError("INVALID_RESPONSE");
  const countMicros = decimalMicros(count);
  const priceMicros = decimalMicros(price);
  if (countMicros <= 0n || priceMicros < 0n || priceMicros > 1_000_000n) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const product = countMicros * priceMicros;
  if (product % 1_000_000n !== 0n) throw new KalshiApiError("INVALID_RESPONSE");
  const tradeMicros = product / 1_000_000n;
  const feeMicros = feeDollars === null ? null : decimalMicros(feeDollars);
  if (feeMicros !== null && feeMicros < 0n) throw new KalshiApiError("INVALID_RESPONSE");
  if (action !== "buy" && action !== "sell") throw new KalshiApiError("INVALID_RESPONSE");
  const signedTrade = action === "buy" ? -tradeMicros : tradeMicros;
  return {
    cashDelta: signedTrade - (feeMicros ?? 0n),
    feeDollars,
    feeMicros,
  };
}

function transferAmountMicros(value: JsonObject): bigint | null {
  try {
    if (value.amount_cents !== undefined && value.amount_cents !== null) {
      return centsMicros(value.amount_cents);
    }
    const amount = firstDecimal(value, ["amount_dollars", "amount"]);
    return amount === null ? null : decimalMicros(amount);
  } catch {
    return null;
  }
}

function classifySubaccountTransfer(
  record: KalshiPairEvidenceRecord,
  value: JsonObject,
  expectedSubaccount: number,
): void {
  const from = evidenceInteger(value.from_subaccount);
  const to = evidenceInteger(value.to_subaccount);
  const shard = normalizedExchangeIndex(value.exchange_index);
  const rowSubaccount = evidenceSubaccount(value);
  if (rowSubaccount !== null &&
      (rowSubaccount !== expectedSubaccount ||
        (from !== expectedSubaccount && to !== expectedSubaccount))) {
    record.subaccountNumber = rowSubaccount;
    record.classification = "ambiguous";
    record.attribution = "unscoped";
    record.exchangeIndex = shard;
    return;
  }
  record.subaccountNumber = from === expectedSubaccount || to === expectedSubaccount
    ? expectedSubaccount : null;
  record.exchangeIndex = shard;
  if (shard !== null && shard !== 2) {
    record.classification = "elsewhere";
    record.attribution = "record_fields";
  } else if (shard === 2 && (from === expectedSubaccount || to === expectedSubaccount)) {
    record.classification = "pair";
    record.attribution = "record_fields";
  } else if (shard === 2 && from !== null && to !== null) {
    record.classification = "elsewhere";
    record.attribution = "record_fields";
  } else {
    record.classification = "ambiguous";
    record.attribution = "unscoped";
  }
}

function classifyCrossExchangeTransfer(
  record: KalshiPairEvidenceRecord,
  value: JsonObject,
  expectedSubaccount: number,
): void {
  const sourceSubaccount = evidenceInteger(value.source_subaccount);
  const destinationSubaccount = evidenceInteger(value.destination_subaccount);
  const sourceShard = normalizedExchangeIndex(value.source_exchange_shard);
  const destinationShard = normalizedExchangeIndex(value.destination_exchange_shard);
  const rowSubaccount = evidenceSubaccount(value);
  record.sourceExchangeIndex = sourceShard;
  record.destinationExchangeIndex = destinationShard;
  const sourceIsPair = sourceSubaccount === expectedSubaccount && sourceShard === 2;
  const destinationIsPair = destinationSubaccount === expectedSubaccount && destinationShard === 2;
  if (rowSubaccount !== null &&
      (rowSubaccount !== expectedSubaccount ||
        (sourceSubaccount !== expectedSubaccount &&
          destinationSubaccount !== expectedSubaccount))) {
    record.subaccountNumber = rowSubaccount;
    record.classification = "ambiguous";
    record.attribution = "unscoped";
    return;
  }
  if (sourceIsPair || destinationIsPair) {
    record.classification = "pair";
    record.attribution = "record_fields";
    record.subaccountNumber = expectedSubaccount;
    record.exchangeIndex = 2;
  } else if (
    (sourceShard !== null && sourceShard !== 2) &&
    (destinationShard !== null && destinationShard !== 2)
  ) {
    record.classification = "elsewhere";
    record.attribution = "record_fields";
  } else if (
    sourceSubaccount !== null && destinationSubaccount !== null &&
    sourceShard !== null && destinationShard !== null
  ) {
    record.classification = "elsewhere";
    record.attribution = "record_fields";
  } else {
    record.classification = "ambiguous";
    record.attribution = "unscoped";
  }
}

type PairEvidenceFeed = {
  values: JsonObject[];
  complete: boolean;
  reason: string | null;
};

async function readPairEvidenceFeed(
  name: string,
  path: string,
  query: string,
  keys: string[],
  dedupeId?: (value: JsonObject) => string,
  requestPage: (path: string, query: string, timeoutMs: number) => Promise<unknown> = getJsonWithTimeout,
): Promise<PairEvidenceFeed> {
  try {
    const page = await listAllPages(path, query, keys, dedupeId, undefined, undefined, requestPage);
    return {
      values: page.values,
      complete: !page.truncated,
      reason: page.truncated ? `${name}_${page.truncationReason ?? "incomplete"}` : null,
    };
  } catch (error) {
    const suffix = error instanceof KalshiApiError
      ? `${error.type.toLowerCase()}${error.status === undefined ? "" : `_http_${error.status}`}`
      : "unknown_error";
    return { values: [], complete: false, reason: `${name}_${suffix}` };
  }
}

/**
 * Build canonical, read-only evidence for one explicit (subaccount, shard-2)
 * pair. Cursor pages are exhausted up to the hard safety caps; hitting any cap,
 * an unavailable feed, unscoped record or missing fee blocks the evidence.
 * The funding anchor is required before history can be called complete.
 */
export async function readKalshiDedicatedPairEvidence(
  subaccountNumber: number,
  ticker: string,
  fundingAnchor?: KalshiDedicatedPairFundingAnchor,
  source: "shared" | "index2" = "shared",
): Promise<KalshiDedicatedPairEvidence> {
  const exchangeIndex = 2 as const;
  if (!Number.isSafeInteger(subaccountNumber) ||
      subaccountNumber < 1 || subaccountNumber > 63 ||
      (source === "shared" ? subaccountNumber !== getConfiguredKalshiSubaccount() :
        subaccountNumber !== 1) ||
      !/^KXBTC15M[A-Za-z0-9._-]*$/.test(ticker)) {
    throw new KalshiApiError("INVALID_CREDENTIALS");
  }
  const scanStartedAt = new Date().toISOString();
  const reasons: string[] = [];
  const ownerCredentials = verifierCredentials();
  const pairCredentials = source === "index2"
    ? (() => {
        const keyId = process.env.KALSHI_INDEX2_API_KEY_ID?.trim();
        const privateKey = process.env.KALSHI_INDEX2_PRIVATE_KEY?.trim();
        if (!keyId || !privateKey) throw new KalshiApiError("NOT_CONFIGURED");
        return {
          keyId,
          privateKey: privateKey.replaceAll("\\n", "\n")
            .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
            .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1"),
        };
      })()
    : undefined;
  const pairPage = (path: string, query: string, timeoutMs: number) =>
    getJsonWithTimeout(path, query, timeoutMs, pairCredentials);
  const ownerPage = (
    path: string,
    query: string,
    timeoutMs: number,
  ) => getJsonWithCredentialsTimeout(path, query, timeoutMs, ownerCredentials);
  const subaccountQuery = `?limit=${PAGE_LIMIT}&subaccount=${subaccountNumber}`;

  const feedJobs = {
    positions: readPairEvidenceFeed(
      "positions", `${API_PREFIX}/portfolio/positions`,
      `${subaccountQuery}&exchange_index=${exchangeIndex}`,
      ["market_positions", "positions"], undefined, pairPage,
    ),
    currentOrders: readPairEvidenceFeed(
      "current_orders", `${API_PREFIX}/portfolio/orders`,
      `${subaccountQuery}&exchange_index=${exchangeIndex}`, ["orders"], orderId, pairPage,
    ),
    historicalOrders: readPairEvidenceFeed(
      "historical_orders", `${API_PREFIX}/historical/orders`,
      subaccountQuery, ["orders"], orderId, pairPage,
    ),
    currentFills: readPairEvidenceFeed(
      "current_fills", `${API_PREFIX}/portfolio/fills`,
      `${subaccountQuery}&exchange_index=${exchangeIndex}`, ["fills"], fillId, pairPage,
    ),
    historicalFills: readPairEvidenceFeed(
      "historical_fills", `${API_PREFIX}/historical/fills`,
      subaccountQuery, ["fills"], fillId, pairPage,
    ),
    settlements: readPairEvidenceFeed(
      "settlements", `${API_PREFIX}/portfolio/settlements`,
      subaccountQuery, ["settlements"], settlementTicker, pairPage,
    ),
    transfers: readPairEvidenceFeed(
      "subaccount_transfers", `${API_PREFIX}/portfolio/subaccounts/transfers`,
      `?limit=${PAGE_LIMIT}`, ["transfers"],
      (value) => requiredString(value, ["transfer_id"]), ownerPage,
    ),
    crossTransfers: readPairEvidenceFeed(
      "cross_exchange_transfers",
      `${API_PREFIX}/portfolio/intra_exchange_instance_transfers`,
      `?limit=${PAGE_LIMIT}`, ["transfers"],
      (value) => requiredString(value, ["transfer_id"]), ownerPage,
    ),
  };
  const [
    rawBalancesResult,
    scopedBalanceResult,
    feeds,
    marketResult,
    keyRestrictionVerified,
    tradePermissionVerified,
  ] = await Promise.all([
    getJsonWithCredentialsTimeout(
      `${API_PREFIX}/portfolio/subaccounts/balances`, "", ACCOUNT_TIMEOUT_MS, ownerCredentials,
    ).then((payload) => ({ payload, error: null as string | null }), (error: unknown) => ({
      payload: null,
      error: error instanceof KalshiApiError
        ? `balances_${error.type.toLowerCase()}${error.status === undefined ? "" : `_http_${error.status}`}`
        : "balances_unknown_error",
    })),
    getJsonWithTimeout(
      `${API_PREFIX}/portfolio/balance`,
      `?subaccount=${subaccountNumber}&exchange_index=${exchangeIndex}`,
      ACCOUNT_TIMEOUT_MS,
      pairCredentials,
    ).then((payload) => ({ payload, error: null as string | null }), (error: unknown) => ({
      payload: null,
      error: error instanceof KalshiApiError
        ? `scoped_balance_${error.type.toLowerCase()}${error.status === undefined ? "" : `_http_${error.status}`}`
        : "scoped_balance_unknown_error",
    })),
    Promise.all(Object.entries(feedJobs).map(async ([name, job]) => [name, await job] as const)),
    getJsonWithTimeout(
      `${API_PREFIX}/markets/${encodeURIComponent(ticker)}`, "", ACCOUNT_TIMEOUT_MS, pairCredentials,
    )
      .then((payload) => ({ payload, error: null as string | null }), (error: unknown) => ({
        payload: null,
        error: error instanceof KalshiApiError ? `market_${error.type.toLowerCase()}` : "market_unknown_error",
      })),
     verifyKalshiTradingKeyRestrictionForSubaccount(subaccountNumber, source),
     verifyKalshiTradingKeyTradePermissionForSubaccount(subaccountNumber, source),
  ]);
  const feedMap = Object.fromEntries(feeds) as Record<string, PairEvidenceFeed>;
  if (rawBalancesResult.error) reasons.push(rawBalancesResult.error);
  else if (rawBalancesResult.payload === null) reasons.push("balances_response_empty");
  if (scopedBalanceResult.error) reasons.push(scopedBalanceResult.error);
  else if (scopedBalanceResult.payload === null) reasons.push("scoped_balance_response_empty");
  if (marketResult.error) reasons.push(marketResult.error);
  else if (marketResult.payload === null) reasons.push("market_response_empty");
  for (const [name, feed] of Object.entries(feedMap)) {
    if (!feed.complete && feed.reason) reasons.push(feed.reason);
  }
  if (!keyRestrictionVerified) reasons.push("key_subaccount_restriction_unverified");
  if (!tradePermissionVerified) reasons.push("key_trade_permission_unverified");

  let balanceRow: JsonObject | null = null;
  let balanceDollars: string | null = null;
  let availableCashDollars: string | null = null;
  let currentBalanceMicros: bigint | null = null;
  let inventoryBalanceMicros: string | null = null;
  let updatedTs: number | null = null;
  const records: KalshiPairEvidenceRecord[] = [];
  if (rawBalancesResult.payload !== null) {
    try {
      const payload = object(rawBalancesResult.payload);
      if (!Array.isArray(payload.subaccount_balances)) {
        throw new KalshiApiError("INVALID_RESPONSE");
      }
      const rows = payload.subaccount_balances.map(object);
      for (const row of rows) {
        const rowRecord = evidenceRecord(
          "balance", row, subaccountNumber,
          `${evidenceSubaccount(row) ?? "?"}:${normalizedExchangeIndex(row.exchange_index) ?? "?"}`,
          ["subaccount_number", "exchange_index", "balance", "updated_ts"],
        );
        records.push(rowRecord);
        if (rowRecord.classification === "ambiguous") {
          reasons.push(`ambiguous_record:balance:${rowRecord.id}`);
        }
      }
      const matches = rows.filter((row) =>
        evidenceSubaccount(row) === subaccountNumber &&
        normalizedExchangeIndex(row.exchange_index) === exchangeIndex);
      if (matches.length !== 1) {
        reasons.push("pair_balance_missing_or_duplicated");
      } else {
        balanceRow = matches[0]!;
        balanceDollars = requiredDecimal(balanceRow, ["balance"]);
        inventoryBalanceMicros = decimalMicros(balanceDollars).toString();
        const inventoryUpdatedTs = evidenceInteger(balanceRow.updated_ts);
        if (inventoryUpdatedTs === null || inventoryUpdatedTs === 0) {
          reasons.push("subaccount_inventory_balance_timestamp_missing");
        } else {
          const inventoryUpdatedAt = inventoryUpdatedTs < 100_000_000_000
            ? inventoryUpdatedTs * 1000 : inventoryUpdatedTs;
          if (inventoryUpdatedAt > Date.now() + 5_000 ||
              Date.now() - inventoryUpdatedAt > 60_000) {
            reasons.push("subaccount_inventory_balance_stale");
          }
        }
      }
    } catch {
      reasons.push("balances_invalid_response");
    }
  }
  if (scopedBalanceResult.payload !== null) {
    try {
      const scopedRoot = object(scopedBalanceResult.payload);
      const scopedRow = scopedRoot.balance && typeof scopedRoot.balance === "object" &&
          !Array.isArray(scopedRoot.balance)
        ? object(scopedRoot.balance)
        : scopedRoot;
      const scopedRecord = evidenceRecord(
        "scoped_balance",
        scopedRow,
        subaccountNumber,
        `query:${subaccountNumber}:${exchangeIndex}`,
        [
          "subaccount_number", "subaccount", "exchange_index", "balance_dollars",
          "updated_ts", "balance_breakdown", "portfolio_value",
        ],
        false,
        true,
      );
      records.push(scopedRecord);
      if (scopedRecord.classification !== "pair") {
        reasons.push("scoped_balance_identity_mismatch");
      }
      availableCashDollars = firstDecimal(scopedRow, ["balance_dollars"]);
      if (availableCashDollars === null) {
        reasons.push("scoped_available_cash_field_missing");
      } else {
        currentBalanceMicros = decimalMicros(availableCashDollars);
      }
      updatedTs = evidenceInteger(scopedRow.updated_ts);
      if (updatedTs === null || updatedTs === 0) {
        updatedTs = null;
        reasons.push("scoped_balance_timestamp_missing");
      } else {
        const balanceUpdatedAt = updatedTs < 100_000_000_000
          ? updatedTs * 1000 : updatedTs;
        // updated_ts marks the last cash change, not this authenticated GET.
        // An unchanged funded balance remains valid after a delayed restart.
        if (balanceUpdatedAt > Date.now() + 5_000) {
          reasons.push("scoped_balance_stale");
        }
      }
    } catch {
      reasons.push("scoped_balance_invalid_response");
    }
  }

  let marketExchangeIndex: 2 | null = null;
  if (marketResult.payload !== null) {
    try {
      const marketRoot = object(marketResult.payload);
      const market = object(marketRoot.market ?? marketRoot);
      if (normalizedExchangeIndex(market.exchange_index) === exchangeIndex) {
        marketExchangeIndex = exchangeIndex;
      } else {
        reasons.push("market_exchange_index_mismatch");
      }
    } catch {
      reasons.push("market_invalid_response");
    }
  }

  const addFeedRecords = (
    feed: KalshiPairEvidenceRecord["feed"],
    key: string,
    idOf: (value: JsonObject) => string,
    fields: string[],
    settlementFilterAttested = false,
  ): Array<{ record: KalshiPairEvidenceRecord; value: JsonObject }> => {
    const page = feedMap[key]!;
    const result = page.values.map((value) => {
      const id = idOf(value);
      const record = evidenceRecord(
        feed, value, subaccountNumber, id, fields, settlementFilterAttested,
      );
      records.push(record);
      return { record, value };
    });
    return result;
  };

  const positionRecords = addFeedRecords(
    "position", "positions", positionTicker,
    ["ticker", "position_fp", "position", "market_exposure_dollars", "market_exposure",
      "realized_pnl_dollars", "realized_pnl", "subaccount_number", "exchange_index"],
  );
  const currentOrderRecords = addFeedRecords(
    "current_order", "currentOrders", orderId,
    ["ticker", "side", "action", "type", "status", "initial_count_fp", "initial_count",
      "fill_count_fp", "fill_count", "remaining_count_fp", "remaining_count",
      "yes_price_dollars", "no_price_dollars", "price_dollars", "yes_price", "no_price",
      "price", "client_order_id", "reduce_only", "outcome_side", "book_side",
      "subaccount_number", "exchange_index", "created_time"],
  );
  const historicalOrderRecords = addFeedRecords(
    "historical_order", "historicalOrders", orderId,
    ["ticker", "side", "action", "type", "status", "initial_count_fp", "initial_count",
      "fill_count_fp", "fill_count", "remaining_count_fp", "remaining_count",
      "yes_price_dollars", "no_price_dollars", "price_dollars", "yes_price", "no_price",
      "price", "client_order_id", "reduce_only", "outcome_side", "book_side",
      "subaccount_number", "exchange_index", "created_time"],
  );
  const currentFillRecords = addFeedRecords(
    "current_fill", "currentFills", fillId,
    ["ticker", "order_id", "side", "action", "count_fp", "count",
      "yes_price_dollars", "no_price_dollars", "price_dollars", "yes_price", "no_price",
      "price", "fee_cost", "outcome_side", "book_side", "subaccount_number",
      "exchange_index", "created_time"],
  );
  const historicalFillRecords = addFeedRecords(
    "historical_fill", "historicalFills", fillId,
    ["ticker", "order_id", "side", "action", "count_fp", "count",
      "yes_price_dollars", "no_price_dollars", "price_dollars", "yes_price", "no_price",
      "price", "fee_cost", "outcome_side", "book_side", "subaccount_number",
      "exchange_index", "created_time"],
  );
  const settlementRecords = addFeedRecords(
    "settlement", "settlements", settlementTicker,
    ["ticker", "event_ticker", "market_result", "yes_count_fp", "no_count_fp",
      "revenue", "fee_cost", "settled_time", "subaccount_number", "exchange_index"],
    true,
  );
  const subaccountTransferRecords = addFeedRecords(
    "subaccount_transfer", "transfers",
    (value) => requiredString(value, ["transfer_id"]),
    ["from_subaccount", "to_subaccount", "exchange_index", "amount_cents", "created_ts",
      "status"],
  );
  const crossTransferRecords = addFeedRecords(
    "cross_exchange_transfer", "crossTransfers",
    (value) => requiredString(value, ["transfer_id"]),
    ["source_subaccount", "destination_subaccount", "source_exchange_shard",
      "destination_exchange_shard", "amount", "amount_dollars", "amount_cents", "status",
      "created_ts"],
  );
  for (const { record, value } of subaccountTransferRecords) {
    classifySubaccountTransfer(record, value, subaccountNumber);
  }
  for (const { record, value } of crossTransferRecords) {
    classifyCrossExchangeTransfer(record, value, subaccountNumber);
  }

  const baselineMs = fundingAnchor ? Date.parse(fundingAnchor.baselineAt) : NaN;
  const anchorMs = fundingAnchor ? Date.parse(fundingAnchor.transferredAt) : NaN;
  let validAnchor = Boolean(fundingAnchor);
  if (!fundingAnchor) {
    reasons.push("funding_anchor_missing");
    validAnchor = false;
  } else if (
    fundingAnchor.amountCents !== 2500 ||
    fundingAnchor.baselineCashMicros !== "25000000" ||
    !fundingAnchor.transferId.trim() ||
    !Number.isFinite(anchorMs) ||
    !Number.isFinite(baselineMs) ||
    baselineMs < anchorMs
  ) {
    reasons.push("funding_anchor_invalid");
    validAnchor = false;
  }
  const preFundingSnapshot = fundingAnchor?.preFundingZeroSnapshot;
  const preFundingAt = preFundingSnapshot && Number.isFinite(Date.parse(preFundingSnapshot.capturedAt))
    ? Date.parse(preFundingSnapshot.capturedAt) : NaN;
  const preFundingSnapshotShapeVerified = verifiedFundingSnapshotShape(
    preFundingSnapshot, "0",
  ) &&
    Number.isFinite(anchorMs) && preFundingAt <= anchorMs &&
    anchorMs - preFundingAt <= 60_000;
  if (!preFundingSnapshotShapeVerified) {
    reasons.push("pre_funding_zero_snapshot_unverified");
    validAnchor = false;
  }
  // This client has no trusted server-side producer or persisted provenance
  // for a pre-funding read. Caller flags and digests are not authentication.
  const preFundingProvenanceVerified = false;
  if (!preFundingProvenanceVerified) {
    validAnchor = false;
  }
  const cleanBoundaryMs = preFundingSnapshotShapeVerified ? preFundingAt : anchorMs;
  const isAfterCleanBoundary = (record: KalshiPairEvidenceRecord): boolean =>
    Boolean(record.occurredAt && Number.isFinite(cleanBoundaryMs) &&
      Date.parse(record.occurredAt) >= cleanBoundaryMs);
  const postFundingSnapshot = fundingAnchor?.postFundingSnapshot;
  const postFundingAt = postFundingSnapshot &&
      Number.isFinite(Date.parse(postFundingSnapshot.capturedAt))
    ? Date.parse(postFundingSnapshot.capturedAt) : NaN;
  const postFundingVerified = verifiedFundingSnapshotShape(
    postFundingSnapshot, "25000000",
  ) && Number.isFinite(anchorMs) && postFundingAt >= anchorMs &&
    postFundingAt - anchorMs <= 60_000 && postFundingAt === baselineMs &&
    fundingAnchor?.baselineCashMicros === postFundingSnapshot.availableCashMicros;
  if (!postFundingVerified) {
    reasons.push("post_funding_25_snapshot_unverified");
    validAnchor = false;
  }

  const eventRecords = records.filter((record) =>
    record.feed !== "balance" && record.feed !== "position");
  for (const record of eventRecords) {
    if (record.occurredAt === null) {
      reasons.push(`missing_timestamp:${record.feed}:${record.id}`);
    }
  }
  for (const record of records) {
    if (record.feed === "balance" && record.classification === "ambiguous") {
      reasons.push(`ambiguous_record:balance:${record.id}`);
    }
    if (record.feed === "position" && record.classification === "ambiguous") {
      reasons.push(`ambiguous_record:position:${record.id}`);
    }
  }

  const preBaselinePairActivity = new Set<KalshiPairEvidenceRecord["feed"]>([
    "current_order", "historical_order", "current_fill", "historical_fill",
    "settlement", "subaccount_transfer", "cross_exchange_transfer",
  ]);
  for (const record of records) {
    if (record.classification !== "pair" || !record.occurredAt ||
        !Number.isFinite(baselineMs) || Date.parse(record.occurredAt) >= baselineMs ||
        !preBaselinePairActivity.has(record.feed) ||
        (record.feed === "subaccount_transfer" && record.id === fundingAnchor?.transferId)) {
      continue;
    }
    if (record.feed === "subaccount_transfer") {
      reasons.push(`pre_baseline_pair_transfer:${record.id}`);
    } else {
      reasons.push(`pre_baseline_pair_activity:${record.feed}:${record.id}`);
    }
  }

  for (const { record, value } of positionRecords) {
    if (record.classification !== "pair") continue;
    const position = firstDecimal(value, ["position_fp", "position"]);
    if (position === null) {
      reasons.push(`invalid_pair_position_snapshot:${record.id}`);
    }
  }

  for (const record of eventRecords) {
    if (record.classification !== "ambiguous" || record.occurredAt === null) continue;
    if (isAfterCleanBoundary(record)) {
      if (record.feed === "cross_exchange_transfer") continue;
      reasons.push(`ambiguous_record:${record.feed}:${record.id}`);
    }
  }
  const activeOrderStatuses = new Set([
    "resting", "pending", "open", "partially_filled", "partial",
  ]);
  const closedOrderStatuses = new Set([
    "executed", "filled", "canceled", "cancelled", "rejected", "expired", "closed",
  ]);
  let restingEntryReserveMicros = 0n;
  const restingExitContractsByTicker: Record<string, string> = {};
  const orderRowsById = new Map<string, KalshiPairEvidenceRecord>();
  const orderRowConflicts = new Set<string>();
  const normalizedOrderTerms = (record: KalshiPairEvidenceRecord) => [
    record.details.ticker,
    record.details.side,
    record.details.action?.toLowerCase(),
    record.details.type?.toLowerCase(),
    record.details.status?.toLowerCase(),
    record.details.initial_count_fp ?? record.details.initial_count,
    record.details.fill_count_fp ?? record.details.fill_count,
    record.details.remaining_count_fp ?? record.details.remaining_count,
    record.details.yes_price_dollars ?? record.details.yes_price,
    record.details.no_price_dollars ?? record.details.no_price,
    record.details.price_dollars ?? record.details.price,
    record.details.client_order_id,
    record.details.reduce_only?.toLowerCase(),
  ].join("\u001f");
  const uniqueOrderRows: KalshiPairEvidenceRecord[] = [];
  const currentOrderIds = new Set(currentOrderRecords.map(({ record }) => record.id));
  for (const { record } of [...currentOrderRecords, ...historicalOrderRecords]) {
    const prior = orderRowsById.get(record.id);
    if (prior) {
      if (normalizedOrderTerms(prior) !== normalizedOrderTerms(record)) {
        orderRowConflicts.add(record.id);
      }
      continue;
    }
    orderRowsById.set(record.id, record);
    uniqueOrderRows.push(record);
  }
  for (const id of orderRowConflicts) reasons.push(`pair_order_snapshot_conflict:${id}`);
  for (const record of uniqueOrderRows) {
    const status = record.details.status?.toLowerCase() ?? null;
    const countText = (fp: string | null, whole: string | null) => fp ?? whole;
    const initialText = countText(
      record.details.initial_count_fp, record.details.initial_count,
    );
    const filledText = countText(
      record.details.fill_count_fp, record.details.fill_count,
    );
    const remainingText = countText(
      record.details.remaining_count_fp, record.details.remaining_count,
    );
    const isActive = status !== null && activeOrderStatuses.has(status);
    let initialMicros: bigint | null = null;
    let filledMicros: bigint | null = null;
    let remainingMicros: bigint | null = null;
    let countsValid = true;
    const missingCountFields = [
      ...(initialText === null ? ["initial_count_fp|initial_count"] : []),
      ...(filledText === null ? ["fill_count_fp|fill_count"] : []),
      ...(remainingText === null ? ["remaining_count_fp|remaining_count"] : []),
    ];
    if (missingCountFields.length) {
      countsValid = false;
    } else {
      try {
        initialMicros = decimalMicros(initialText!);
        filledMicros = decimalMicros(filledText!);
        remainingMicros = decimalMicros(remainingText!);
        countsValid = !(initialMicros <= 0n || filledMicros < 0n ||
          remainingMicros < 0n || filledMicros > initialMicros ||
          remainingMicros > initialMicros ||
          (isActive && filledMicros + remainingMicros !== initialMicros) ||
          (!isActive && remainingMicros !== 0n) ||
          (status === "executed" || status === "filled") &&
            filledMicros !== initialMicros);
      } catch {
        countsValid = false;
      }
    }
    const hasRemaining = remainingMicros !== null && remainingMicros > 0n;
    if (record.classification === "pair") {
      if (missingCountFields.length) {
        reasons.push(
          `pair_order_count_fields_missing:${record.id}:${missingCountFields.join(",")}`,
        );
      } else if (!countsValid) {
        reasons.push(`pair_order_count_state_invalid:${record.id}`);
      }
      if (status === null || (!isActive && !closedOrderStatuses.has(status))) {
        reasons.push(`pair_order_status_unverified:${record.id}`);
      }
      const action = record.details.action?.toLowerCase();
      const side = record.details.side?.toLowerCase();
      const orderType = record.details.type?.toLowerCase();
      const reduceOnly = record.details.reduce_only?.toLowerCase();
      if (!["buy", "sell"].includes(action ?? "") ||
          !["yes", "no"].includes(side ?? "") || orderType !== "limit") {
        reasons.push(`pair_order_terms_unverified:${record.id}`);
      }
      if (isActive && reduceOnly !== "true" && reduceOnly !== "false") {
        reasons.push(`pair_order_reduce_only_unverified:${record.id}`);
      }
      if (isActive && !currentOrderIds.has(record.id)) {
        reasons.push(`pair_active_order_missing_from_current_snapshot:${record.id}`);
      }
      if (action === "sell" && (!isActive || reduceOnly !== "true")) {
        if (isActive || reduceOnly === "true") {
          reasons.push(`pair_exit_reduce_only_unverified:${record.id}`);
        }
      }
      if (action === "buy" && reduceOnly === "true") {
        reasons.push(`pair_entry_unexpected_reduce_only:${record.id}`);
      }
      if (isActive && hasRemaining && action === "buy" &&
          remainingMicros !== null) {
        try {
          const price = firstDecimal(record.details as unknown as JsonObject, [
            side === "yes" ? "yes_price_dollars" : "no_price_dollars",
            side === "yes" ? "yes_price" : "no_price",
            "price_dollars", "price",
          ]);
          if (price === null) throw new Error("missing_price");
          restingEntryReserveMicros += exactContractAmountMicros(
            remainingText!, price,
          );
        } catch {
          reasons.push(`pair_entry_collateral_unverified:${record.id}`);
        }
      }
      if (isActive && hasRemaining && action === "sell" && remainingText !== null) {
        const ticker = record.details.ticker;
        if (!ticker) {
          reasons.push(`pair_exit_ticker_unverified:${record.id}`);
        } else {
          try {
            const key = `${ticker}:${side}`;
            const prior = BigInt(restingExitContractsByTicker[key] ?? "0");
            restingExitContractsByTicker[key] =
              (prior + decimalMicros(remainingText)).toString();
          } catch {
            reasons.push(`pair_exit_remaining_quantity_unverified:${record.id}`);
          }
        }
      }
    } else if (record.classification === "ambiguous" &&
        (record.feed === "current_order" || isActive || hasRemaining)) {
      reasons.push(`ambiguous_order_hold:${record.id}`);
    }
  }
  const unresolvedOrderHold = reasons.some((reason) =>
    reason.startsWith("pair_order_count_fields_missing:") ||
    reason.startsWith("pair_order_count_state_invalid:") ||
    reason.startsWith("pair_order_snapshot_conflict:") ||
    reason.startsWith("pair_order_terms_unverified:") ||
    reason.startsWith("pair_order_reduce_only_unverified:") ||
    reason.startsWith("pair_active_order_missing_from_current_snapshot:") ||
    reason.startsWith("pair_exit_reduce_only_unverified:") ||
    reason.startsWith("pair_entry_unexpected_reduce_only:") ||
    reason.startsWith("pair_entry_collateral_unverified:") ||
    reason.startsWith("pair_exit_ticker_unverified:") ||
    reason.startsWith("pair_exit_remaining_quantity_unverified:") ||
    reason.startsWith("pair_order_status_unverified:") ||
    reason.startsWith("ambiguous_order_hold:") ||
    reason.startsWith("invalid_order_remaining_quantity:"));
  if (balanceDollars !== null && availableCashDollars !== null &&
      !unresolvedOrderHold) {
    try {
      if (decimalMicros(balanceDollars) !==
          decimalMicros(availableCashDollars) + restingEntryReserveMicros) {
        reasons.push("pair_inventory_available_and_resting_entry_mismatch");
      }
    } catch {
      reasons.push("pair_inventory_available_and_resting_entry_uncomparable");
    }
  }

  const feeEvidence: KalshiDedicatedPairEvidence["feeEvidence"] = [];
  let cashDelta = 0n;
  const cashFillsSeen = new Map<string, string>();
  const baselineMicros = 25_000_000n;
  const isAfterBaseline = (record: KalshiPairEvidenceRecord): boolean => {
    if (!record.occurredAt || !Number.isFinite(baselineMs)) return false;
    return Date.parse(record.occurredAt) >= baselineMs;
  };
  for (const item of [...currentFillRecords, ...historicalFillRecords]) {
    const { record, value } = item;
    if (record.classification !== "pair" || !isAfterBaseline(record)) continue;
    if (!record.occurredAt) {
      reasons.push(`missing_timestamp:${record.feed}:${record.id}`);
      continue;
    }
    try {
      const amount = pairFillCashDelta(value);
      record.feeCostDollars = amount.feeDollars;
      record.feeMicros = amount.feeMicros === null ? null : microString(amount.feeMicros);
      feeEvidence.push({
        source: "fill",
        id: record.id,
        ticker: requiredString(value, ["ticker", "market_ticker"]),
        feeCostDollars: amount.feeDollars,
        feeMicros: record.feeMicros,
        classification: record.classification,
      });
      if (amount.feeMicros === null) {
        reasons.push(`missing_fee:fill:${record.id}`);
        continue;
      }
      const fingerprint =
        `${record.payloadDigest}:${amount.cashDelta.toString()}:${amount.feeMicros.toString()}`;
      const previous = cashFillsSeen.get(record.id);
      if (previous !== undefined) {
        if (previous !== fingerprint) reasons.push(`fill_overlap_conflict:${record.id}`);
        record.cashDeltaMicros = null;
        continue;
      }
      cashFillsSeen.set(record.id, fingerprint);
      record.cashDeltaMicros = microString(amount.cashDelta);
      cashDelta += amount.cashDelta;
    } catch {
      reasons.push(`invalid_fill_cash_evidence:${record.id}`);
    }
  }

  const fillFeesByTicker = new Map<string, {
    totalMicros: bigint;
    missingFeeIds: string[];
    conflictingIds: string[];
  }>();
  const feeFillIds = new Map<string, { digest: string; ticker: string; feeMicros: bigint | null }>();
  const ambiguousFillsByTicker = new Map<string, string[]>();
  for (const { record, value } of [...currentFillRecords, ...historicalFillRecords]) {
    const ticker = optionalString(value, ["ticker", "market_ticker"]);
    if (!ticker) continue;
    if (record.classification === "ambiguous") {
      const ids = ambiguousFillsByTicker.get(ticker) ?? [];
      ids.push(record.id);
      ambiguousFillsByTicker.set(ticker, ids);
      continue;
    }
    if (record.classification !== "pair") continue;
    let feeMicros: bigint | null;
    try {
      const feeDollars = fixedPointFeeCost(value);
      feeMicros = feeDollars === null ? null : decimalMicros(feeDollars);
      if (feeMicros !== null && feeMicros < 0n) {
        reasons.push(`invalid_fill_fee:${record.id}`);
        feeMicros = null;
      }
    } catch {
      feeMicros = null;
    }
    const previous = feeFillIds.get(record.id);
    if (previous) {
      if (previous.digest !== record.payloadDigest || previous.ticker !== ticker ||
          previous.feeMicros !== feeMicros) {
        for (const conflictingTicker of new Set([previous.ticker, ticker])) {
          const summary = fillFeesByTicker.get(conflictingTicker) ?? {
            totalMicros: 0n, missingFeeIds: [], conflictingIds: [],
          };
          summary.conflictingIds.push(record.id);
          fillFeesByTicker.set(conflictingTicker, summary);
        }
      }
      continue;
    }
    feeFillIds.set(record.id, { digest: record.payloadDigest, ticker, feeMicros });
    const summary = fillFeesByTicker.get(ticker) ?? {
      totalMicros: 0n, missingFeeIds: [], conflictingIds: [],
    };
    if (feeMicros === null) summary.missingFeeIds.push(record.id);
    else summary.totalMicros += feeMicros;
    fillFeesByTicker.set(ticker, summary);
  }

  for (const { record, value } of settlementRecords) {
    if (record.classification !== "pair" || !isAfterBaseline(record)) continue;
    if (!record.occurredAt) {
      reasons.push(`missing_timestamp:settlement:${record.id}`);
      continue;
    }
    try {
      const feeDollars = fixedPointFeeCost(value);
      const revenue = value.revenue;
      if (typeof revenue !== "number" || !Number.isSafeInteger(revenue)) {
        throw new KalshiApiError("INVALID_RESPONSE");
      }
      const feeMicros = feeDollars === null ? null : decimalMicros(feeDollars);
      record.feeCostDollars = feeDollars;
      record.feeMicros = feeMicros === null ? null : microString(feeMicros);
      feeEvidence.push({
        source: "settlement",
        id: record.id,
        ticker: requiredString(value, ["ticker"]),
        feeCostDollars: feeDollars,
        feeMicros: record.feeMicros,
        classification: record.classification,
      });
      if (feeMicros === null) {
        reasons.push(`missing_fee:settlement:${record.id}`);
        continue;
      }
      const ticker = requiredString(value, ["ticker"]);
      const feeSummary = fillFeesByTicker.get(ticker) ?? {
        totalMicros: 0n, missingFeeIds: [], conflictingIds: [],
      };
      const ambiguousFillIds = ambiguousFillsByTicker.get(ticker) ?? [];
      if (!feedMap.currentFills!.complete || !feedMap.historicalFills!.complete) {
        reasons.push(`settlement_fee_aggregate_unverifiable:${ticker}:fill_history_incomplete`);
      } else if (ambiguousFillIds.length > 0) {
        reasons.push(
          `settlement_fee_aggregate_unverifiable:${ticker}:ambiguous_fill:${ambiguousFillIds[0]}`,
        );
      } else if (feeSummary.missingFeeIds.length > 0) {
        reasons.push(
          `settlement_fee_aggregate_unverifiable:${ticker}:missing_fill_fee:${feeSummary.missingFeeIds[0]}`,
        );
      } else if (feeSummary.conflictingIds.length > 0) {
        reasons.push(
          `settlement_fee_aggregate_unverifiable:${ticker}:fill_overlap_conflict:${feeSummary.conflictingIds[0]}`,
        );
      } else if (feeSummary.totalMicros !== feeMicros) {
        reasons.push(`settlement_fee_aggregate_mismatch:${ticker}`);
      }
      // Settlement revenue is the cash payout. Its fee_cost is aggregate
      // evidence of fill fees already debited, so do not deduct it a second time.
      const amount = BigInt(revenue) * 10_000n;
      record.cashDeltaMicros = microString(amount);
      cashDelta += amount;
    } catch {
      reasons.push(`invalid_settlement_cash_evidence:${record.id}`);
    }
  }

  let matchingAnchorTransfers = 0;
  for (const { record, value } of subaccountTransferRecords) {
    const from = evidenceInteger(value.from_subaccount);
    const to = evidenceInteger(value.to_subaccount);
    const shard = normalizedExchangeIndex(value.exchange_index);
    const amount = transferAmountMicros(value);
    const status = optionalString(value, ["status"])?.toLowerCase();
    if (record.id === fundingAnchor?.transferId) {
      const transferTime = record.occurredAt ? Date.parse(record.occurredAt) : NaN;
      if (from === 0 && to === subaccountNumber && shard === exchangeIndex &&
          amount === 25_000_000n && Number.isFinite(transferTime) &&
          Math.floor(transferTime / 1000) === Math.floor(anchorMs / 1000) &&
          (status === undefined || status === "complete" || status === "completed" ||
            status === "succeeded")) {
        matchingAnchorTransfers += 1;
      } else {
        reasons.push("funding_anchor_transfer_mismatch");
      }
    }
    if (record.classification !== "pair" || record.id === fundingAnchor?.transferId ||
        !isAfterBaseline(record)) continue;
    if (status !== "complete" && status !== "completed" && status !== "succeeded") {
      reasons.push(`subaccount_transfer_effect_unverified:${record.id}`);
      continue;
    }
    if (from === null || to === null || shard === null || amount === null) {
      reasons.push(`ambiguous_transfer_cash:${record.id}`);
      continue;
    }
    const delta = to === subaccountNumber ? amount : from === subaccountNumber ? -amount : 0n;
    record.cashDeltaMicros = microString(delta);
    cashDelta += delta;
  }
  if (fundingAnchor && matchingAnchorTransfers !== 1) {
    reasons.push(matchingAnchorTransfers === 0
      ? "funding_anchor_transfer_not_found"
      : "funding_anchor_transfer_duplicated");
  }
  for (const { record, value } of crossTransferRecords) {
    const sourceAccount = evidenceInteger(value.source_subaccount);
    const destinationAccount = evidenceInteger(value.destination_subaccount);
    const sourceShard = normalizedExchangeIndex(value.source_exchange_shard);
    const destinationShard = normalizedExchangeIndex(value.destination_exchange_shard);
    const involvesPair = (sourceAccount === subaccountNumber && sourceShard === exchangeIndex) ||
      (destinationAccount === subaccountNumber && destinationShard === exchangeIndex);
    if (record.classification === "ambiguous") {
      if (record.occurredAt === null) {
        reasons.push(`cross_exchange_transfer_timestamp_missing:${record.id}`);
      } else if (isAfterCleanBoundary(record)) {
        reasons.push(`cross_exchange_transfer_subaccount_missing_after_clean_boundary:${record.id}`);
      }
      continue;
    }
    if (record.classification !== "pair" || !isAfterCleanBoundary(record)) continue;
    if (involvesPair) {
      if (!isAfterBaseline(record)) {
        reasons.push(`cross_exchange_transfer_after_clean_boundary_before_baseline:${record.id}`);
        continue;
      }
      const status = optionalString(value, ["status"])?.toLowerCase();
      const amount = transferAmountMicros(value);
      if (!amount || (status !== "complete" && status !== "completed" && status !== "succeeded")) {
        reasons.push(`cross_exchange_transfer_effect_unverified:${record.id}`);
        continue;
      }
      const delta = sourceAccount === subaccountNumber && sourceShard === exchangeIndex
        ? -amount : amount;
      record.cashDeltaMicros = microString(delta);
      cashDelta += delta;
    }
  }

  if (fundingAnchor && currentBalanceMicros !== null && validAnchor) {
    const actualDelta = currentBalanceMicros - baselineMicros;
    if (actualDelta !== cashDelta - restingEntryReserveMicros) {
      reasons.push("pair_cash_and_resting_entry_collateral_mismatch");
    }
  } else if (fundingAnchor && currentBalanceMicros === null) {
    reasons.push("pair_balance_unavailable");
  }

  if (!preFundingProvenanceVerified) {
    reasons.push("pre_funding_zero_snapshot_provenance_unverified");
  }
  const canonicalRecords = [...records].sort((a, b) =>
    a.feed.localeCompare(b.feed) || a.id.localeCompare(b.id) ||
    (a.exchangeIndex ?? -1) - (b.exchangeIndex ?? -1) ||
    a.payloadDigest.localeCompare(b.payloadDigest));
  const checkpointDigest = fundingAnchor && preFundingProvenanceVerified
    ? digestOf({
      version: 1,
      pair: { subaccountNumber, exchangeIndex },
      anchor: fundingAnchor,
      records: canonicalRecords,
    })
    : null;
  const uniqueReasons = [...new Set(reasons)];
  const complete = uniqueReasons.length === 0 && Boolean(fundingAnchor) &&
    preFundingProvenanceVerified &&
    marketExchangeIndex === exchangeIndex && currentBalanceMicros !== null;
  const finishedAt = new Date().toISOString();
  return {
    pair: { subaccountNumber, exchangeIndex },
    balance: {
      subaccountNumber,
      exchangeIndex,
      balanceDollars,
      availableCashDollars,
      balanceSemantics: "subaccount_inventory_plus_scoped_available_cash",
      updatedTs: updatedTs ?? 0,
    },
    collateralSnapshot: {
      availableCashMicros: currentBalanceMicros?.toString() ?? null,
      inventoryBalanceMicros,
      restingEntryReserveMicros: restingEntryReserveMicros.toString(),
      restingExitContractsByTicker,
      capturedAt: finishedAt,
    },
    marketExchangeIndex,
    keyRestrictionVerified,
    tradePermissionVerified,
    allTimeHistoryExhaustive: complete,
    exclusiveControlVerified: false,
    complete,
    reason: uniqueReasons[0] ?? null,
    reasons: uniqueReasons,
    records: canonicalRecords,
    feeEvidence,
    postAnchorCashDeltaMicros: fundingAnchor ? microString(cashDelta) : null,
    checkpointDigest,
    historyCoveredFrom: fundingAnchor?.baselineAt ?? null,
    fundingAnchor: fundingAnchor ?? null,
    recordCounts: {
      positions: positionRecords.filter(({ record }) => record.classification === "pair").length,
      orders: [...currentOrderRecords, ...historicalOrderRecords]
        .filter(({ record }) => record.classification === "pair").length,
      fills: [...currentFillRecords, ...historicalFillRecords]
        .filter(({ record }) => record.classification === "pair").length,
      settlements: settlementRecords.filter(({ record }) => record.classification === "pair").length,
      transfers: [...subaccountTransferRecords, ...crossTransferRecords]
        .filter(({ record }) => record.classification !== "elsewhere").length,
    },
    scanStartedAt,
    scanFinishedAt: finishedAt,
  };
}

/**
 * Capture a clean boundary before funding a newly provisioned (N, 2) pair.
 * Every check is based on this request's signed reads; callers cannot supply
 * an "authenticated" flag or evidence digest. The digest is emitted only when
 * every source is available and the pair has zero cash, exposure, and history.
 */
export async function captureCleanPairSnapshot(
  subaccountNumber: number,
  ticker: string,
  options: {
    creationBoundary?: boolean;
    acknowledgedRoundTrip?: {
      id: string;
      inboundTransferId: string;
      outboundTransferId: string;
      evidenceDigest: string;
    } | null;
  } = {},
): Promise<KalshiProspectiveCleanPairSnapshot> {
  const exchangeIndex = 2 as const;
  if (!Number.isSafeInteger(subaccountNumber) ||
      subaccountNumber < 1 || subaccountNumber > 63 ||
      (!options.creationBoundary && subaccountNumber !== getConfiguredKalshiSubaccount()) ||
      !/^KXBTC15M[A-Za-z0-9._-]*$/.test(ticker)) {
    throw new KalshiApiError("INVALID_CREDENTIALS");
  }

  const scanStartedMs = Date.now();
  const scanStartedAt = new Date(scanStartedMs).toISOString();
  const reasons: string[] = [];
  const ownerCredentials = verifierCredentials();
  const ownerPage = (
    path: string,
    query: string,
    timeoutMs: number,
  ) => getJsonWithCredentialsTimeout(path, query, timeoutMs, ownerCredentials);
  const cleanFeed = (
    name: string,
    path: string,
    query: string,
    keys: string[],
    id?: (value: JsonObject) => string,
  ) => readPairEvidenceFeed(
    name, path, query, keys, id,
    options.creationBoundary ? ownerPage : undefined,
  );
  const subaccountQuery = `?limit=${PAGE_LIMIT}&subaccount=${subaccountNumber}`;
  const pairQuery = `${subaccountQuery}&exchange_index=${exchangeIndex}`;
  const feedJobs = {
    positions: cleanFeed(
      "clean_positions", `${API_PREFIX}/portfolio/positions`,
      pairQuery, ["market_positions", "positions"], undefined,
    ),
    currentOrders: cleanFeed(
      "clean_current_orders", `${API_PREFIX}/portfolio/orders`,
      pairQuery, ["orders"], orderId,
    ),
    historicalOrders: cleanFeed(
      "clean_historical_orders", `${API_PREFIX}/historical/orders`,
      subaccountQuery, ["orders"], orderId,
    ),
    currentFills: cleanFeed(
      "clean_current_fills", `${API_PREFIX}/portfolio/fills`,
      pairQuery, ["fills"], fillId,
    ),
    historicalFills: cleanFeed(
      "clean_historical_fills", `${API_PREFIX}/historical/fills`,
      subaccountQuery, ["fills"], fillId,
    ),
    settlements: cleanFeed(
      "clean_settlements", `${API_PREFIX}/portfolio/settlements`,
      subaccountQuery, ["settlements"], settlementTicker,
    ),
    subaccountTransfers: readPairEvidenceFeed(
      "clean_subaccount_transfers", `${API_PREFIX}/portfolio/subaccounts/transfers`,
      `?limit=${PAGE_LIMIT}`, ["transfers"],
      (value) => requiredString(value, ["transfer_id"]), ownerPage,
    ),
    crossExchangeTransfers: readPairEvidenceFeed(
      "clean_cross_exchange_transfers",
      `${API_PREFIX}/portfolio/intra_exchange_instance_transfers`,
      `?limit=${PAGE_LIMIT}`, ["transfers"],
      (value) => requiredString(value, ["transfer_id"]), ownerPage,
    ),
  };

  const [
    inventoryResult,
    scopedBalanceResult,
    feedEntries,
    marketResult,
    keyRestrictionVerified,
    tradePermissionVerified,
  ] = await Promise.all([
    getJsonWithCredentialsTimeout(
      `${API_PREFIX}/portfolio/subaccounts/balances`, "", ACCOUNT_TIMEOUT_MS, ownerCredentials,
    ).then((payload) => ({ payload, error: null as string | null }), (error: unknown) => ({
      payload: null,
      error: error instanceof KalshiApiError
        ? `clean_inventory_${error.type.toLowerCase()}${error.status === undefined ? "" : `_http_${error.status}`}`
        : "clean_inventory_unknown_error",
    })),
    getJsonWithTimeout(
      `${API_PREFIX}/portfolio/balance`,
      `?subaccount=${subaccountNumber}&exchange_index=${exchangeIndex}`,
      ACCOUNT_TIMEOUT_MS,
      options.creationBoundary ? ownerCredentials : undefined,
    ).then((payload) => ({ payload, error: null as string | null }), (error: unknown) => ({
      payload: null,
      error: error instanceof KalshiApiError
        ? `clean_scoped_balance_${error.type.toLowerCase()}${error.status === undefined ? "" : `_http_${error.status}`}`
        : "clean_scoped_balance_unknown_error",
    })),
    Promise.all(Object.entries(feedJobs).map(async ([name, job]) =>
      [name, await job] as const)),
    getJsonWithTimeout(
      `${API_PREFIX}/markets/${encodeURIComponent(ticker)}`, "", ACCOUNT_TIMEOUT_MS,
      options.creationBoundary ? ownerCredentials : undefined,
    ).then((payload) => ({ payload, error: null as string | null }), (error: unknown) => ({
      payload: null,
      error: error instanceof KalshiApiError
        ? `clean_market_${error.type.toLowerCase()}`
        : "clean_market_unknown_error",
    })),
    options.creationBoundary ? Promise.resolve(false) :
      verifyKalshiTradingKeyRestrictionForSubaccount(subaccountNumber),
    options.creationBoundary ? Promise.resolve(false) :
      verifyKalshiTradingKeyTradePermissionForSubaccount(subaccountNumber),
  ]);
  const scanFinishedMs = Date.now();
  const scanFinishedAt = new Date(scanFinishedMs).toISOString();
  const feeds = Object.fromEntries(feedEntries) as Record<string, PairEvidenceFeed>;
  if (scanFinishedMs - scanStartedMs > ACCOUNT_TIMEOUT_MS) {
    reasons.push("clean_snapshot_scan_stale");
  }
  if (inventoryResult.error) reasons.push(inventoryResult.error);
  if (scopedBalanceResult.error) reasons.push(scopedBalanceResult.error);
  if (marketResult.error) reasons.push(marketResult.error);
  for (const [name, feed] of Object.entries(feeds)) {
    if (!feed.complete) reasons.push(feed.reason ?? `${name}_incomplete`);
  }
  if (!options.creationBoundary && !keyRestrictionVerified) {
    reasons.push("clean_key_subaccount_restriction_unverified");
  }
  if (!options.creationBoundary && !tradePermissionVerified) {
    reasons.push("clean_key_trade_permission_unverified");
  }

  const records: KalshiPairEvidenceRecord[] = [];
  let inventoryCashMicros: string | null = null;
  let availableCashMicros: string | null = null;
  let portfolioValueMicros: string | null = null;
  let marketExchangeIndex: 2 | null = null;
  let balanceUpdatedAt: number | null = null;
  if (inventoryResult.payload !== null) {
    try {
      const inventory = object(inventoryResult.payload);
      if (!Array.isArray(inventory.subaccount_balances)) {
        throw new KalshiApiError("INVALID_RESPONSE");
      }
      const rows = inventory.subaccount_balances.map(object);
      for (const row of rows) {
        const record = evidenceRecord(
          "balance", row, subaccountNumber,
          `${evidenceSubaccount(row) ?? "?"}:${normalizedExchangeIndex(row.exchange_index) ?? "?"}`,
          ["subaccount_number", "exchange_index", "balance", "updated_ts"],
        );
        records.push(record);
        if (record.classification === "ambiguous") {
          reasons.push(`clean_ambiguous_inventory:${record.id}`);
        }
      }
      const pairRows = rows.filter((row) =>
        evidenceSubaccount(row) === subaccountNumber &&
        normalizedExchangeIndex(row.exchange_index) === exchangeIndex);
      const inventoryReason = cleanPairInventoryDiagnosis(rows.map((row) => ({
        subaccount: evidenceSubaccount(row),
        exchangeIndex: normalizedExchangeIndex(row.exchange_index),
      })), subaccountNumber, exchangeIndex);
      if (inventoryReason) {
        reasons.push(inventoryReason);
      } else if (pairRows.length !== 1) {
        reasons.push("clean_pair_inventory_missing");
      } else {
        const row = pairRows[0]!;
        const balance = requiredDecimal(row, ["balance"]);
        inventoryCashMicros = microString(decimalMicros(balance));
        const timestamp = evidenceInteger(row.updated_ts);
        if (timestamp === null || timestamp === 0) {
          reasons.push("clean_pair_inventory_timestamp_missing");
        } else {
          balanceUpdatedAt = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
        }
      }
    } catch {
      reasons.push("clean_pair_inventory_invalid");
    }
  }
  if (scopedBalanceResult.payload !== null) {
    try {
      const root = object(scopedBalanceResult.payload);
      const value = root.balance && typeof root.balance === "object" &&
          !Array.isArray(root.balance) ? object(root.balance) : root;
      const record = evidenceRecord(
        "scoped_balance", value, subaccountNumber,
        `query:${subaccountNumber}:${exchangeIndex}`,
        ["subaccount_number", "subaccount", "exchange_index", "balance_dollars", "updated_ts"],
        false, true,
      );
      records.push(record);
      if (record.classification !== "pair") {
        reasons.push("clean_scoped_balance_identity_unverified");
      }
      const available = firstDecimal(value, ["balance_dollars"]);
      if (available === null) {
        reasons.push("clean_available_cash_field_missing");
      } else {
        availableCashMicros = microString(decimalMicros(available));
      }
      const portfolioValue = firstDecimal(value, ["portfolio_value"]);
      if (portfolioValue !== null) {
        portfolioValueMicros = microString(decimalMicros(portfolioValue));
      } else if (options.creationBoundary) {
        reasons.push("clean_portfolio_value_missing");
      }
      const timestamp = evidenceInteger(value.updated_ts);
      if (timestamp === null || timestamp === 0) {
        reasons.push("clean_scoped_balance_timestamp_missing");
      } else {
        const updatedAt = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
        if (updatedAt > scanFinishedMs + 5_000 ||
            scanFinishedMs - updatedAt > 30_000) {
          reasons.push("clean_scoped_balance_stale");
        }
        // The all-account inventory's updated_ts is the time its balance
        // last changed; the scoped zero-balance GET can report its read time.
        // A newly created, unfunded pair remains at zero without refreshing
        // the inventory timestamp. Keep the scoped read fresh and the exact
        // balances equal, but do not require those two different clocks to
        // advance together for the creation-only boundary.
        if (balanceUpdatedAt !== null &&
            (balanceUpdatedAt > scanFinishedMs + 5_000 ||
              (!options.creationBoundary &&
                Math.abs(balanceUpdatedAt - updatedAt) > 30_000) ||
              (options.creationBoundary && balanceUpdatedAt > updatedAt + 30_000))) {
          reasons.push("clean_balance_sources_not_contemporaneous");
        }
        balanceUpdatedAt ??= updatedAt;
      }
    } catch {
      reasons.push("clean_scoped_balance_invalid");
    }
  }
  if (inventoryCashMicros !== "0") reasons.push("clean_pair_inventory_cash_not_zero");
  if (availableCashMicros !== "0") reasons.push("clean_pair_available_cash_not_zero");
  if (options.creationBoundary && portfolioValueMicros !== "0") {
    reasons.push("clean_pair_portfolio_value_not_zero");
  }
  if (inventoryCashMicros !== null && availableCashMicros !== null &&
      inventoryCashMicros !== availableCashMicros) {
    reasons.push("clean_pair_balance_sources_mismatch");
  }

  if (marketResult.payload !== null) {
    try {
      const root = object(marketResult.payload);
      const market = object(root.market ?? root);
      if (normalizedExchangeIndex(market.exchange_index) === exchangeIndex) {
        marketExchangeIndex = exchangeIndex;
      } else {
        reasons.push("clean_market_exchange_index_mismatch");
      }
    } catch {
      reasons.push("clean_market_invalid");
    }
  }

  const addRecords = (
    name: string,
    feed: KalshiPairEvidenceRecord["feed"],
    idOf: (value: JsonObject) => string,
    fields: string[],
    settlementFilterAttested = false,
  ): Array<{ record: KalshiPairEvidenceRecord; value: JsonObject }> => {
    const page = feeds[name];
    if (!page) return [];
    return page.values.map((value) => {
      const record = evidenceRecord(
        feed, value, subaccountNumber, idOf(value), fields, settlementFilterAttested,
      );
      records.push(record);
      return { record, value };
    });
  };
  const positions = addRecords(
    "positions", "position", positionTicker,
    ["ticker", "position_fp", "position", "market_exposure_dollars", "market_exposure",
      "subaccount_number", "exchange_index"],
  );
  const orders = [
    ...addRecords("currentOrders", "current_order", orderId,
      ["ticker", "status", "remaining_count_fp", "remaining_count",
        "subaccount_number", "exchange_index", "created_time"]),
    ...addRecords("historicalOrders", "historical_order", orderId,
      ["ticker", "status", "remaining_count_fp", "remaining_count",
        "subaccount_number", "exchange_index", "created_time"]),
  ];
  const fills = [
    ...addRecords("currentFills", "current_fill", fillId,
      ["ticker", "fee_cost", "subaccount_number", "exchange_index", "created_time"]),
    ...addRecords("historicalFills", "historical_fill", fillId,
      ["ticker", "fee_cost", "subaccount_number", "exchange_index", "created_time"]),
  ];
  const settlements = addRecords(
    "settlements", "settlement", settlementTicker,
    ["ticker", "event_ticker", "fee_cost", "settled_time", "subaccount_number", "exchange_index"],
    true,
  );
  const subaccountTransfers = addRecords(
    "subaccountTransfers", "subaccount_transfer",
    (value) => requiredString(value, ["transfer_id"]),
    ["from_subaccount", "to_subaccount", "exchange_index", "amount_cents", "created_ts", "status"],
  );
  const crossExchangeTransfers = addRecords(
    "crossExchangeTransfers", "cross_exchange_transfer",
    (value) => requiredString(value, ["transfer_id"]),
    ["source_subaccount", "destination_subaccount", "source_exchange_shard",
      "destination_exchange_shard", "amount", "amount_dollars", "amount_cents",
      "created_ts", "status"],
  );
  for (const { record, value } of subaccountTransfers) {
    classifySubaccountTransfer(record, value, subaccountNumber);
  }
  for (const { record, value } of crossExchangeTransfers) {
    classifyCrossExchangeTransfer(record, value, subaccountNumber);
  }

  for (const item of positions) {
    const { record, value } = item;
    if (record.classification === "ambiguous") {
      reasons.push(`clean_ambiguous_position:${record.id}`);
      continue;
    }
    if (record.classification !== "pair") continue;
    try {
      const position = firstDecimal(value, ["position_fp", "position"]);
      if (position === null || decimalMicros(position) !== 0n) {
        reasons.push(`clean_position_not_zero:${record.id}`);
      }
    } catch {
      reasons.push(`clean_position_invalid:${record.id}`);
    }
  }
  for (const item of orders) {
    if (item.record.classification === "ambiguous") {
      reasons.push(`clean_ambiguous_order:${item.record.id}`);
    } else if (item.record.classification === "pair") {
      reasons.push(`clean_prior_order:${item.record.id}`);
    }
  }
  for (const item of fills) {
    if (item.record.classification === "ambiguous") {
      reasons.push(`clean_ambiguous_fill:${item.record.id}`);
    } else if (item.record.classification === "pair") {
      reasons.push(`clean_prior_fill:${item.record.id}`);
    }
  }
  for (const item of settlements) {
    if (item.record.classification === "ambiguous") {
      reasons.push(`clean_ambiguous_settlement:${item.record.id}`);
    } else if (item.record.classification === "pair") {
      reasons.push(`clean_prior_settlement:${item.record.id}`);
    }
  }
  for (const item of subaccountTransfers) {
    if (item.record.classification === "ambiguous") {
      reasons.push(`clean_ambiguous_subaccount_transfer:${item.record.id}`);
    } else if (item.record.classification === "pair") {
      reasons.push(`clean_prior_subaccount_transfer:${item.record.id}`);
    }
  }
  const retainedPreBoundaryCrossTransferIds = new Set<string>();
  for (const item of crossExchangeTransfers) {
    if (item.record.classification === "ambiguous") {
      const record = item.record;
      const touchesShardTwo = record.sourceExchangeIndex === exchangeIndex ||
        record.destinationExchangeIndex === exchangeIndex;
      const transferAt = record.occurredAt === null ? NaN : Date.parse(record.occurredAt);
      if (!Number.isFinite(transferAt)) {
        reasons.push(`clean_cross_exchange_transfer_timestamp_missing:${record.id}`);
      } else if (!touchesShardTwo) {
        reasons.push(`clean_ambiguous_cross_exchange_transfer:${record.id}`);
      } else if (transferAt >= scanStartedMs) {
        reasons.push(`clean_cross_exchange_transfer_during_snapshot_scan:${record.id}`);
      } else {
        // The feed is account-wide and does not identify numbered subaccounts.
        // Retain this pre-boundary evidence as ambiguous; do not infer that it
        // belonged to N or elsewhere. A newly captured zero boundary starts
        // prospective attribution only after this scan completes.
        retainedPreBoundaryCrossTransferIds.add(record.id);
      }
    } else if (item.record.classification === "pair") {
      reasons.push(`clean_prior_cross_exchange_transfer:${item.record.id}`);
    }
  }
  for (const record of records) {
    if (record.classification === "ambiguous" &&
        record.feed !== "scoped_balance" && record.feed !== "balance" &&
        !(record.feed === "cross_exchange_transfer" &&
          retainedPreBoundaryCrossTransferIds.has(record.id))) {
      const reason = `clean_ambiguous_record:${record.feed}:${record.id}`;
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }

  const canonicalRecords = [...records].sort((a, b) =>
    a.feed.localeCompare(b.feed) ||
    a.id.localeCompare(b.id) ||
    (a.exchangeIndex ?? -1) - (b.exchangeIndex ?? -1) ||
    a.payloadDigest.localeCompare(b.payloadDigest));
  const uniqueReasons = [...new Set(reasons)];
  const zeroPositions = !uniqueReasons.some((reason) =>
    reason.startsWith("clean_position_not_zero:") ||
    reason.startsWith("clean_position_invalid:") ||
    reason.startsWith("clean_ambiguous_position:"));
  const zeroOrders = orders.every(({ record }) => record.classification === "elsewhere");
  const zeroFills = fills.every(({ record }) => record.classification === "elsewhere");
  const zeroSettlements = settlements.every(({ record }) =>
    record.classification === "elsewhere");
  const zeroPriorPairTransfers = !uniqueReasons.some((reason) =>
    reason.startsWith("clean_ambiguous_subaccount_transfer:") ||
    reason.startsWith("clean_prior_subaccount_transfer:") ||
    reason.startsWith("clean_ambiguous_cross_exchange_transfer:") ||
    reason.startsWith("clean_prior_cross_exchange_transfer:") ||
    reason.startsWith("clean_cross_exchange_transfer_timestamp_missing:") ||
    reason.startsWith("clean_cross_exchange_transfer_during_snapshot_scan:"));
  const acknowledged = options.acknowledgedRoundTrip ?? null;
  const roundTripProof = acknowledged ? provePreBoundaryRoundTrip({
    availableCashMicros,
    inventoryCashMicros,
    portfolioValueMicros,
    zeroPositions,
    zeroOrders,
    zeroFills,
    zeroSettlements,
    reasons: uniqueReasons,
    records,
    scanStartedAt,
  }) : null;
  const waiverAccepted = Boolean(
    acknowledged && roundTripProof?.ok &&
    roundTripProof.roundTrip.inboundTransferId === acknowledged.inboundTransferId &&
    roundTripProof.roundTrip.outboundTransferId === acknowledged.outboundTransferId &&
    roundTripProof.roundTrip.evidenceDigest === acknowledged.evidenceDigest &&
    uniqueReasons.every((reason) =>
      reason === `clean_prior_subaccount_transfer:${acknowledged.inboundTransferId}` ||
      reason === `clean_prior_subaccount_transfer:${acknowledged.outboundTransferId}`),
  );
  const reasonsForClean = waiverAccepted && acknowledged
    ? uniqueReasons.filter((reason) =>
      reason !== `clean_prior_subaccount_transfer:${acknowledged.inboundTransferId}` &&
      reason !== `clean_prior_subaccount_transfer:${acknowledged.outboundTransferId}`)
    : uniqueReasons;
  const clean = reasonsForClean.length === 0 &&
    availableCashMicros === "0" && inventoryCashMicros === "0" &&
    zeroPositions && zeroOrders && zeroFills && zeroSettlements &&
    (zeroPriorPairTransfers || waiverAccepted) &&
    (options.creationBoundary || keyRestrictionVerified && tradePermissionVerified) &&
    marketExchangeIndex === exchangeIndex &&
    Object.values(feeds).every((feed) => feed.complete);
  const diagnosticScalar = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.length <= 64 && !/[\u0000-\u001f]/.test(value)) return value;
    return null;
  };
  const blockingTransfer = blockingSubaccountTransferDetail(uniqueReasons[0] ?? "", subaccountTransfers.map(({ record, value }) => ({
    feed: record.feed,
    id: record.id,
    classification: record.classification,
    occurredAt: null,
    details: {
      from_subaccount: diagnosticScalar(value.from_subaccount),
      to_subaccount: diagnosticScalar(value.to_subaccount),
      exchange_index: diagnosticScalar(value.exchange_index),
      amount_cents: diagnosticScalar(value.amount_cents),
      amount_dollars: diagnosticScalar(value.amount_dollars),
      amount: diagnosticScalar(value.amount),
      status: diagnosticScalar(value.status),
      created_ts: diagnosticScalar(value.created_ts),
      created_time: diagnosticScalar(value.created_time),
      created_at: diagnosticScalar(value.created_at),
    },
  })));
  const evidenceDigest = clean ? digestOf({
    version: 1,
    pair: { subaccountNumber, exchangeIndex },
    ticker,
    keyId: process.env.KALSHI_API_KEY_ID?.trim() ?? null,
    capturedAt: scanFinishedAt,
    availableCashMicros,
    inventoryCashMicros,
    portfolioValueMicros,
    marketExchangeIndex,
    zeroPositions,
    zeroOrders,
    zeroFills,
    zeroSettlements,
    zeroPriorPairTransfers,
    records: canonicalRecords,
    ...(waiverAccepted && acknowledged && roundTripProof?.ok ? {
      acknowledgedPreBoundaryRoundTrip: {
        acknowledgmentId: acknowledged.id,
        inboundTransferId: acknowledged.inboundTransferId,
        outboundTransferId: acknowledged.outboundTransferId,
        amountCents: 2500 as const,
        evidenceDigest: acknowledged.evidenceDigest,
      },
    } : {}),
  }) : null;

  return {
    pair: { subaccountNumber, exchangeIndex },
    status: clean ? "clean" : "blocked",
    capturedAt: scanFinishedAt,
    scanStartedAt,
    scanFinishedAt,
    availableCashMicros: availableCashMicros === "0" ? "0" : null,
    inventoryCashMicros: inventoryCashMicros === "0" ? "0" : null,
    portfolioValueMicros: portfolioValueMicros === "0" ? "0" : null,
    zeroPositions,
    zeroOrders,
    zeroFills,
    zeroSettlements,
    zeroPriorPairTransfers,
    keyRestrictionVerified,
    tradePermissionVerified,
    marketExchangeIndex,
    evidenceDigest,
    reasons: reasonsForClean,
    records: canonicalRecords,
    blockingTransfer: waiverAccepted ? null : blockingTransfer,
    preBoundaryRoundTripSatisfied: waiverAccepted,
  };
}

type OrderbookLevel = { priceTenThousandths: bigint; count: string };

function orderbookLevels(value: unknown, pricesAreDollars: boolean): OrderbookLevel[] {
  if (!Array.isArray(value)) throw new KalshiApiError("INVALID_RESPONSE");
  return value.map((level) => {
    if (!Array.isArray(level) || level.length < 2) {
      throw new KalshiApiError("INVALID_RESPONSE");
    }
    const rawPrice = decimal(level[0]);
    const count = decimal(level[1]);
    if (rawPrice === null || count === null || Number(count) < 0) {
      throw new KalshiApiError("INVALID_RESPONSE");
    }
    const match = /^(\d+)(?:\.(\d+))?$/.exec(rawPrice);
    if (!match || (match[2]?.length ?? 0) > 4) {
      throw new KalshiApiError("INVALID_RESPONSE");
    }
    const whole = BigInt(match[1]!);
    const fraction = (match[2] ?? "").padEnd(4, "0");
    const priceTenThousandths = pricesAreDollars
      ? whole * 10_000n + BigInt(fraction || "0")
      : whole * 100n;
    if (priceTenThousandths < 0n || priceTenThousandths > 10_000n) {
      throw new KalshiApiError("INVALID_RESPONSE");
    }
    return { priceTenThousandths, count };
  });
}

function sortedBidLevels(levels: OrderbookLevel[]): OrderbookLevel[] {
  return [...levels].sort((a, b) =>
    a.priceTenThousandths === b.priceTenThousandths
      ? 0
      : a.priceTenThousandths > b.priceTenThousandths ? -1 : 1);
}

function bestBid(levels: OrderbookLevel[]): OrderbookLevel | null {
  return sortedBidLevels(levels)[0] ?? null;
}

function priceString(priceTenThousandths: bigint | null): string | null {
  if (priceTenThousandths === null) return null;
  return `${priceTenThousandths / 10_000n}.${String(priceTenThousandths % 10_000n).padStart(4, "0")}`;
}

export async function readKalshiOrderbook(ticker: string): Promise<KalshiOrderbook> {
  if (typeof ticker !== "string" || !ticker.trim() || ticker.includes("/")) {
    throw new KalshiApiError("INVALID_RESPONSE");
  }
  const path = `${API_PREFIX}/markets/${encodeURIComponent(ticker)}/orderbook`;
  // Kalshi supports depth 1-100 (0 means all). Read a bounded full ladder so
  // large IOC sizing can prove the executable quantity inside the V13 limit.
  const payload = object(await getJson(path, "?depth=100"));
  const fixedPoint = payload.orderbook_fp !== undefined;
  const book = object(fixedPoint ? payload.orderbook_fp : payload.orderbook);
  const yesRaw = orderbookLevels(fixedPoint ? book.yes_dollars : book.yes, fixedPoint);
  const noRaw = orderbookLevels(fixedPoint ? book.no_dollars : book.no, fixedPoint);
  const yesLevels = sortedBidLevels(yesRaw);
  const noLevels = sortedBidLevels(noRaw);
  const yesBids = yesLevels[0] ?? null;
  const noBids = noLevels[0] ?? null;
  const normalized = (levels: OrderbookLevel[]): KalshiOrderbookLevel[] =>
    levels.map((level) => ({
      priceDollars: priceString(level.priceTenThousandths)!,
      availableContracts: level.count,
    }));
  const asksFromOpposite = (levels: OrderbookLevel[]): KalshiOrderbookLevel[] =>
    levels.map((level) => ({
      priceDollars: priceString(10_000n - level.priceTenThousandths)!,
      availableContracts: level.count,
    })).sort((a, b) => Number(a.priceDollars) - Number(b.priceDollars));
  return {
    yesBidDollars: priceString(yesBids?.priceTenThousandths ?? null),
    noBidDollars: priceString(noBids?.priceTenThousandths ?? null),
    yesAskDollars: priceString(noBids === null
      ? null : 10_000n - noBids.priceTenThousandths),
    noAskDollars: priceString(yesBids === null
      ? null : 10_000n - yesBids.priceTenThousandths),
    yesAskAvailableContracts: noBids?.count ?? null,
    noAskAvailableContracts: yesBids?.count ?? null,
    yesBidLevels: normalized(yesLevels),
    noBidLevels: normalized(noLevels),
    yesAskLevels: asksFromOpposite(noLevels),
    noAskLevels: asksFromOpposite(yesLevels),
    observedAt: new Date().toISOString(),
  };
}