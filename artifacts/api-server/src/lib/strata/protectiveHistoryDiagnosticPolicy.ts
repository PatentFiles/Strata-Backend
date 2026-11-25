export const HISTORY_PREVIEW_PATH = "/api/strata/me/release/protective-history-preview";
export const DIAGNOSTIC_HEALTH_PATH = "/api/healthz";

const VENUE = "https://external-api.kalshi.com";
const HISTORY = new Set([
  "/trade-api/v2/portfolio/balance",
  "/trade-api/v2/portfolio/orders",
  "/trade-api/v2/portfolio/fills",
  "/trade-api/v2/portfolio/positions",
  "/trade-api/v2/portfolio/settlements",
  "/trade-api/v2/historical/orders",
  "/trade-api/v2/historical/fills",
]);
const HEADER_NAMES = new Set(["authorization", "x-strata-read-intent"]);

export function isDiagnosticPreflight(origin: string | undefined, allowed: ReadonlySet<string>,
  requestedMethod: string | undefined, requestedHeaders: string | undefined): boolean {
  return !!origin && allowed.has(origin) && requestedMethod === "GET" &&
    (!requestedHeaders || requestedHeaders.split(",").every(h => HEADER_NAMES.has(h.trim().toLowerCase())));
}

export function configuredDiagnosticOrigins(raw: string | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of (raw ?? "").split(",").map(x => x.trim())) {
    if (!value) continue;
    try {
      const u = new URL(value);
      if (u.protocol === "https:" && u.origin === value) result.add(u.origin);
    } catch {/* An invalid origin cannot widen a production allowlist. */}
  }
  return result;
}

export function diagnosticJwksUrl(supabaseUrl: string): URL {
  const issuer = new URL(supabaseUrl);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash)
    throw Error("protective_history_diagnostic_auth_destination_invalid");
  return new URL(issuer.href.replace(/\/+$/, "") + "/auth/v1/.well-known/jwks.json");
}

/** Applied before importing the preview dependencies. No POST/PUT/PATCH/DELETE,
 * redirect, broad vendor path, unscoped account, or unexpected host can cross it. */
export function createProtectiveHistoryDiagnosticFetch(jwks: URL, transport: typeof fetch): typeof fetch {
  return (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const venueRead = url.origin === VENUE && HISTORY.has(url.pathname) &&
      url.searchParams.getAll("subaccount").join(",") === "1" &&
      url.searchParams.getAll("exchange_index").join(",") === "2";
    if (method !== "GET" || request?.body != null || init?.body != null ||
        url.username || url.password || url.hash || !(url.href === jwks.href || venueRead))
      throw Error("protective_history_diagnostic_egress_forbidden");
    return transport(input, { ...init, redirect: "error" });
  };
}
