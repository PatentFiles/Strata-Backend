import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
      datedFooters.some(match => Date.parse(match[1]!) !== Date.parse("2026-07-07")))
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

export async function parseFeeSchedulePdf(bytes: Buffer): Promise<ParsedFeeSchedule | null> {
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
    return parseFeeScheduleText(pages.join(" "));
  } finally {
    await loading.destroy();
  }
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
    response = await fetchImpl(CANONICAL_FEE_SCHEDULE_URL, {
      method: "GET",
      headers: { Accept: "application/pdf", "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(MAX_FEE_SOURCE_READ_MS),
    });
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

/**
 * Hash the official PDF only after the reviewed parser accepts the formula.
 * A mismatched placeholder digest is not a successful verification.
 */
export async function establishOfficialFeeDigest(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: true; digest: string } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetchImpl(CANONICAL_FEE_SCHEDULE_URL, {
      method: "GET",
      headers: { Accept: "application/pdf", "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(MAX_FEE_SOURCE_READ_MS),
    });
  } catch {
    return { ok: false, reason: "official_fee_schedule_unavailable" };
  }
  if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") {
    return { ok: false, reason: "official_fee_schedule_unreadable" };
  }
  const bytes = await readPdfWithinLimit(response);
  if (!bytes) return { ok: false, reason: "official_fee_schedule_size_or_body_invalid" };
  const parsed = await parseFeeSchedulePdf(bytes).catch(() => null);
  if (!parsed || parsed.formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION) {
    return { ok: false, reason: "official_fee_schedule_formula_unverifiable" };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const verified = await verifyCurrentFeeArtifact({
    digest,
    policyVersion: STANDING_FEE_POLICY_VERSION,
    sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  }, fetchImpl);
  if (!verified.valid || verified.digest !== digest) {
    return { ok: false, reason: verified.reason ?? "official_fee_schedule_not_verified" };
  }
  return { ok: true, digest };
}