import {prepareDirectPrecisionBounds} from './directPrecisionCashBounds';
import {
  maximumEntryCashDebitPerContractMicros,
  maximumEntryFeePerContractMicros,
  maximumExitFeePerContractMicros,
} from "./microLiveEntryFees";
import { DIRECT_ENTRY_CASH_RISK_VERSION, cashRiskFeeFingerprint, validEntryCashRisk } from "./v13EntryCashRisk";
import { digest } from "./v13-production/types";
import type { V13VerifiedFeeEvidence } from "./v13LiveMoneyEntryPreflight";

/** Price-grid data only. Approval, current metadata, source age and market/side
 * authority still come from the existing verified owned reader and its caller. */
export type EntryFeePriceGrid = {
  structure: "deci_cent" | "tapered_deci_cent";
  ranges: Array<{ start: string; end: string; step: string }>;
};
type ParsedGrid = { evidence: EntryFeePriceGrid; ticks: number[] };
type Bounds = { cash: number; trade: number; exit: number };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function gridTick(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0\.\d{4}|1\.0000)$/.test(value)) return null;
  return Number(value[0]) * 10000 + Number(value.slice(2));
}
function parseGrid(value: unknown): ParsedGrid | null {
  if (!record(value) || !exactKeys(value, ["structure", "ranges"]) ||
      (value.structure !== "deci_cent" && value.structure !== "tapered_deci_cent") ||
      !Array.isArray(value.ranges) || value.ranges.length < 1 || value.ranges.length > 100) return null;
  const ticks = new Set<number>();
  const ranges: EntryFeePriceGrid["ranges"] = [];
  let previousEnd = -1;
  for (const raw of value.ranges) {
    if (!record(raw) || !exactKeys(raw, ["start", "end", "step"])) return null;
    const start = gridTick(raw.start), end = gridTick(raw.end), step = gridTick(raw.step);
    if (start === null || end === null || step === null || step === 0 ||
        start > end || start < previousEnd || (end - start) % step !== 0) return null;
    previousEnd = end;
    ranges.push({ start: raw.start as string, end: raw.end as string, step: raw.step as string });
    // Nonoverlapping bounded [0,10000] integer bands limit this loop to at most
    // 10000 ticks plus 100 shared endpoints, not an input-sized allocation.
    for (let tick = start; tick <= end; tick += step) {
      if (tick > 0 && tick < 10000) ticks.add(tick);
    }
  }
  if (!ticks.size) return null;
  return { evidence: { structure: value.structure, ranges }, ticks: [...ticks].sort((a, b) => a - b) };
}
function priceText(price: number): string | null {
  if (!Number.isFinite(price) || price <= 0 || price >= 1 ||
      Math.abs(price * 10000 - Math.round(price * 10000)) > 1e-8) return null;
  return price.toFixed(4);
}
function bounds(grid: ParsedGrid, side: "YES" | "NO", price: number, direct=false): Bounds | null {
  if(direct)return prepareDirectPrecisionBounds(grid.ticks,side)?.(price)??null;
  const limit = priceText(price);
  if (limit === null) return null;
  const selectedSide = side === "YES" ? "yes" : "no";
  const cash = maximumEntryCashDebitPerContractMicros(1, limit, grid.evidence.ranges, selectedSide);
  const trade = maximumEntryFeePerContractMicros(1, limit, grid.ticks, selectedSide);
  const exit = maximumExitFeePerContractMicros(1, grid.ticks, selectedSide);
  return cash === null || trade === null || exit === null ? null : { cash, trade, exit };
}
function verifiedGrid(fee: V13VerifiedFeeEvidence, value: unknown): ParsedGrid | null {
  if (!fee || !validEntryCashRisk(fee) || !Number.isSafeInteger(fee.verifiedAtMs) || fee.verifiedAtMs < 0) return null;
  const parsed = parseGrid(value);
  if (!parsed || digest(parsed.evidence) !== fee.cashRisk.gridDigest) return null;
  // A matching checksum alone is insufficient. Recompute the OLD basis first;
  // never borrow an internally consistent but under-reserved fee receipt.
  const original = bounds(parsed, fee.cashRisk.side, fee.limitPrice,fee.cashRisk.version===DIRECT_ENTRY_CASH_RISK_VERSION);
  if (!original || original.cash !== fee.cashRisk.entryCashDebitPerContractMicros ||
      original.trade !== fee.cashRisk.entryTradeFeePerContractMicros ||
      original.exit !== fee.cashRisk.exitLossPerContractMicros) return null;
  return parsed;
}

export function validEntryFeePriceGrid(fee: V13VerifiedFeeEvidence, grid: unknown): boolean {
  return verifiedGrid(fee, grid) !== null;
}

/** PREPARE-only arithmetic for the newly selected whole count/limit, under the
 * SAME independently verified model/grid. This neither supplies depth nor
 * authorizes selection, reprices a persisted request, resets a clock or renews
 * an approval. Missing historical grid evidence is never reconstructed. */
/** Invocation-local arithmetic only. Capture independent input bytes before
 * returning a repricer; caller mutation cannot change the verified basis. No
 * provider/authority result is cached and this closure never samples a clock. */
export function prepareVerifiedEntryFeeRepricing(
  fee: V13VerifiedFeeEvidence,
  grid: unknown,
): ((contracts: number, limitPrice: number) => V13VerifiedFeeEvidence | null) | null {
  const parsed = verifiedGrid(fee, grid);
  if (!parsed || !fee.cashRisk) return null;
  const basis = structuredClone(fee);
  const direct=basis.cashRisk!.version===DIRECT_ENTRY_CASH_RISK_VERSION;
  const directBounds=direct?prepareDirectPrecisionBounds(parsed.ticks,basis.cashRisk!.side):null;
  if(direct&&!directBounds)return null;
  return (contracts, limitPrice) => {
    if (!Number.isSafeInteger(contracts) || contracts < 1 || contracts > 999999999) return null;
    const selected = direct?directBounds!(limitPrice):bounds(parsed, basis.cashRisk!.side, limitPrice);
    if (!selected || (!direct&&selected.cash !== basis.cashRisk!.entryCashDebitPerContractMicros) ||
        selected.exit !== basis.cashRisk!.exitLossPerContractMicros) return null;
    const cents = (per: number) => Number((BigInt(per) * BigInt(contracts) + 9999n) / 10000n);
    const result: V13VerifiedFeeEvidence = structuredClone(basis);
    result.contracts = contracts;
    result.limitPrice = limitPrice;
    result.cashRisk = { ...result.cashRisk!, entryCashDebitPerContractMicros: selected.cash,
      entryTradeFeePerContractMicros: selected.trade, exitLossPerContractMicros: selected.exit };
    result.reservedEntryFeeCents = cents(selected.trade);
    result.reservedExitFeeCents = cents(selected.exit);
    result.fingerprint = cashRiskFeeFingerprint(result);
    return validEntryCashRisk(result) ? result : null;
  };
}

export function repriceVerifiedEntryFee(
  fee: V13VerifiedFeeEvidence,
  grid: unknown,
  contracts: number,
  limitPrice: number,
): V13VerifiedFeeEvidence | null {
  if (!Number.isSafeInteger(contracts) || contracts < 1 || contracts > 999999999) return null;
  return prepareVerifiedEntryFeeRepricing(fee, grid)?.(contracts, limitPrice) ?? null;
}
