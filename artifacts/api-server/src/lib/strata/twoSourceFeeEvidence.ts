/**
 * Commissioning DIAGNOSTIC ONLY: independent Kalshi API market-fee evidence.
 *
 * The reviewed July 7 PDF is the reference for the existing 0.07 formula and
 * rounding. This module deliberately never returns an approved fee artifact,
 * modifies a risk policy, signs an order, or invokes C52/C53 execution.
 * Full current-document provenance and reviewed operator approval are separate
 * gates; a correct live API response alone must NEVER satisfy them.
 *
 * Live order fees remain enforced by microLiveEntryFees.ts, unchanged.
 */
import { createHash } from "node:crypto";

export const KALSHI_SERIES = "KXBTC15M";
export const KALSHI_API_ORIGIN = "https://external-api.kalshi.com/trade-api/v2";
export const REVIEWED_REFERENCE_PDF_SHA256 =
  "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
const MAX_BYTES = 256_000;
const TIMEOUT_MS = 10_000;
// Bound issuer pagination to prevent unbounded scans during live preflight.
const MAX_MARKET_PAGES = 8;
const MARKET_PAGE_SIZE = 100;
const SERIES = KALSHI_SERIES;
const tickerPattern = /^KXBTC15M-[A-Za-z0-9-]+$/;

type JsonObject = Record<string, unknown>;
export type KalshiMarketFeeReadOnly = {
  ok: boolean;
  reason: string;
  series: typeof KALSHI_SERIES;
  exchangeIndex: 2;
  referenceDigest: string;
  liveVerifiedAt?: string;
  marketTicker?: string;
  eventTicker?: string;
  feeType?: "quadratic";
  feeMultiplier?: "1";
  metadataDigest?: string;
  pdfProvenanceApproved: false;
  ownerPolicyApproved: false;
  commissioningApproved: false;
  tradingEnabled: false;
};
const plain = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : null;
const fail = (reason: string): KalshiMarketFeeReadOnly => ({
  ok: false, reason, series: SERIES, exchangeIndex: 2,
  referenceDigest: REVIEWED_REFERENCE_PDF_SHA256,
  pdfProvenanceApproved: false, ownerPolicyApproved: false,
  commissioningApproved: false, tradingEnabled: false,
});
const canonicalTime = (value: unknown): number | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? (Number.isFinite(Date.parse(value)) ? Date.parse(value) : null) : null;

/** Read ONLY fixed Kalshi URLs; fail closed on redirect, malformed types or size. */
async function getJson(path: string, fetchImpl: typeof fetch): Promise<JsonObject> {
  const url = KALSHI_API_ORIGIN + path;
  const response = await fetchImpl(url, {
    method: "GET", redirect: "error", cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200 || response.url && response.url !== url ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw Error("official_api_source_unavailable");
  }
  const size = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(size) || size > MAX_BYTES) throw Error("official_api_response_invalid");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAX_BYTES) throw Error("official_api_response_invalid");
  const result = plain(JSON.parse(new TextDecoder().decode(bytes)));
  if (!result) throw Error("official_api_response_invalid");
  return result;
}
function exactStandard(type: unknown, multiplier: unknown): boolean {
  // Do not coerce unrecognized numbers, alternative fee types or zero fees.
  return type === "quadratic" &&
    (multiplier === 1 || multiplier === "1" || multiplier === "1.0");
}
function noOverrides(event: JsonObject): boolean {
  const t = event.fee_type_override;
  const m = event.fee_multiplier_override;
  return (t === null || t === undefined) && (m === null || m === undefined);
}
function safeChanges(data: JsonObject, key: string, windowEnd: number): boolean {
  // Do not silently ignore cursors, malformed rows, or scheduled fee changes
  // before the target market closes. Changes after that are checked at order time.
  if (data.cursor !== undefined && data.cursor !== "" || !Array.isArray(data[key]) ||
      data[key].length > 100) return false;
  return data[key].every((value: unknown) => {
    const row = plain(value);
    const ts = canonicalTime(row?.scheduled_ts);
    return !!row && typeof row.id === "string" && row.id.length > 0 &&
      ts !== null && ts > windowEnd;
  });
}

/**
 * Kalshi /markets is cursor-paginated. A nonempty cursor on page one does
 * NOT mean the response is invalid; it means all remaining pages must be
 * read before choosing an exact market. Reject a missing/looping cursor,
 * duplicate market, malformed response, or a scan beyond its fixed limit.
 * This only supplies a READ-ONLY fee diagnostic, never trading authority.
 */
async function completeOpenMarketListing(fetchImpl:typeof fetch):
  Promise<{ok:true;markets:JsonObject[]}|{ok:false}> {
  const markets:JsonObject[]=[];
  const visited=new Set<string>();
  const tickers=new Set<string>();
  let cursor="";
  for(let pageNumber=0;pageNumber<MAX_MARKET_PAGES;pageNumber++){
    const query="/markets?series_ticker=KXBTC15M&status=open&limit="+MARKET_PAGE_SIZE+
      (cursor?"&cursor="+encodeURIComponent(cursor):"");
    const listing=await getJson(query,fetchImpl);
    if(!Array.isArray(listing.markets)||listing.markets.length>MARKET_PAGE_SIZE||
       typeof listing.cursor!=="string"||listing.cursor.length>2048||
       (listing.markets.length===0&&listing.cursor!==""))
      return {ok:false};
    for(const candidate of listing.markets){
      const market=plain(candidate);
      if(!market||typeof market.ticker!=="string"||
         !tickerPattern.test(market.ticker)||tickers.has(market.ticker))
        return {ok:false};
      tickers.add(market.ticker);
      markets.push(market);
    }
    if(listing.cursor==="")return markets.length?{ok:true,markets}:{ok:false};
    if(visited.has(listing.cursor))return {ok:false};
    visited.add(listing.cursor);
    cursor=listing.cursor;
  }
  return {ok:false};
}

/** A positive result is an API observation, NOT authorization of the PDF. */
export async function probeCurrentKalshiFeeApi(
  fetchImpl: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
  expectedMarketTicker?: string,
): Promise<KalshiMarketFeeReadOnly> {
  // Order-time calls MUST bind evidence to the exact order market.
  // An ambiguous/absent ticker cannot fall back to another open market.
  if(expectedMarketTicker!==undefined && !tickerPattern.test(expectedMarketTicker))
    return fail("exact_market_identity_invalid");
  const started = clock();
  try {
    const listing = await completeOpenMarketListing(fetchImpl);
    if(!listing.ok)return fail("market_listing_incomplete");
    const now = clock();
    const open = listing.markets.filter((m): m is JsonObject =>
      (m.status === "open" || m.status === "active") &&
      canonicalTime(m.close_time) !== null &&
      canonicalTime(m.close_time)! > now &&
      (m.exchange_index === undefined || m.exchange_index === 2) &&
      tickerPattern.test(String(m.ticker ?? ""))).sort((a, b) =>
        canonicalTime(a.close_time)! - canonicalTime(b.close_time)!);
    const matches=expectedMarketTicker===undefined ? [] :
      open.filter(m=>m.ticker===expectedMarketTicker);
    const target=expectedMarketTicker===undefined ? open[0] : matches[0];
    if (!target || expectedMarketTicker!==undefined && matches.length!==1 ||
        expectedMarketTicker===undefined && open[1] &&
          target.close_time===open[1].close_time)
      return fail(expectedMarketTicker!==undefined ?
        "exact_market_not_in_complete_open_listing" : "market_target_ambiguous");
    const ticker = String(target.ticker);
    const eventTicker = target.event_ticker;
    if (typeof eventTicker !== "string" || !tickerPattern.test(eventTicker))
      return fail("market_event_identity_invalid");

    const [m,e,s,sc,ec] = await Promise.all([
      getJson("/markets/" + encodeURIComponent(ticker), fetchImpl),
      getJson("/events/" + encodeURIComponent(eventTicker), fetchImpl),
      getJson("/series/KXBTC15M", fetchImpl),
      // Kalshi's documented getSeriesFeeChanges takes series_ticker and
      // show_historical; it does NOT declare a limit argument. The event
      // counterpart accepts event_ticker/limit/cursor, NOT show_historical.
      // Unsupported query parameters can make the entire V4 evidence path
      // fail at HTTP 400 even when the series has the standard fee.
      getJson("/series/fee_changes?series_ticker=KXBTC15M&show_historical=false", fetchImpl),
      getJson("/events/fee_changes?event_ticker=" + encodeURIComponent(eventTicker) +
        "&limit=100", fetchImpl),
    ]);
    const market = plain(m.market), event = plain(e.event), series = plain(s.series);
    if (!market || !event || !series || market.ticker !== ticker ||
        market.event_ticker !== eventTicker || market.close_time !== target.close_time ||
        event.event_ticker !== eventTicker || event.series_ticker !== SERIES ||
        series.ticker !== SERIES || series.exchange_index !== 2 ||
        (market.exchange_index !== undefined && market.exchange_index !== 2) ||
        (event.exchange_index !== undefined && event.exchange_index !== 2) ||
        !exactStandard(series.fee_type, series.fee_multiplier))
      return fail("series_event_fee_mismatch");
    if (!noOverrides(event) || Object.keys(market).some(k =>
      /fee|rebate/i.test(k) && market[k] !== null && market[k] !== false && market[k] !== undefined))
      return fail("market_or_event_fee_override_unreviewed");

    const closeAt = canonicalTime(market.close_time);
    // expiration_time is deprecated and expected_expiration_time is
    // nullable/optional in Kalshi's market schema. Check all supplied values
    // but do not require ALL aliases to exist. latest_expiration_time remains
    // the authoritative mandatory upper bound for fee-change evaluation.
    const latest = canonicalTime(market.latest_expiration_time);
    const optionalExpiry = [market.expiration_time, market.expected_expiration_time]
      .filter(value => value !== undefined && value !== null)
      .map(canonicalTime);
    if (closeAt === null || closeAt <= clock() ||
        latest === null || latest < closeAt ||
        optionalExpiry.some(t => t === null || t < closeAt))
      return fail("market_lifecycle_unverified");
    const lifecycleEnd = Math.max(closeAt,latest,...optionalExpiry as number[]);
    if (!safeChanges(sc,"series_fee_change_arr",lifecycleEnd) ||
        !safeChanges(ec,"event_fee_changes",lifecycleEnd))
      return fail("fee_change_schedule_unverified");

    const verifiedAt = clock();
    if (verifiedAt < started || verifiedAt - started > 15_000 || verifiedAt >= closeAt)
      return fail("market_fee_evidence_stale");
    const facts = JSON.stringify({
      series: SERIES, ticker, eventTicker,
      seriesFeeType: series.fee_type, seriesMultiplier: series.fee_multiplier,
      seriesChanges: sc.series_fee_change_arr, eventChanges: ec.event_fee_changes,
      observedAt: verifiedAt,
    });
    return {
      ok: true, reason: "live_series_event_fee_metadata_verified_read_only",
      series: SERIES, exchangeIndex: 2, referenceDigest: REVIEWED_REFERENCE_PDF_SHA256,
      liveVerifiedAt: new Date(verifiedAt).toISOString(),
      marketTicker: ticker, eventTicker, feeType: "quadratic", feeMultiplier: "1",
      metadataDigest: createHash("sha256").update(facts).digest("hex"),
      pdfProvenanceApproved: false, ownerPolicyApproved: false,
      commissioningApproved: false, tradingEnabled: false,
    };
  } catch {
    return fail("official_api_metadata_unavailable");
  }
}
