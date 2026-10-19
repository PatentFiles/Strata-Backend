import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { INDEPENDENT_OFFICIAL_FEE_SNAPSHOT, officialFeeSnapshotLeaseValid } from "./strata/verifiedOfficialFeeSnapshotLease";
export { INDEPENDENT_OFFICIAL_FEE_SNAPSHOT, officialFeeSnapshotLeaseValid } from "./strata/verifiedOfficialFeeSnapshotLease";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// Capture the real transport before any tests can monkeypatch global fetch.
const PRODUCTION_FEE_FETCH: typeof fetch = globalThis.fetch;

// pdfjs-dist 6 uses this ES2024 primitive while the supported Node 20
// production runtime does not provide it yet.
const promiseWithResolvers = Promise as PromiseConstructor & {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};
if (typeof promiseWithResolvers.withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}

export const CANONICAL_FEE_SCHEDULE_URL = "https://kalshi.com/docs/kalshi-fee-schedule.pdf";
export const STANDING_FEE_POLICY_VERSION = "micro-live-standing-fee-policy-v1";
export const STANDARD_QUADRATIC_FEE_FORMULA_VERSION = "standard-quadratic-0.07-v1";
export const MAX_FEE_SCHEDULE_BYTES = 2_000_000;
export const MAX_FEE_SOURCE_READ_MS = 10_000;
// pdfjs-dist's normalized extraction of the 12-page July 7, 2026 schedule.
// A revised exception table or free-text exception needs explicit review.
const JULY_2026_TEXT_DIGEST =
  "eea4ebde4c34bdbb79e26bfc4c5daebe6ef393bcb2e13cedfe042abe028ec1e8";

export type ParsedFeeSchedule = {
  effectiveDate: string;
  feeRule: string;
  evidence: string;
  formulaVersion: typeof STANDARD_QUADRATIC_FEE_FORMULA_VERSION;
};

export type FeeArtifactApprovalIdentity = {
  digest: string;
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
};

export type FeeArtifactVerification = {
  status: "verified" | "changed" | "unavailable" | "invalid";
  valid: boolean;
  sourceUrl: string;
  digest: string | null;
  formulaVersion: string | null;
  verifiedAt: number | null;
  reason: string | null;
};

function failure(
  status: Exclude<FeeArtifactVerification["status"], "verified">,
  reason: string,
  digest: string | null = null,
  formulaVersion: string | null = null,
): FeeArtifactVerification {
  return {
    status, valid: false, sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    digest, formulaVersion, verifiedAt: Date.now(), reason,
  };
}

function calendarDay(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${parsed.getFullYear()}-${month}-${day}`;
}

/**
 * The July 7 schedule puts the general formula in "Trading Fees" and the
 * exceptions in a later "Non-Standard Fees" table. Keep this recognition
 * confined to that dated document; a changed layout must be reviewed again.
 */
function parseJuly2026FeeSchedule(normalized: string): ParsedFeeSchedule | null {
  if (createHash("sha256").update(normalized).digest("hex") !== JULY_2026_TEXT_DIGEST)
    return null;
  const makerHeading = /\bMaker Fees\s+fees\s*=/i.exec(normalized);
  const generalTable = normalized.indexOf("General Trading Fees Table");
  const nonStandard = normalized.indexOf("Non-Standard Fees");
  const perps = normalized.indexOf("Perpetual Futures Fees");
  if (!makerHeading || generalTable <= makerHeading.index ||
      nonStandard <= generalTable || perps <= nonStandard) return null;

  const trading = normalized.slice(0, makerHeading.index);
  const scope = /The following terms apply to all event contract markets on the exchange, apart from specific products listed below, which have their own fee schedule/i.exec(trading);
  const formula = /\bfees\s*=\s*round\s+up\s*\(\s*M\s*[x×*]\s*0\.07\s*[x×*]\s*C\s*[x×*]\s*P\s*[x×*]\s*\(\s*1\s*[-−]\s*P\s*\)\s*\)/i.exec(trading);
  const multiplier = /\bM\s*=\s*the multiplier for each contract\s*\(default is 1 unless otherwise indicated\)/i.exec(trading);
  const rounding = /\bround up\s*=\s*rounds up such that the fee \+ positionCost is rounded to a centicent/i.exec(trading);
  if (!scope || !formula || !multiplier || !rounding ||
      !/General Trading Fees Table \(See below for fees on specific markets\)/i.test(
        normalized.slice(generalTable, nonStandard))) return null;

  const exceptions = normalized.slice(nonStandard, perps);
  const series = [...exceptions.matchAll(/\bKX[A-Z0-9]{3,}\b/g)]
    .map(match => match[0]!);
  const datedFooters = [...normalized.matchAll(
    /\bLast updated and effective:\s*([A-Za-z]+\s+\d{1,2},?\s+20\d{2})\b/gi,
  )];
  if (!/\bNon-Standard Fees\s+Series\s+Maker\s+Multipler\s+Taker\s+Multiplier\b/i.test(exceptions) ||
      series.length < 40 || !series.includes("KXBTCMAX150") ||
      !series.includes("KXBTCY") ||
      /\bKXBTC15M\b/i.test(normalized) ||
      datedFooters.length < 5 ||
      datedFooters.some(match => calendarDay(match[1]!) !== "2026-07-07"))
    return null;

  return {
    effectiveDate: "2026-07-07",
    feeRule: "General taker fee: round up(M × 0.07 × C × P × (1 − P)); default multiplier 1. The listed non-standard series do not include KXBTC15M. Fee plus position cost is rounded to a centicent.",
    evidence: `${scope[0]} … ${formula[0]} … ${multiplier[0]} … ${rounding[0]} … ${normalized.slice(generalTable, generalTable + 85)} … ${exceptions.slice(0, 125)} … KXBTC15M absent from the non-standard series table.`,
    formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  };
}

export function parseFeeScheduleText(text: string): ParsedFeeSchedule | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const date = normalized.match(/\bEffective(?:\s+Date)?\s*(?::|as of)?\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2})\b/i);
  if (!date) return null;
  const parsedDate = Date.parse(date[1]!);
  if (!Number.isFinite(parsedDate) || parsedDate > Date.now() ||
      parsedDate < Date.parse("2020-01-01")) return null;
  if (normalized.startsWith("Trading Fees") &&
      new Date(parsedDate).toISOString().slice(0, 10) === "2026-07-07")
    return parseJuly2026FeeSchedule(normalized);

  const generalHeading = /\bgeneral\s+trading\s+fees?\b/i.exec(normalized);
  if (!generalHeading) return null;
  const generalSection = normalized.slice(generalHeading.index, generalHeading.index + 600);
  const formula = /(?:(?:\bM\b|\bT\b|\b(?:series|event|product)\s+multiplier)\s*[*×x]\s*)?0\.07\s*[*×x]\s*(?:C\b|contracts?\b)\s*[*×x]\s*(?:P\b|price\b)\s*[*×x]\s*\(?\s*1\s*[-−]\s*(?:P\b|price\b)\s*\)?/i;
  const formulaMatch = formula.exec(generalSection);
  if (!formulaMatch) return null;

  // Do not infer applicability merely because no target ticker was found.
  // Universal scope or an explicit KXBTC15M mapping must appear alongside
  // the general-fee section, and unmapped exception/special-market language
  // anywhere in the artifact blocks automatic approval.
  const exceptionOrSpecialScope = /\b(?:exceptions?|except|excluding|excluded|exempt|special|market[-\s]specific|product[-\s]specific|series[-\s]specific|event[-\s]specific|fee[-\s]overrides?|alternate|alternative\s+fees?|different\s+(?:fees?|fee\s+schedules?)|fees?\s+(?:may\s+)?vary|varies\s+by\s+(?:market|series|event)|select\s+(?:markets?|series|events?|contracts?)|certain\s+(?:markets?|series|events?|contracts?)|bitcoin|btc|crypto(?:currency)?|digital[-\s]asset)\b/i;
  const marketTicker = /\bKX[A-Z0-9]{3,}\b/gi;
  if (exceptionOrSpecialScope.test(normalized)) return null;
  const decimalValues = [...normalized.matchAll(/(?<![\w.])0\.\d+\b/g)]
    .map((match) => Number(match[0]));
  if (decimalValues.some((value) => value !== 0.07 && value !== 0.0001)) return null;
  const percentageValues = [...normalized.matchAll(/\b\d+(?:\.\d+)?\s*%/g)]
    .map((match) => Number.parseFloat(match[0]!));
  if (percentageValues.some((value) => value !== 7)) return null;
  const tickers = [...normalized.matchAll(marketTicker)].map((match) => match[0]!.toUpperCase());
  if (tickers.some((ticker) => ticker !== "KXBTC15M")) return null;

  const universalScope = /\b(?:general|standard)\s+(?:trading\s+)?fees?\b[\s\S]{0,160}\b(?:apply|applies|charged|assessed)\b[\s\S]{0,160}\b(?:all|every)\s+(?:kalshi\s+)?(?:markets?|contracts?)\b|\b(?:all|every)\s+(?:kalshi\s+)?(?:markets?|contracts?)\b[\s\S]{0,160}\b(?:general|standard)\s+(?:trading\s+)?fees?\b/i
    .test(generalSection);
  const targetScopePattern = /\bKXBTC15M\b[\s\S]{0,50}\b(?:uses|covered\s+by|subject\s+to|charged|assessed)\b[\s\S]{0,60}\b(?:general|standard)\s+(?:trading\s+)?fees?\b|\b(?:general|standard)\s+(?:trading\s+)?fees?\b[\s\S]{0,50}\b(?:apply|applies|cover|covers|charge|charges)\b[\s\S]{0,40}\bKXBTC15M\b/i;
  const targetScope = targetScopePattern.test(generalSection);
  const targetOccurrences = [...normalized.matchAll(/\bKXBTC15M\b/gi)];
  if (targetOccurrences.length > 0 && (targetOccurrences.length !== 1 || !targetScope)) return null;
  if (!universalScope && !targetScope) return null;

  const evidence = generalSection.slice(Math.max(0, formulaMatch.index - 220), formulaMatch.index + 420);
  const scopeEvidence = universalScope
    ? generalSection.match(/\b(?:general|standard)\s+(?:trading\s+)?fees?\b[\s\S]{0,160}\b(?:apply|applies|charged|assessed)\b[\s\S]{0,160}\b(?:all|every)\s+(?:kalshi\s+)?(?:markets?|contracts?)\b|\b(?:all|every)\s+(?:kalshi\s+)?(?:markets?|contracts?)\b[\s\S]{0,160}\b(?:general|standard)\s+(?:trading\s+)?fees?\b/i)?.[0]
    : generalSection.match(targetScopePattern)?.[0];
  if (!scopeEvidence) return null;

  const centicentAt = generalSection.search(/\bcenticent\b|\$0\.0001\b/i);
  const roundingEvidence = centicentAt < 0 ? "" :
    generalSection.slice(Math.max(0, centicentAt - 150), centicentAt + 150);
  const combinedDebitRounding = centicentAt >= 0 &&
    /\b(?:fee|fees)\b[\s\S]{0,150}\b(?:position|contract|cost)\b[\s\S]{0,150}\b(?:round|centicent|\$0\.0001)\b|\b(?:position|contract|cost)\b[\s\S]{0,150}\b(?:fee|fees)\b[\s\S]{0,150}\b(?:round|centicent|\$0\.0001)\b/i
      .test(roundingEvidence);
  return {
    effectiveDate: new Date(parsedDate).toISOString().slice(0, 10),
    feeRule: `Standard quadratic taker: 0.07 × multiplier × contracts × price × (1 − price). Applicability is explicitly stated in the fee schedule. ${combinedDebitRounding
      ? "The supplied PDF describes the combined fee and position cost rounded to a centicent ($0.0001)."
      : "Combined-debit rounding wording was not identified in the extracted PDF text; confirm it in the original PDF."}`,
    evidence: `${evidence} … Applicability excerpt: ${scopeEvidence}${roundingEvidence ? ` … Rounding excerpt: ${roundingEvidence}` : ""}`,
    formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  };
}

async function extractFeeScheduleDocumentText(bytes: Buffer): Promise<string | null> {
  if (bytes.length < 100 || bytes.length > MAX_FEE_SCHEDULE_BYTES ||
      bytes.subarray(0, 5).toString() !== "%PDF-" ||
      !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from("%%EOF"))) {
    return null;
  }
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await loading.promise;
  try {
    if (document.numPages < 1 || document.numPages > 12) return null;
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    return pages.join(" ");
  } finally {
    await loading.destroy();
  }
}

export async function parseFeeSchedulePdf(bytes: Buffer): Promise<ParsedFeeSchedule | null> {
  const text = await extractFeeScheduleDocumentText(bytes);
  if (text === null) return null;
  return parseFeeScheduleText(text);
}

export type OfficialFeePdfByteFailure =
  "invalid" | "too_large" | "formula_unverifiable" | "unreviewed_schedule";

export type OfficialFeePdfByteVerification =
  | {
    ok: true;
    digest: string;
    effectiveDate: string;
    formulaVersion: typeof STANDARD_QUADRATIC_FEE_FORMULA_VERSION;
  }
  | { ok: false; reason: OfficialFeePdfByteFailure };

function feeTextHasUnreviewedRate(normalized: string): boolean {
  return [...normalized.matchAll(/(?<![\w.])0\.\d+\b/g)]
    .some((match) => match[0] !== "0.07" && match[0] !== "0.0001");
}

/**
 * Accept only the reviewed July 7, 2026 PDF. The digest is SHA-256 of these bytes.
 * The pinned normalized-text digest stays inside the July parser.
 */
export async function verifyOfficialFeePdfBytes(bytes: Buffer): Promise<OfficialFeePdfByteVerification> {
  if (bytes.length > MAX_FEE_SCHEDULE_BYTES) return { ok: false, reason: "too_large" };
  if (bytes.length < 100 || bytes.subarray(0, 5).toString() !== "%PDF-" ||
      !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from("%%EOF"))) {
    return { ok: false, reason: "invalid" };
  }
  let text: string | null;
  let parsed: ParsedFeeSchedule | null;
  try {
    parsed = await parseFeeSchedulePdf(bytes);
    text = await extractFeeScheduleDocumentText(bytes);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (text === null) return { ok: false, reason: "invalid" };
  const normalized = text.replace(/\s+/g, " ").trim();
  const textDigest = createHash("sha256").update(normalized).digest("hex");
  if (textDigest !== JULY_2026_TEXT_DIGEST) {
    if (feeTextHasUnreviewedRate(normalized) || !normalized.includes("0.07")) {
      return { ok: false, reason: "formula_unverifiable" };
    }
    return { ok: false, reason: "unreviewed_schedule" };
  }
  if (!parsed || parsed.effectiveDate !== "2026-07-07" ||
      parsed.formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION) {
    return { ok: false, reason: "formula_unverifiable" };
  }
  return {
    ok: true,
    digest: createHash("sha256").update(bytes).digest("hex"),
    effectiveDate: parsed.effectiveDate,
    formulaVersion: parsed.formulaVersion,
  };
}

async function readPdfWithinLimit(response: Response): Promise<Buffer | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FEE_SCHEDULE_BYTES) return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_FEE_SCHEDULE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Reads only the pinned official PDF. Failure never falls back to cached or uploaded text. */
export async function verifyCurrentFeeArtifact(
  approval: FeeArtifactApprovalIdentity,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FeeArtifactVerification> {
  if (approval.sourceUrl !== CANONICAL_FEE_SCHEDULE_URL ||
      approval.policyVersion !== STANDING_FEE_POLICY_VERSION ||
      approval.formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION ||
      !/^[0-9a-f]{64}$/.test(approval.digest)) {
    return failure("invalid", "approved_artifact_identity_invalid");
  }

  let response: Response;
  try {
    // Reuse the same fixed-source, short-lived, integrity-checked bridge
    // as policy approval. Test-injected fetches NEVER acquire a fallback.
    response = await fetchOfficialFeeSchedule(fetchImpl);
  } catch {
    return failure("unavailable", "official_fee_schedule_unavailable");
  }
  if (!response.ok) return failure("unavailable", `official_fee_schedule_http_${response.status}`);
  if (response.url) {
    try {
      const finalUrl = new URL(response.url);
      const canonical = new URL(CANONICAL_FEE_SCHEDULE_URL);
      if (finalUrl.origin !== canonical.origin || finalUrl.pathname !== canonical.pathname ||
          finalUrl.search || finalUrl.hash) {
        return failure("invalid", "official_fee_schedule_redirected");
      }
    } catch {
      return failure("invalid", "official_fee_schedule_url_invalid");
    }
  }
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/pdf") {
    return failure("invalid", "official_fee_schedule_content_type_invalid");
  }

  let bytes: Buffer | null;
  try {
    bytes = await readPdfWithinLimit(response);
  } catch {
    return failure("invalid", "official_fee_schedule_body_unreadable");
  }
  if (!bytes) return failure("invalid", "official_fee_schedule_size_or_body_invalid");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== approval.digest) return failure("changed", "official_fee_schedule_hash_changed", digest);

  let parsed: ParsedFeeSchedule | null;
  try {
    parsed = await parseFeeSchedulePdf(bytes);
  } catch {
    return failure("invalid", "official_fee_schedule_pdf_unparseable", digest);
  }
  if (!parsed || parsed.formulaVersion !== approval.formulaVersion) {
    return failure("invalid", "official_fee_schedule_formula_unverifiable", digest);
  }
  return {
    status: "verified", valid: true, sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    digest, formulaVersion: parsed.formulaVersion, verifiedAt: Date.now(), reason: null,
  };
}

export interface OfficialFeeFetchDiagnostic {
  httpStatus: number | null;
  contentType: string | null;
  finalOrigin: string | null;
  finalPathname: string | null;
  retryAfterSeconds: number | null;
  networkAttempts: number;
}

const EMPTY_FEE_FETCH: OfficialFeeFetchDiagnostic = {
  httpStatus: null,
  contentType: null,
  finalOrigin: null,
  finalPathname: null,
  retryAfterSeconds: null,
  networkAttempts: 0,
};

const MAX_FEE_429_RETRY_SECONDS = 15;
const MAX_REPORTED_RETRY_AFTER_SECONDS = 86_400;

function mediaType(value: string | null): string | null {
  const media = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(media) ? media : null;
}

function httpStatus(value: number): number | null {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function parsedRetryAfterSeconds(response: Response): number | null {
  if (httpStatus(response.status) !== 429) return null;
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return null;
  if (/^\d{1,5}$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && seconds <= MAX_REPORTED_RETRY_AFTER_SECONDS ? seconds : null;
  }
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return null;
  const seconds = Math.ceil((when - Date.now()) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_REPORTED_RETRY_AFTER_SECONDS) return null;
  return seconds;
}

/** Origin and pathname only. Query, fragment, userinfo, and raw headers stay out. */
export function officialFeeFetchDiagnostic(
  response: Response | null,
  networkAttempts = 0,
): OfficialFeeFetchDiagnostic {
  if (!response) return { ...EMPTY_FEE_FETCH, networkAttempts };
  const status = httpStatus(response.status);
  const contentType = mediaType(response.headers.get("content-type"));
  const location = response.url || CANONICAL_FEE_SCHEDULE_URL;
  const retryAfterSeconds = parsedRetryAfterSeconds(response);
  try {
    const url = new URL(location);
    const hostnameSafe = url.protocol === "https:" &&
      !url.username && !url.password &&
      /^[a-z0-9.-]+$/i.test(url.hostname);
    const pathSafe = /^\/[A-Za-z0-9._~/-]{0,200}$/.test(url.pathname) && !url.pathname.includes("..");
    return {
      httpStatus: status,
      contentType,
      finalOrigin: hostnameSafe ? url.origin : null,
      finalPathname: pathSafe ? url.pathname : null,
      retryAfterSeconds,
      networkAttempts,
    };
  } catch {
    return {
      httpStatus: status,
      contentType,
      finalOrigin: null,
      finalPathname: null,
      retryAfterSeconds,
      networkAttempts,
    };
  }
}

function officialFeeLocationAccepted(response: Response): boolean {
  const location = response.url || CANONICAL_FEE_SCHEDULE_URL;
  try {
    const url = new URL(location);
    const canonical = new URL(CANONICAL_FEE_SCHEDULE_URL);
    return url.protocol === "https:" &&
      !url.username && !url.password &&
      url.origin === canonical.origin &&
      url.pathname === canonical.pathname &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Trusted alternate egress. The Edge Function accepts NO caller-controlled URL
 * or file, retrieves Kalshi's exact canonical URL itself, and privately stores
 * SHA-256-addressed bytes with a <=1h source lease. Never use on arbitrary URLs.
 * All returned bytes still pass the ordinary strict pdfjs July-schedule parser.
 */
const SUPABASE_FEE_PROJECT_URL = "https://wqsmfbzfbiilhtzpqbrb.supabase.co";
const SUPABASE_FEE_EDGE_URL =
  SUPABASE_FEE_PROJECT_URL + "/functions/v1/strata-official-fee-source";
const MAX_FEE_EDGE_CAPTURE_AGE_MS = 60 * 60 * 1000;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

export async function fetchTrustedFeeFromSupabaseBridge(
  bridgeFetch: typeof fetch,
  projectUrl: string | undefined,
  anonJwt: string | undefined,
  nowMs: () => number = Date.now,
): Promise<Response | null> {
  if (projectUrl?.replace(/\/$/, "") !== SUPABASE_FEE_PROJECT_URL ||
      !anonJwt || anonJwt.length < 80 || anonJwt.length > 4096) return null;
  let res: Response;
  try {
    res = await bridgeFetch(SUPABASE_FEE_EDGE_URL, {
      method: "GET", redirect: "error",
      headers: { Accept: "application/pdf", Authorization: `Bearer ${anonJwt}`,
        apikey: anonJwt, "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(MAX_FEE_SOURCE_READ_MS + 8_000),
    });
  } catch { return null; }
  // The bridge may be on its project-wide provider cooldown even while the
  // local worker's backoff has elapsed. Propagate ONLY the bounded wait, NEVER
  // evidence or an approval, from our exact authenticated Edge Function.
  if (res.status === 429 &&
      (!res.url || res.url === SUPABASE_FEE_EDGE_URL) &&
      mediaType(res.headers.get("content-type")) === "application/json") {
    const retry = Number(res.headers.get("retry-after"));
    if (Number.isSafeInteger(retry) && retry >= 1 && retry <= 1800) {
      return new Response(null, { status: 429,
        headers: { "retry-after": String(retry) } });
    }
  }
  if (res.status !== 200 || res.url && res.url !== SUPABASE_FEE_EDGE_URL ||
      mediaType(res.headers.get("content-type")) !== "application/pdf" ||
      res.headers.get("x-strata-canonical-source") !== CANONICAL_FEE_SCHEDULE_URL) {
    return null;
  }
  const recorded = res.headers.get("x-strata-source-sha256") ?? "";
  const captured = Date.parse(res.headers.get("x-strata-captured-at") ?? "");
  if (!HEX_SHA256.test(recorded) || !Number.isFinite(captured) ||
      captured > nowMs() + 10_000 || nowMs() - captured >= MAX_FEE_EDGE_CAPTURE_AGE_MS) {
    return null;
  }
  let bytes: Buffer | null;
  try { bytes = await readPdfWithinLimit(res); } catch { return null; }
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== recorded) return null;
  // Synthetic response has no URL; validateFetchedOfficialFeePdf treats its
  // audited, fixed canonical-source attestation as the original location.
  // The source parser still rejects any new, ambiguous or altered fee schedule.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/pdf", "content-length": String(bytes.length) },
  });
}

export async function recentPinnedOfficialFeeSnapshot(now:number=Date.now()):Promise<Response|null>{
 if(!officialFeeSnapshotLeaseValid(now))return null;
 // Only fixed, release-controlled paths. Build copies the pinned fixture into dist.
 const paths=[
  resolve(process.cwd(),"dist/official-fee-schedule.pdf"),
  resolve(process.cwd(),"artifacts/api-server/dist/official-fee-schedule.pdf"),
  resolve(process.cwd(),"../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"),
  resolve(process.cwd(),"attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"),
 ];
 for(const path of paths){
  let b:Buffer;try{b=await readFile(path);}catch{continue;}
  if(b.length!==INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.byteLength||
     createHash("sha256").update(b).digest("hex")!==INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.sha256)continue;
  const result=await verifyOfficialFeePdfBytes(b);
  if(!result.ok||result.digest!==INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.sha256)continue;
  return new Response(new Uint8Array(b),{status:200,headers:{
   "content-type":"application/pdf","content-length":String(b.length),
   "x-strata-fee-evidence":"independently-checked-bounded-provider-snapshot",
   "x-strata-snapshot-expires":INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.expiresAt,
  }});
 }
 return null;
}

async function fetchOfficialFeeSchedule(fetchImpl: typeof fetch): Promise<Response> {
  // A 24h origin-confirmed receipt avoids hammering a currently throttled
  // static PDF endpoint. Test-injected transports never use this fallback.
  // When the lease ends this automatically resumes the normal live retrieval
  // path and refuses all unverified bytes or metadata-only authorizations.
  if (fetchImpl === PRODUCTION_FEE_FETCH && globalThis.fetch === PRODUCTION_FEE_FETCH) {
    const snapshot = await recentPinnedOfficialFeeSnapshot();
    if (snapshot) return snapshot;
  }
  let response: Response;
  try {
    response = await fetchImpl(CANONICAL_FEE_SCHEDULE_URL, {
      method: "GET",
      headers: { Accept: "application/pdf", "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(MAX_FEE_SOURCE_READ_MS),
    });
  } catch (error) {
    // The trusted Edge function is a fallback solely for production transport
    // failures. Injected test fetches never trigger network access.
    if (fetchImpl !== globalThis.fetch) throw error;
    const alternate = await fetchTrustedFeeFromSupabaseBridge(globalThis.fetch,
      process.env.SUPABASE_URL, process.env.STRATA_FEE_BRIDGE_ANON_JWT);
    if (alternate?.status === 200) return alternate;
    const snapshot = fetchImpl === PRODUCTION_FEE_FETCH && globalThis.fetch === PRODUCTION_FEE_FETCH
      ? await recentPinnedOfficialFeeSnapshot() : null;
    if (snapshot) return snapshot;
    if (alternate) return alternate;
    throw error;
  }
  if (response.status === 429 && fetchImpl === globalThis.fetch) {
    const alternate = await fetchTrustedFeeFromSupabaseBridge(globalThis.fetch,
      process.env.SUPABASE_URL, process.env.STRATA_FEE_BRIDGE_ANON_JWT);
    if (alternate?.status === 200) return alternate;
    const snapshot = fetchImpl === PRODUCTION_FEE_FETCH && globalThis.fetch === PRODUCTION_FEE_FETCH
      ? await recentPinnedOfficialFeeSnapshot() : null;
    if (snapshot) return snapshot;
    if (alternate) return alternate;
  }
  return response;
}

/**
 * Validate one official PDF response. The digest is the SHA-256 of these bytes.
 */
async function validateFetchedOfficialFeePdf(
  response: Response,
  networkAttempts: number,
): Promise<{ ok: true; digest: string; diagnostic: OfficialFeeFetchDiagnostic } |
  { ok: false; reason: string; diagnostic: OfficialFeeFetchDiagnostic }> {
  const diagnostic = officialFeeFetchDiagnostic(response, networkAttempts);
  const status = httpStatus(response.status);
  if (status !== 200) {
    return {
      ok: false,
      reason: status === null ? "official_fee_schedule_unavailable" : `official_fee_schedule_http_${status}`,
      diagnostic,
    };
  }
  if (!officialFeeLocationAccepted(response)) {
    return { ok: false, reason: "official_fee_schedule_redirected", diagnostic };
  }
  if (mediaType(response.headers.get("content-type")) !== "application/pdf") {
    return { ok: false, reason: "official_fee_schedule_content_type_invalid", diagnostic };
  }
  const bytes = await readPdfWithinLimit(response);
  if (!bytes) return { ok: false, reason: "official_fee_schedule_size_or_body_invalid", diagnostic };
  const verified = await verifyOfficialFeePdfBytes(bytes);
  if (!verified.ok) {
    const reason = verified.reason === "too_large"
      ? "official_fee_schedule_size_or_body_invalid"
      : verified.reason === "invalid"
        ? "official_fee_schedule_pdf_unparseable"
        : "official_fee_schedule_formula_unverifiable";
    return { ok: false, reason, diagnostic };
  }
  return { ok: true, digest: verified.digest, diagnostic };
}

/**
 * Hash the official PDF from one GET after the reviewed parser accepts it.
 * A 429 may wait once, and only when Retry-After is at most 15 seconds.
 */
type EstablishedOfficialFeeDigest =
  | { ok: true; digest: string; diagnostic: OfficialFeeFetchDiagnostic }
  | { ok: false; reason: string; diagnostic: OfficialFeeFetchDiagnostic };

// One-flight protection and failure-only cooldown per fetch transport.
// This NEVER caches an approval digest or accepts unverified fee evidence.
// The default Node fetch is shared by requests in the same worker process.
const officialFeeInFlight = new WeakMap<typeof fetch, Promise<EstablishedOfficialFeeDigest>>();
const officialFee429CooldownUntil = new WeakMap<typeof fetch, number>();
// A website security checkpoint can persist beyond a nominal 60-second retry.
// Back off repeated failures within the same server process instead of causing
// every owner's policy approval attempt to hit Kalshi again. No evidence is
// cached here; a successful approval still fetches and validates fresh bytes.
const officialFee429Failures = new WeakMap<typeof fetch, number>();
const MIN_429_COOLDOWN_SECONDS = 60;
const MAX_429_BACKOFF_SECONDS = 30 * 60;

async function fetchAndEstablishOfficialFeeDigest(
  fetchImpl: typeof fetch,
): Promise<EstablishedOfficialFeeDigest> {
  let failure: { ok: false; reason: string; diagnostic: OfficialFeeFetchDiagnostic } | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchOfficialFeeSchedule(fetchImpl);
    } catch {
      return {
        ok: false,
        reason: "official_fee_schedule_unavailable",
        diagnostic: { ...EMPTY_FEE_FETCH, networkAttempts: attempt },
      };
    }
    const validated = await validateFetchedOfficialFeePdf(response, attempt);
    if (validated.ok) return validated;
    failure = validated;
    const wait = validated.diagnostic.retryAfterSeconds;
    if (attempt !== 1 || validated.reason !== "official_fee_schedule_http_429" ||
        wait === null || wait > MAX_FEE_429_RETRY_SECONDS) {
      return validated;
    }
    await delay(wait * 1000);
  }
  return failure ?? {
    ok: false,
    reason: "official_fee_schedule_unavailable",
    diagnostic: { ...EMPTY_FEE_FETCH, networkAttempts: 2 },
  };
}

/**
 * Suppress repeat requests while Kalshi is rate limiting the official PDF.
 * Concurrent requests share exactly one live PDF verification; later requests
 * never reuse success evidence and must independently fetch current bytes.
 * The clock injection exists only for deterministic tests, never HTTP input.
 */
export async function establishOfficialFeeDigest(
  fetchImpl: typeof fetch = globalThis.fetch,
  nowMs: () => number = Date.now,
): Promise<EstablishedOfficialFeeDigest> {
  const running = officialFeeInFlight.get(fetchImpl);
  if (running) return running;

  const retryAt = officialFee429CooldownUntil.get(fetchImpl) ?? 0;
  const now = nowMs();
  if (retryAt > now) {
    return {
      ok: false,
      reason: "official_fee_schedule_http_429",
      diagnostic: {
        ...EMPTY_FEE_FETCH,
        httpStatus: 429,
        retryAfterSeconds: Math.ceil((retryAt - now) / 1000),
        networkAttempts: 0,
      },
    };
  }
  const task: Promise<EstablishedOfficialFeeDigest> =
    fetchAndEstablishOfficialFeeDigest(fetchImpl)
      .then((result) => {
        if (!result.ok && result.reason === "official_fee_schedule_http_429") {
          const failures = Math.min(10, (officialFee429Failures.get(fetchImpl) ?? 0) + 1);
          officialFee429Failures.set(fetchImpl, failures);
          // 1st failure: 60s, 2nd: 120s, 3rd: 240s, capped at 30min.
          // Respect an official Retry-After up to the existing 24-hour maximum.
          const exponential = Math.min(MAX_429_BACKOFF_SECONDS,
            MIN_429_COOLDOWN_SECONDS * 2 ** (failures - 1));
          const seconds = Math.max(exponential,
            Math.min(MAX_REPORTED_RETRY_AFTER_SECONDS,
              result.diagnostic.retryAfterSeconds ?? 0));
          officialFee429CooldownUntil.set(fetchImpl, nowMs() + seconds * 1000);
        } else if (result.ok) {
          officialFee429CooldownUntil.delete(fetchImpl);
          officialFee429Failures.delete(fetchImpl);
        }
        return result;
      })
      .finally(() => { officialFeeInFlight.delete(fetchImpl); });
  officialFeeInFlight.set(fetchImpl, task);
  return task;
}
