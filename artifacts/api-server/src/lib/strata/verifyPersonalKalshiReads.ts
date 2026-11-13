import { KalshiApiError, getScopedKalshiJson } from "../kalshiAccountClient";
import { dedicatedSignerFingerprint } from "./commissioning";
import { PERSONAL_KALSHI_HOST, readOwnedKalshiFeeds } from "./personalExchangeRead";

const ACCOUNT_ID = "strata-account-1663464183a1c84ffb0c299e";

const SIGNER_SQL = `
  SELECT a.key_fingerprint, s.decrypted_secret
  FROM v13_production_account a
  JOIN private.kalshi_connection_credentials c
    ON c.owner_user_id = a.owner_user_id
   AND c.financial_account_id = a.kalshi_connection_id
   AND c.key_fingerprint = a.key_fingerprint
  JOIN vault.decrypted_secrets s ON s.id = c.vault_secret_id
  WHERE a.id = $1
    AND a.subaccount = 1
    AND a.exchange_index = 2
    AND c.role = 'restricted_execution'
    AND c.revoked_at IS NULL
    AND c.verified_at IS NOT NULL
    AND c.verification_reason = 'credential_verified'
`;

function report(value: unknown): void {
  console.log(JSON.stringify(value));
}

function parseSecret(secret: unknown): { keyId: string; privateKey: string } | null {
  if (typeof secret !== "string" || !secret) return null;
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const keyId = parsed.api_key_id;
    const privateKey = parsed.private_key;
    if (typeof keyId !== "string" || typeof privateKey !== "string" || !keyId || !privateKey) return null;
    return { keyId, privateKey };
  } catch {
    return null;
  }
}

async function signedGet(creds: { keyId: string; privateKey: string }, path: string, query = ""): Promise<
  { ok: true; body: unknown } | { ok: false; status: number | null; type: string }
> {
  try {
    return { ok: true, body: await getScopedKalshiJson(creds, path, query, fetch, PERSONAL_KALSHI_HOST) };
  } catch (error) {
    if (error instanceof KalshiApiError) return { ok: false, status: error.status ?? null, type: error.type };
    return { ok: false, status: null, type: "NETWORK_ERROR" };
  }
}

function countOf(body: unknown, key: string): number | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : null;
}

async function main(): Promise<void> {
  const url = process.env.STRATA_PRODUCTION_DATABASE_URL || process.env.DATABASE_URL || "";
  if (!url || url === "never_connect" || url.includes("never_connect")) {
    report({ ok: false, reason: "production_database_url_unavailable" });
    process.exitCode = 2;
    return;
  }
  process.env.DATABASE_URL = url;
  const { pool } = await import("@workspace/db");
  let creds: { keyId: string; privateKey: string } | null = null;
  let fingerprintMatch = false;
  try {
    const found = await pool.query(SIGNER_SQL, [ACCOUNT_ID]);
    if (found.rows.length !== 1) {
      report({ ok: false, reason: "restricted_signer_unavailable", rows: found.rows.length });
      process.exitCode = 2;
      return;
    }
    const row = found.rows[0] as { key_fingerprint?: unknown; decrypted_secret?: unknown };
    creds = parseSecret(row.decrypted_secret);
    const fingerprint = dedicatedSignerFingerprint(creds?.keyId ?? "", creds?.privateKey ?? "");
    fingerprintMatch = Boolean(creds && fingerprint && fingerprint === row.key_fingerprint);
    found.rows[0] = {};
  } catch {
    report({ ok: false, reason: "production_database_read_failed" });
    process.exitCode = 2;
    return;
  } finally {
    await pool.end().catch(() => undefined);
  }
  if (!creds || !fingerprintMatch) {
    report({ ok: false, reason: "credential_fingerprint_mismatch", fingerprintMatch });
    process.exitCode = 2;
    return;
  }
  const feeds = await readOwnedKalshiFeeds(creds, Date.now(), (material, path, query = "", fetchImpl = fetch) =>
    getScopedKalshiJson(material, path, query, fetchImpl, PERSONAL_KALSHI_HOST));
  const series = await signedGet(creds, "/trade-api/v2/series/KXBTC15M");
  const markets = await signedGet(creds, "/trade-api/v2/markets", "?series_ticker=KXBTC15M&status=open&limit=5");
  const ticker = markets.ok ? firstTicker(markets.body) : null;
  const orderbook = ticker
    ? await signedGet(creds, `/trade-api/v2/markets/${ticker}/orderbook`)
    : { ok: false as const, status: null, type: "market_ticker_missing" };
  creds = null;
  report({
    ok: feeds.ok === true && series.ok && markets.ok && orderbook.ok,
    fingerprintMatch: true,
    host: "external-api.kalshi.com",
    subaccount: 1,
    exchangeIndex: 2,
    balance: feeds.ok ? { ok: true, cashMicros: feeds.cashMicros } : { ok: false, reason: feeds.reason },
    orders: feeds.ok ? feeds.orders.length : null,
    fills: feeds.ok ? feeds.fills.length : null,
    positions: feeds.ok ? feeds.positions.length : null,
    settlements: feeds.ok ? feeds.settlements.length : null,
    series: series.ok ? { ok: true, feeType: textAt(series.body, ["series", "fee_type"]) } : series,
    markets: markets.ok ? { ok: true, count: countOf(markets.body, "markets"), ticker } : markets,
    orderbook: orderbook.ok ? { ok: true, hasBook: Boolean(textAt(orderbook.body, ["orderbook_fp"])) } : orderbook,
  });
  if (!(feeds.ok && series.ok && markets.ok && orderbook.ok)) process.exitCode = 1;
}

function firstTicker(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const markets = (body as Record<string, unknown>).markets;
  const first = Array.isArray(markets) ? markets[0] : null;
  if (!first || typeof first !== "object") return null;
  const ticker = (first as Record<string, unknown>).ticker;
  return typeof ticker === "string" && /^[A-Z0-9-]{1,80}$/.test(ticker) ? ticker : null;
}

function textAt(body: unknown, path: string[]): string | null {
  let current: unknown = body;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : current ? "present" : null;
}

void main();
