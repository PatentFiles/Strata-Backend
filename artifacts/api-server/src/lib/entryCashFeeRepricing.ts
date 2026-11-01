import {
  maximumEntryCashDebitPerContractMicros,
  maximumEntryFeePerContractMicros,
  maximumExitFeePerContractMicros,
} from "./microLiveEntryFees";
import { cashRiskFeeFingerprint, validEntryCashRisk } from "./v13EntryCashRisk";
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
function bounds(grid: ParsedGrid, side: "YES" | "NO", price: number): Bounds | null {
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
  const original = bounds(parsed, fee.cashRisk.side, fee.limitPrice);
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
export function repriceVerifiedEntryFee(
  fee: V13VerifiedFeeEvidence,
  grid: unknown,
  contracts: number,
  limitPrice: number,
): V13VerifiedFeeEvidence | null {
  if (!Number.isSafeInteger(contracts) || contracts < 1 || contracts > 999999999) return null;
  const parsed = verifiedGrid(fee, grid);
  if (!parsed || !fee.cashRisk) return null;
  const selected = bounds(parsed, fee.cashRisk.side, limitPrice);
  if (!selected || selected.cash !== fee.cashRisk.entryCashDebitPerContractMicros ||
      selected.exit !== fee.cashRisk.exitLossPerContractMicros) return null;
  const cents = (per: number) => Number((BigInt(per) * BigInt(contracts) + 9999n) / 10000n);
  // Clone, rather than mutate or retain an alias to the original grid receipt.
  const result: V13VerifiedFeeEvidence = structuredClone(fee);
  result.contracts = contracts;
  result.limitPrice = limitPrice;
  result.cashRisk = { ...result.cashRisk!, entryCashDebitPerContractMicros: selected.cash,
    entryTradeFeePerContractMicros: selected.trade, exitLossPerContractMicros: selected.exit };
  result.reservedEntryFeeCents = cents(selected.trade);
  result.reservedExitFeeCents = cents(selected.exit);
  result.fingerprint = cashRiskFeeFingerprint(result);
  return validEntryCashRisk(result) ? result : null;
}
