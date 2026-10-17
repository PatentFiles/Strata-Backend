/**
 * Public, read-only live fields for the exact KXBTC15M market, combined with
 * the standing persisted fee-policy approval. Never fetch the fee page.
 */
import {
  approvedFeeSession, STANDING_FEE_POLICY_VERSION,
  type ApprovedFeeSession,
} from "./microLiveFeeApproval";
import {
  beginFeeVerification, feeVerificationAttemptIsPending, finishFeeVerification,
  type FeeVerificationIdentity, type FeeVerificationStatus,
} from "./microLiveFeeVerification";
const API = "https://external-api.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";
const MAX_READ_MS = 10_000;
const MAX_FEE_EXPOSURE_MICROS = 5_000_000;
export const MICRO_LIVE_STANDING_FEE_POLICY_VERSION = STANDING_FEE_POLICY_VERSION;
export const VERIFIED_FEE_MODEL_FINGERPRINT = "approved-standard-0.07-sixdp-nondirect-cash-risk-v2";

export type StandingFeePolicyApproval = {
  id: string;
  digest: string;
  approvedAt: number;
  policyVersion: string;
  maximumExposureMicros: number;
  approvedRunCapMicros: number;
  approvedBy: string;
};

export function standingFeePolicyApprovalIsValid(
  approval: StandingFeePolicyApproval | null | undefined,
  configuredRunCapMicros?: number,
): approval is StandingFeePolicyApproval {
  return Boolean(approval && /^[A-Za-z0-9._:-]{1,128}$/.test(approval.id) &&
    /^[a-f0-9]{64}$/i.test(approval.digest) &&
    Number.isSafeInteger(approval.approvedAt) && approval.approvedAt > 0 &&
    approval.policyVersion === MICRO_LIVE_STANDING_FEE_POLICY_VERSION &&
    Number.isSafeInteger(approval.maximumExposureMicros) &&
    approval.maximumExposureMicros > 0 &&
    approval.maximumExposureMicros <= MAX_FEE_EXPOSURE_MICROS &&
    Number.isSafeInteger(approval.approvedRunCapMicros) &&
    approval.approvedRunCapMicros > 0 &&
    approval.approvedRunCapMicros <= approval.maximumExposureMicros &&
    approval.approvedRunCapMicros <= MAX_FEE_EXPOSURE_MICROS &&
    typeof approval.approvedBy === "string" && approval.approvedBy.trim().length > 0 &&
    (configuredRunCapMicros === undefined ||
      Number.isSafeInteger(configuredRunCapMicros) &&
      configuredRunCapMicros > 0 &&
      configuredRunCapMicros <= approval.approvedRunCapMicros &&
      configuredRunCapMicros <= approval.maximumExposureMicros));
}

function sameStandingApproval(
  left: StandingFeePolicyApproval | null,
  right: Pick<StandingFeePolicyApproval,
    "id" | "digest" | "policyVersion" | "maximumExposureMicros" |
    "approvedRunCapMicros" | "approvedBy"> | null | undefined,
): boolean {
  return Boolean(left && right &&
    left.id === right.id && left.digest === right.digest &&
    left.policyVersion === right.policyVersion &&
    left.maximumExposureMicros === right.maximumExposureMicros &&
    left.approvedRunCapMicros === right.approvedRunCapMicros &&
    left.approvedBy === right.approvedBy);
}

export type EntryFeeTerms = {
  ticker: string;
  eventTicker: string;
  feePerContractMicrosAtLimit: (priceDollars: string, side?: "yes" | "no") => number | null;
  exitFeePerContractMicrosAtLimit: (priceDollars: string, side?: "yes" | "no") => number | null;
  entryCashDebitPerContractMicrosAtLimit?: (
    priceDollars: string, side: "yes" | "no",
  ) => number | null;
  maximumExitLossPerContractMicros?: (side: "yes" | "no") => number | null;
  /** Additional net sell debit, not fees withheld from positive proceeds. */
  maximumExitCashDebitPerContractMicros?: (side: "yes" | "no") => number | null;
  exitCashDebitPerContractMicrosAtLimit?: (price: string, side: "yes" | "no") => number | null;
  validMarketPriceRanges?: readonly { start: string; end: string; step: string }[];
  fingerprint: string;
  verifiedAt: number;
  sessionStartedAt?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function multiplier(value: unknown): { numerator: bigint; denominator: bigint; text: string } | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole!) * denominator + BigInt(fraction || "0");
  if (numerator <= 0n || numerator > 100n * denominator) return null;
  return { numerator, denominator, text };
}

function arrayPage(payload: unknown, key: string, requiresCursor = false): {
  rows: unknown[];
  cursor: string;
} | null {
  const page = record(payload);
  if (!page || !Array.isArray(page[key]) ||
      (requiresCursor ? typeof page.cursor !== "string" :
        page.cursor !== undefined && typeof page.cursor !== "string")) return null;
  return { rows: page[key] as unknown[], cursor: String(page.cursor ?? "") };
}

function canonicalTimestamp(value: unknown, allowMissing = false): number | null {
  if (allowMissing && value === undefined) return null;
  if (allowMissing && value === "0001-01-01T00:00:00Z") return null;
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metadataTimestamp(value: unknown, observedAt: number): number | null {
  const parsed = canonicalTimestamp(value, true);
  if (parsed === null) {
    return value === undefined || value === "0001-01-01T00:00:00Z" ? null : Number.NaN;
  }
  // Allow small server/client clock skew, but never trust future metadata.
  return parsed > observedAt + 60_000 ? Number.NaN : parsed;
}

async function readAllChanges(
  fetchImpl: typeof fetch,
  baseUrl: string,
  key: string,
  requiresCursor: boolean,
): Promise<unknown[] | null> {
  const rows: unknown[] = [];
  let cursor = "";
  const seenCursors = new Set<string>();
  const seenIds = new Set<string>();
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const url = `${baseUrl}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = arrayPage(await json(fetchImpl, url), key, requiresCursor);
    if (!page || rows.length + page.rows.length > 1000) return null;
    for (const row of page.rows) {
      const item = record(row);
      const id = item?.id;
      if (typeof id !== "string" || !id || seenIds.has(id)) return null;
      seenIds.add(id);
      rows.push(item);
    }
    if (!page.cursor) return rows;
    if (seenCursors.has(page.cursor)) return null;
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  return null;
}

type FeeState = { type: string; multiplier: Multiplier | null };
type ScheduledFeeState = {
  id: string;
  at: number;
  state: FeeState | null;
};

function feeState(type: unknown, value: unknown): FeeState | null {
  return typeof type === "string" && type.length > 0 && type.length <= 64
    ? { type, multiplier: multiplier(value) } : null;
}

function pairFeeState(
  type: unknown,
  value: unknown,
  allowClear: boolean,
): FeeState | null | undefined {
  if (allowClear && type === null && value === null) return null;
  if (type == null || value == null) return undefined;
  const state = feeState(type, value);
  return state?.multiplier ? state : undefined;
}

function sameFeeState(left: FeeState | null, right: FeeState | null): boolean {
  return left === null || right === null
    ? left === right
    : left.type === right.type &&
      left.multiplier?.numerator === right.multiplier?.numerator &&
      left.multiplier?.denominator === right.multiplier?.denominator;
}

function parseSeriesChanges(
  rows: unknown[],
): ScheduledFeeState[] | null {
  const parsed: ScheduledFeeState[] = [];
  for (const raw of rows) {
    const row = record(raw);
    const at = canonicalTimestamp(row?.scheduled_ts);
    const state = pairFeeState(row?.fee_type, row?.fee_multiplier, false);
    if (row?.series_ticker !== SERIES || typeof row.id !== "string" || !row.id ||
        at === null || !state) return null;
    parsed.push({ id: row.id, at, state });
  }
  return parsed;
}

function parseEventChanges(
  rows: unknown[],
  eventTicker: string,
): ScheduledFeeState[] | null {
  const parsed: ScheduledFeeState[] = [];
  for (const raw of rows) {
    const row = record(raw);
    const at = canonicalTimestamp(row?.scheduled_ts);
    const state = pairFeeState(row?.fee_type_override,
      row?.fee_multiplier_override, true);
    if (row?.event_ticker !== eventTicker || row.series_ticker !== SERIES ||
        typeof row.id !== "string" || !row.id ||
        at === null || state === undefined) return null;
    parsed.push({ id: row.id, at, state });
  }
  return parsed;
}

function latestStateAt(
  initial: FeeState | null,
  changes: ScheduledFeeState[],
  observedAt: number,
): FeeState | null | undefined {
  const past = changes.filter((change) => change.at <= observedAt)
    .sort((left, right) => left.at - right.at);
  for (let index = 1; index < past.length; index++) {
    if (past[index]!.at === past[index - 1]!.at) return undefined;
  }
  const latest = past.at(-1);
  return latest ? latest.state : initial;
}

function maximumLifecycleMultiplier(
  seriesInitial: FeeState,
  eventInitial: FeeState | null,
  seriesChanges: ScheduledFeeState[],
  eventChanges: ScheduledFeeState[],
  observedAt: number,
  lifecycleEndsAt: number,
): Multiplier | null {
  if (lifecycleEndsAt < observedAt) return null;
  const latestSeries = latestStateAt(seriesInitial, seriesChanges, observedAt);
  const latestEvent = latestStateAt(eventInitial, eventChanges, observedAt);
  if (latestSeries === undefined || latestEvent === undefined ||
      !sameFeeState(latestSeries, seriesInitial) ||
      !sameFeeState(latestEvent, eventInitial)) return null;

  const relevantSeries = seriesChanges.filter((change) =>
    change.at > observedAt && change.at <= lifecycleEndsAt);
  const relevantEvents = eventChanges.filter((change) =>
    change.at > observedAt && change.at <= lifecycleEndsAt);
  const changesByTime = new Map<number, { series?: FeeState; event?: FeeState | null }>();
  for (const change of relevantSeries) {
    const states = changesByTime.get(change.at) ?? {};
    if (states.series) return null;
    states.series = change.state!;
    changesByTime.set(change.at, states);
  }
  for (const change of relevantEvents) {
    const states = changesByTime.get(change.at) ?? {};
    if (Object.hasOwn(states, "event")) return null;
    states.event = change.state;
    changesByTime.set(change.at, states);
  }
  let seriesState: FeeState | null = seriesInitial;
  let eventState: FeeState | null = eventInitial;
  let maximum: Multiplier | null = null;
  const evaluate = () => {
    const effective = eventState ?? seriesState;
    if (!effective || effective.type !== "quadratic" || !effective.multiplier) return false;
    const candidate = effective.multiplier;
    if (!maximum || candidate.numerator * maximum.denominator >
        maximum.numerator * candidate.denominator) maximum = candidate;
    return true;
  };
  if (!evaluate()) return null;
  for (const [at, scheduled] of [...changesByTime.entries()].sort((a, b) => a[0] - b[0])) {
    if (at > lifecycleEndsAt) break;
    if (scheduled.series) seriesState = scheduled.series;
    if (Object.hasOwn(scheduled, "event")) eventState = scheduled.event ?? null;
    if (!evaluate()) return null;
  }
  return maximum;
}

async function json(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(MAX_READ_MS),
    });
  } catch {
    throw new FeeEvidenceUnavailableError("kalshi_fee_evidence_unavailable");
  }
  // Never accept redirected data from another host or path for live fee sizing.
  if (!response.ok || (response.url && response.url !== url))
    throw new FeeEvidenceUnavailableError("kalshi_fee_evidence_unavailable");
  try {
    return await response.json();
  } catch {
    throw new FeeEvidenceInvalidError("kalshi_fee_evidence_unparseable");
  }
}

class FeeEvidenceUnavailableError extends Error {}
class FeeEvidenceInvalidError extends Error {}

function rejectFeeEvidence(reason: string): never {
  throw new FeeEvidenceInvalidError(reason);
}

function priceTick(priceDollars: string): number | null {
  if (!/^(?:0?\.\d{1,4})$/.test(priceDollars)) return null;
  const [whole, fraction = ""] = priceDollars.split(".");
  const tick = Number(whole) * 10_000 + Number(fraction.padEnd(4, "0"));
  return Number.isSafeInteger(tick) && tick > 0 && tick < 10_000 ? tick : null;
}

type Multiplier = { numerator: bigint; denominator: bigint; text: string };
type PriceRangeTicks = { start: number; end: number; step: number };
const BALANCE_ALIGNMENT_MICROS = 10_000n;
const MICRO_CONTRACT_FILLS_PER_CONTRACT = 100n;
const FULL_ORDERABLE_PRICE_TICKS = Array.from({ length: 9_999 }, (_, i) => i + 1);

function fixedFourDecimalTick(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d)\.(\d{4})$/.exec(value);
  if (!match) return null;
  const tick = Number(match[1]) * 10_000 + Number(match[2]);
  return Number.isSafeInteger(tick) && tick >= 0 && tick <= 10_000 ? tick : null;
}

function parsePriceRanges(value: unknown): {
  ranges: PriceRangeTicks[];
  orderableTicks: number[];
  fingerprintValue: string;
} | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const ranges: PriceRangeTicks[] = [];
  const ticks = new Set<number>();
  let previousEnd = -1;
  for (const item of value) {
    const band = record(item);
    if (!band) return null;
    const start = fixedFourDecimalTick(band.start);
    const end = fixedFourDecimalTick(band.end);
    const stepText = typeof band.step === "string" ? band.step : null;
    const step = stepText && /^\d\.\d{4}$/.test(stepText)
      ? fixedFourDecimalTick(stepText) : null;
    if (start === null || end === null || step === null || step === 0 ||
        start > end || start < previousEnd || (end - start) % step !== 0) return null;
    ranges.push({
      start, end, step,
    });
    for (let tick = start; tick <= end; tick += step) ticks.add(tick);
    previousEnd = end;
  }
  const orderableTicks = [...ticks].filter((tick) => tick > 0 && tick < 10_000).sort((a, b) => a - b);
  if (orderableTicks.length === 0) return null;
  return {
    ranges,
    orderableTicks,
    fingerprintValue: ranges.map(({ start, end, step }) =>
      `${start}:${end}:${step}`).join(","),
  };
}

function sidePriceTicks(marketTicks: readonly number[], side: "yes" | "no"): number[] {
  return side === "yes" ? [...marketTicks] :
    marketTicks.map((tick) => 10_000 - tick).filter((tick) => tick > 0 && tick < 10_000)
      .sort((a, b) => a - b);
}

function validLimitTick(
  priceDollars: string,
  marketTicks: readonly number[],
  side: "yes" | "no",
): number | null {
  const tick = priceTick(priceDollars);
  return tick !== null && sidePriceTicks(marketTicks, side).includes(tick) ? tick : null;
}

function floorToBalancePrecision(amountMicros: bigint): bigint {
  return amountMicros >= 0n
    ? amountMicros / BALANCE_ALIGNMENT_MICROS * BALANCE_ALIGNMENT_MICROS
    : -((-amountMicros + BALANCE_ALIGNMENT_MICROS - 1n) /
      BALANCE_ALIGNMENT_MICROS) * BALANCE_ALIGNMENT_MICROS;
}

function feeAtPriceTick(
  m: Multiplier,
  tick: number,
): bigint | null {
  if (!Number.isSafeInteger(tick) || tick <= 0 || tick >= 10_000) return null;
  // 0.07 * multiplier * 0.01 contracts * p * (1-p), in micro-dollars.
  const feeNumerator = 700n * m.numerator * BigInt(tick) * BigInt(10_000 - tick);
  const feeDenominator = m.denominator * 100_000_000n;
  // The model fee is rounded UP to six decimal places ($0.000001).
  return (feeNumerator + feeDenominator - 1n) / feeDenominator;
}

function sumHundredWorstFills(maximumPerFillMicros: bigint): number | null {
  const bound = maximumPerFillMicros * MICRO_CONTRACT_FILLS_PER_CONTRACT;
  return bound >= 0n && bound <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bound) : null;
}

/**
 * Bound a whole contract across all possible buy execution prices up to the
 * submitted limit, allowing 100 independently rounded 0.01-contract fills.
 */
function maximumEntryTradeFee(
  m: Multiplier,
  marketTicks: readonly number[],
  limitTick: number,
  side: "yes" | "no",
): number | null {
  let maximum = 0n;
  for (const tick of sidePriceTicks(marketTicks, side)) {
    if (tick > limitTick) break;
    const fee = feeAtPriceTick(m, tick);
    if (fee === null) return null;
    if (fee > maximum) maximum = fee;
  }
  return sumHundredWorstFills(maximum);
}

function maximumEntryCashDebit(
  m: Multiplier,
  marketTicks: readonly number[],
  limitTick: number,
  side: "yes" | "no",
): number | null {
  let maximumPerFill = 0n;
  for (const tick of sidePriceTicks(marketTicks, side)) {
    if (tick > limitTick) break;
    const fee = feeAtPriceTick(m, tick);
    if (fee === null) return null;
    // Each independent 0.01 fill's signed buyer revenue is negative. Include
    // model fee before flooring to the conservative non-direct cent grid.
    const debit = -floorToBalancePrecision(-BigInt(tick) - fee);
    if (debit > maximumPerFill) maximumPerFill = debit;
  }
  return maximumPerFill > 0n ? sumHundredWorstFills(maximumPerFill) : null;
}

/**
 * Grid-aware, read-only bound for one whole contract's entry cash debit.
 * `priceRanges` is the selected market's public `price_ranges` field.
 */
export function maximumEntryCashDebitPerContractMicros(
  value: unknown,
  priceDollars: string,
  priceRanges: unknown,
  side: "yes" | "no" = "yes",
): number | null {
  const m = multiplier(value);
  const parsed = parsePriceRanges(priceRanges);
  if (!m || !parsed) return null;
  const limitTick = validLimitTick(priceDollars, parsed.orderableTicks, side);
  return limitTick === null
    ? null : maximumEntryCashDebit(m, parsed.orderableTicks, limitTick, side);
}

function sellLossPerFill(m: Multiplier, tick: number): bigint | null {
  const fee = feeAtPriceTick(m, tick);
  if (fee === null) return null;
  const grossProceedsMicros = BigInt(tick);
  const netAlignedProceeds = floorToBalancePrecision(grossProceedsMicros - fee);
  // Keep this as lost proceeds (trade fee + balance-alignment reduction),
  // not as a second debit of the gross sell amount.
  const loss = grossProceedsMicros - netAlignedProceeds;
  return loss > 0n ? loss : null;
}

function maximumExitLoss(
  m: Multiplier,
  marketTicks: readonly number[],
  limitTick: number | null,
  side: "yes" | "no",
): number | null {
  let maximumPerFill = 0n;
  for (const tick of sidePriceTicks(marketTicks, side)) {
    if (limitTick !== null && tick < limitTick) continue;
    const loss = sellLossPerFill(m, tick);
    if (loss === null) return null;
    if (loss > maximumPerFill) maximumPerFill = loss;
  }
  return maximumPerFill > 0n ? sumHundredWorstFills(maximumPerFill) : null;
}

/** A nonnegative sell cash flow requires no additional starting cash. */
function maximumExitCashDebit(
  m: Multiplier, marketTicks: readonly number[], limit: number | null, side: "yes" | "no",
): number | null {
  let maximum = 0n;
  for (const tick of sidePriceTicks(marketTicks, side)) {
    if (limit !== null && tick < limit) continue;
    const fee = feeAtPriceTick(m, tick);
    if (fee === null) return null;
    const debit = -floorToBalancePrecision(BigInt(tick) - fee);
    if (debit > maximum) maximum = debit;
  }
  return sumHundredWorstFills(maximum);
}

export function maximumExitCashDebitOnMarketGridPerContractMicros(
  value: unknown, priceRanges: unknown, side: "yes" | "no" = "yes", price?: string,
): number | null {
  const m = multiplier(value);
  const parsed = parsePriceRanges(priceRanges);
  if (!m || !parsed) return null;
  const limit = price === undefined ? null : validLimitTick(price, parsed.orderableTicks, side);
  if (price !== undefined && limit === null) return null;
  return maximumExitCashDebit(m, parsed.orderableTicks, limit, side);
}

/** Persisted approval identity, current exposure policy, grid, and model. */
export function feeEvidenceMatchesApproval(
  fingerprint: string,
  approval: Pick<StandingFeePolicyApproval, "id" | "digest"> &
    Partial<Omit<StandingFeePolicyApproval, "id" | "digest">> | null,
): boolean {
  if (!approval) return false;
  const fields = fingerprint.split("|");
  const maximumExposure = Number(fields.at(-5));
  const approvedRunCap = Number(fields.at(-4));
  const policyVersion = fields.at(-6);
  const approvedBy = fields.at(-3);
  return fields.length >= 9 && fields.at(-8) === approval.id &&
    fields.at(-7) === approval.digest &&
    policyVersion === MICRO_LIVE_STANDING_FEE_POLICY_VERSION &&
    Number.isSafeInteger(maximumExposure) && maximumExposure > 0 &&
    maximumExposure <= MAX_FEE_EXPOSURE_MICROS &&
    Number.isSafeInteger(approvedRunCap) && approvedRunCap > 0 &&
    approvedRunCap <= maximumExposure &&
    approvedRunCap <= MAX_FEE_EXPOSURE_MICROS &&
    typeof approvedBy === "string" && approvedBy.length > 0 &&
    fields.at(-2) !== "" && fields.at(-1) === VERIFIED_FEE_MODEL_FINGERPRINT &&
    (approval.policyVersion === undefined || approval.policyVersion === policyVersion) &&
    (approval.maximumExposureMicros === undefined ||
      approval.maximumExposureMicros === maximumExposure) &&
    (approval.approvedRunCapMicros === undefined ||
      approval.approvedRunCapMicros === approvedRunCap) &&
    (approval.approvedBy === undefined || approval.approvedBy === approvedBy);
}

/**
 * Exit fees may be recomputed from changed live series metadata, but only for
 * the same market and event under the same standing approval and fee model.
 */
export function feeEvidenceMatchesMarketIdentity(
  entryFingerprint: string,
  currentFingerprint: string,
  approval: StandingFeePolicyApproval | null,
): boolean {
  if (!feeEvidenceMatchesApproval(entryFingerprint, approval) ||
      !feeEvidenceMatchesApproval(currentFingerprint, approval)) return false;
  const entry = entryFingerprint.split("|");
  const current = currentFingerprint.split("|");
  return /^KXBTC15M-[A-Za-z0-9-]+$/.test(entry[0] ?? "") &&
    entry[0] === current[0] &&
    /^KXBTC15M-[A-Za-z0-9-]+$/.test(entry[1] ?? "") &&
    entry[1] === current[1];
}

/** Grid-aware bound for an unrestricted future one-contract sell exit. */
export function maximumExitLossOnMarketGridPerContractMicros(
  value: unknown,
  priceRanges: unknown,
  side: "yes" | "no" = "yes",
): number | null {
  const m = multiplier(value);
  const parsed = parsePriceRanges(priceRanges);
  return !m || !parsed ? null : maximumExitLoss(m, parsed.orderableTicks, null, side);
}

/** Grid-aware bound for a one-contract sell whose price is at/above its limit. */
export function maximumExitLossAtLimitOnMarketGridPerContractMicros(
  value: unknown,
  priceDollars: string,
  priceRanges: unknown,
  side: "yes" | "no" = "yes",
): number | null {
  const m = multiplier(value);
  const parsed = parsePriceRanges(priceRanges);
  if (!m || !parsed) return null;
  const limitTick = validLimitTick(priceDollars, parsed.orderableTicks, side);
  return limitTick === null
    ? null : maximumExitLoss(m, parsed.orderableTicks, limitTick, side);
}

/**
 * Formula-only helper; live terms always pass the verified market's actual
 * price grid. A 0.01 fill is evaluated independently, without rebate credit.
 */
export function maximumEntryFeePerContractMicros(
  value: unknown,
  priceDollars: string,
  marketTicks: readonly number[] = FULL_ORDERABLE_PRICE_TICKS,
  side: "yes" | "no" = "yes",
): number | null {
  const limitTick = priceTick(priceDollars);
  const m = multiplier(value);
  if (!m || limitTick === null || !sidePriceTicks(marketTicks, side).includes(limitTick)) return null;
  return maximumEntryTradeFee(m, marketTicks, limitTick, side);
}

/** Formula-only helper; live terms pass the selected market's verified grid. */
export function maximumExitFeePerContractAtLimitMicros(
  value: unknown,
  priceDollars: string,
  marketTicks: readonly number[] = FULL_ORDERABLE_PRICE_TICKS,
  side: "yes" | "no" = "yes",
): number | null {
  const limitTick = priceTick(priceDollars);
  const m = multiplier(value);
  if (!m || limitTick === null || !sidePriceTicks(marketTicks, side).includes(limitTick)) return null;
  return maximumExitLoss(m, marketTicks, limitTick, side);
}

/**
 * Formula-only helper for every possible price on the full four-decimal grid.
 */
export function maximumExitFeePerContractMicros(
  value: unknown,
  marketTicks: readonly number[] = FULL_ORDERABLE_PRICE_TICKS,
  side: "yes" | "no" = "yes",
): number | null {
  const m = multiplier(value);
  return m ? maximumExitLoss(m, marketTicks, null, side) : null;
}

/** Fee-free baseline for isolated legacy fixtures; live caps use the fee-inclusive, market-grid bound. */
export function entryCashDebitMicrosForContracts(
  priceDollars: string,
  contracts: number,
): number | null {
  const tick = priceTick(priceDollars);
  if (tick === null || !Number.isSafeInteger(contracts) || contracts < 1) return null;
  const debitPerHundredth = ((BigInt(tick) + 9_999n) / 10_000n) * 10_000n;
  const total = debitPerHundredth * 100n * BigInt(contracts);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

export function feeBoundForContracts(perContractMicros: number, contracts: number): number | null {
  if (!Number.isSafeInteger(perContractMicros) || perContractMicros < 0 ||
      !Number.isSafeInteger(contracts) || contracts < 1) return null;
  const total = BigInt(perContractMicros) * BigInt(contracts);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

export async function readCurrentEntryFeeTerms(
  ticker: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  requiredApproval?: Pick<StandingFeePolicyApproval,
    "id" | "digest" | "policyVersion" | "maximumExposureMicros" |
    "approvedRunCapMicros" | "approvedBy">,
): Promise<EntryFeeTerms | null> {
  if (!/^KXBTC15M-[A-Za-z0-9-]+$/.test(ticker)) return null;
  let approval: ApprovedFeeSession | null;
  try {
    approval = await approvedFeeSession();
  } catch {
    return null;
  }
  if (!standingFeePolicyApprovalIsValid(approval) ||
      requiredApproval && !sameStandingApproval(approval, requiredApproval)) return null;
  const identity: FeeVerificationIdentity = {
    approvalId: approval.id,
    approvalDigest: approval.digest,
    policyVersion: approval.policyVersion,
    sourceUrl: approval.sourceUrl,
    formulaVersion: approval.formulaVersion,
  };
  const attemptId = await beginFeeVerification(identity);
  if (!attemptId) return null;
  let terms: EntryFeeTerms | null = null;
  let status: Exclude<FeeVerificationStatus, "pending"> = "unavailable";
  let reason: string | null = "live_fee_evidence_unavailable_or_stale";
  try {
    terms = await readCurrentEntryFeeTermsCore(ticker, fetchImpl, approval, identity, attemptId);
    if (terms) {
      status = "verified";
      reason = null;
    }
  } catch (error) {
    if (error instanceof FeeEvidenceUnavailableError) {
      status = "unavailable";
      reason = error.message;
    } else {
      status = "invalid";
      reason = error instanceof FeeEvidenceInvalidError
        ? error.message : "live_fee_evidence_verification_error";
    }
  }
  if (!await finishFeeVerification(identity, attemptId, status, reason,
      status === "verified" && terms ? terms.fingerprint : null,
      status === "verified" && terms ? new Date(terms.verifiedAt) : new Date())) return null;
  if (status !== "verified" || !terms) return null;
  try {
    const finalApproval = await approvedFeeSession();
    return standingFeePolicyApprovalIsValid(finalApproval) &&
      sameStandingApproval(finalApproval, approval) ? terms : null;
  } catch {
    return null;
  }
}

async function readCurrentEntryFeeTermsCore(
  ticker: string,
  fetchImpl: typeof fetch,
  approval: ApprovedFeeSession,
  identity: FeeVerificationIdentity,
  attemptId: string,
): Promise<EntryFeeTerms | null> {
  const started = Date.now();
  try {
    const listing = record(await json(fetchImpl,
      `${API}/markets?series_ticker=${SERIES}&status=open&limit=100`));
    if (!listing || !Array.isArray(listing.markets) || listing.cursor) {
      return rejectFeeEvidence("open_market_listing_incomplete");
    }
    const open = listing.markets.map(record).filter((m): m is Record<string, unknown> =>
      m !== null && (m.status === "open" || m.status === "active") &&
      (m.exchange_index === undefined || m.exchange_index === 2) &&
      typeof m.close_time === "string" && Date.parse(m.close_time) > Date.now())
      .sort((a, b) => Date.parse(String(a.close_time)) - Date.parse(String(b.close_time)));
    if (open[0]?.ticker !== ticker || open.some((m, i) =>
      i > 0 && m.close_time === open[0]?.close_time)) {
      return rejectFeeEvidence("target_market_not_unique_earliest_open_market");
    }
    const listingGrid = parsePriceRanges(open[0]?.price_ranges);
    if (!listingGrid) return rejectFeeEvidence("market_price_grid_invalid");
    const market = record((record(await json(fetchImpl,
      `${API}/markets/${encodeURIComponent(ticker)}`)) ?? {}).market);
    const marketGrid = parsePriceRanges(market?.price_ranges);
    if (!marketGrid || marketGrid.fingerprintValue !== listingGrid.fingerprintValue) {
      return rejectFeeEvidence("market_price_grid_conflict");
    }
    const eventTicker = market?.event_ticker;
    if (market?.ticker !== ticker || market?.status !== open[0]?.status ||
        (market.exchange_index !== undefined && market.exchange_index !== 2) ||
        market?.close_time !== open[0]?.close_time ||
        market?.event_ticker !== open[0]?.event_ticker ||
        typeof eventTicker !== "string" ||
         !/^KXBTC15M-[A-Za-z0-9-]+$/.test(eventTicker)) {
      return rejectFeeEvidence("market_event_identity_conflict");
    }
    const closeAt = canonicalTimestamp(market.close_time);
    const expirationAt = canonicalTimestamp(market.expiration_time);
    const latestExpirationAt = canonicalTimestamp(market.latest_expiration_time);
    const expectedExpirationAt = canonicalTimestamp(market.expected_expiration_time);
    if (closeAt === null || expirationAt === null ||
        latestExpirationAt === null || expectedExpirationAt === null ||
        expirationAt < closeAt || latestExpirationAt < closeAt ||
        expectedExpirationAt < closeAt) {
      return rejectFeeEvidence("market_lifecycle_metadata_invalid");
    }
    const lifecycleEndsAt = Math.max(
      closeAt, expirationAt, latestExpirationAt, expectedExpirationAt,
    );
    // The public market currently inherits its fee model. If a market-level
    // fee field appears, do not assume the approved standard formula applies.
    const feeFields = (item: Record<string, unknown>) =>
      Object.keys(item).filter((key) => /fee|rebate/i.test(key)).sort()
        .map((key) => [key, item[key]]);
    if (JSON.stringify(feeFields(market)) !== JSON.stringify(feeFields(open[0]!)) ||
        feeFields(market).some(([, value]) => value != null && value !== false)) {
      return rejectFeeEvidence("market_level_fee_override_unsupported");
    }

    const series = record((record(await json(fetchImpl, `${API}/series/${SERIES}`)) ?? {}).series);
    const event = record((record(await json(fetchImpl,
      `${API}/events/${encodeURIComponent(eventTicker)}`)) ?? {}).event);
    const observedAt = Date.now();
    const seriesTimestamp = metadataTimestamp(series?.last_updated_ts, observedAt);
    const eventTimestamp = metadataTimestamp(event?.last_updated_ts, observedAt);
    const currentSeriesState = series?.ticker === SERIES
      ? pairFeeState(series.fee_type, series.fee_multiplier, false) : undefined;
    const currentEventState = event?.event_ticker === eventTicker &&
      event?.series_ticker === SERIES
      ? pairFeeState(event.fee_type_override, event.fee_multiplier_override, true)
      : undefined;
    if (series?.exchange_index !== 2 ||
        (event?.exchange_index !== undefined && event.exchange_index !== 2) ||
        seriesTimestamp !== null && !Number.isFinite(seriesTimestamp) ||
        eventTimestamp !== null && !Number.isFinite(eventTimestamp) ||
        !currentSeriesState || currentEventState === undefined) {
      return rejectFeeEvidence("series_or_event_fee_metadata_invalid");
    }

    const seriesChanges = await readAllChanges(fetchImpl,
      `${API}/series/fee_changes?series_ticker=${SERIES}&show_historical=false&limit=100`,
    "series_fee_change_arr", false);
    const eventChanges = await readAllChanges(fetchImpl,
      `${API}/events/fee_changes?event_ticker=${encodeURIComponent(eventTicker)}&show_historical=false&limit=100`,
    "event_fee_changes", true);
    if (!seriesChanges || !eventChanges) {
      return rejectFeeEvidence("fee_change_history_incomplete");
    }
    const parsedSeriesChanges = parseSeriesChanges(seriesChanges);
    const parsedEventChanges = parseEventChanges(eventChanges, eventTicker);
    if (!parsedSeriesChanges || !parsedEventChanges) {
      return rejectFeeEvidence("fee_change_history_invalid");
    }
    const effectiveMultiplier = maximumLifecycleMultiplier(
      currentSeriesState, currentEventState, parsedSeriesChanges, parsedEventChanges,
      observedAt, lifecycleEndsAt,
    );
    if (!effectiveMultiplier) return rejectFeeEvidence("effective_fee_model_unsupported");

    if (!await feeVerificationAttemptIsPending(identity, attemptId)) return null;
    const verifiedAt = Date.now();
    if (verifiedAt - started > MAX_READ_MS || verifiedAt - started > 15_000 ||
        verifiedAt >= closeAt || verifiedAt >= lifecycleEndsAt) {
      return rejectFeeEvidence("fee_evidence_stale_or_expired");
    }
    return {
      ticker, eventTicker, verifiedAt,
      sessionStartedAt: approval.approvedAt,
      validMarketPriceRanges: marketGrid.ranges.map((range) => ({
        start: (range.start / 10_000).toFixed(4),
        end: (range.end / 10_000).toFixed(4),
        step: (range.step / 10_000).toFixed(4),
      })),
      feePerContractMicrosAtLimit: (priceDollars, side = "yes") => {
        const limitTick = validLimitTick(priceDollars, marketGrid.orderableTicks, side);
        return limitTick === null ? null : maximumEntryTradeFee(
          effectiveMultiplier, marketGrid.orderableTicks, limitTick, side,
        );
      },
      exitFeePerContractMicrosAtLimit: (priceDollars, side = "yes") => {
        const limitTick = validLimitTick(priceDollars, marketGrid.orderableTicks, side);
        return limitTick === null ? null : maximumExitLoss(
          effectiveMultiplier, marketGrid.orderableTicks, limitTick, side,
        );
      },
      entryCashDebitPerContractMicrosAtLimit: (priceDollars, side) => {
        const limitTick = validLimitTick(priceDollars, marketGrid.orderableTicks, side);
        return limitTick === null ? null : maximumEntryCashDebit(
          effectiveMultiplier, marketGrid.orderableTicks, limitTick, side,
        );
      },
      maximumExitLossPerContractMicros: (side) => maximumExitLoss(
        effectiveMultiplier, marketGrid.orderableTicks, null, side,
      ),
      maximumExitCashDebitPerContractMicros: (side) => maximumExitCashDebit(
        effectiveMultiplier, marketGrid.orderableTicks, null, side,
      ),
      exitCashDebitPerContractMicrosAtLimit: (price, side) => {
        const limit = validLimitTick(price, marketGrid.orderableTicks, side);
        return limit === null ? null : maximumExitCashDebit(
          effectiveMultiplier, marketGrid.orderableTicks, limit, side,
        );
      },
      fingerprint: [
        ticker, eventTicker, market.status, market.close_time,
        String(seriesTimestamp ?? ""), currentSeriesState.type,
        `${currentSeriesState.multiplier!.numerator}/${currentSeriesState.multiplier!.denominator}`,
        String(eventTimestamp ?? ""),
        currentEventState?.type ?? "", currentEventState?.multiplier
          ? `${currentEventState.multiplier.numerator}/${currentEventState.multiplier.denominator}` : "",
        lifecycleEndsAt,
        ...parsedSeriesChanges.sort((a, b) => a.at - b.at)
          .map((change) => `series:${change.id}:${change.at}:${change.state!.type}:` +
            `${change.state!.multiplier!.numerator}/${change.state!.multiplier!.denominator}`),
        ...parsedEventChanges.sort((a, b) => a.at - b.at)
          .map((change) => `event:${change.id}:${change.at}:` +
            `${change.state?.type ?? "clear"}:` +
            `${change.state?.multiplier
              ? `${change.state.multiplier.numerator}/${change.state.multiplier.denominator}` : ""}`),
        `max:${effectiveMultiplier.numerator}/${effectiveMultiplier.denominator}`,
         approval.id, approval.digest, approval.policyVersion,
         String(approval.maximumExposureMicros), String(approval.approvedRunCapMicros),
         approval.approvedBy, marketGrid.fingerprintValue, VERIFIED_FEE_MODEL_FINGERPRINT,
      ].join("|"),
    };
  } catch (error) {
    throw error;
  }
}