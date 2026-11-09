import test from "node:test";
import assert from "node:assert/strict";
import { repriceVerifiedEntryFee, validEntryFeePriceGrid, type EntryFeePriceGrid } from "./entryCashFeeRepricing";
import { maximumEntryCashDebitPerContractMicros, maximumEntryFeePerContractMicros,
  maximumExitFeePerContractMicros } from "./microLiveEntryFees";
import { ENTRY_CASH_RISK_VERSION, cashRiskFeeFingerprint, cashRiskModelFingerprint,
  entryCashProof, validEntryCashRisk } from "./v13EntryCashRisk";
import { digest } from "./v13-production/types";
import type { V13VerifiedFeeEvidence } from "./v13LiveMoneyEntryPreflight";

const full: EntryFeePriceGrid = { structure: "deci_cent", ranges: [{ start: "0.0000", end: "1.0000", step: "0.0001" }] };
const tapered: EntryFeePriceGrid = { structure: "tapered_deci_cent", ranges: [
  { start: "0.0000", end: "0.1000", step: "0.0010" },
  { start: "0.1000", end: "0.9000", step: "0.0100" },
  { start: "0.9000", end: "1.0000", step: "0.0010" },
] };
function ticks(grid: EntryFeePriceGrid): number[] {
  const values = new Set<number>();
  for (const r of grid.ranges) for (let t = Math.round(Number(r.start) * 10000);
    t <= Math.round(Number(r.end) * 10000); t += Math.round(Number(r.step) * 10000)) {
    if (t > 0 && t < 10000) values.add(t);
  }
  return [...values].sort((a, b) => a - b);
}
function fixture(grid = full, side: "YES" | "NO" = "YES", price = .37): V13VerifiedFeeEvidence {
  const identity = { version: ENTRY_CASH_RISK_VERSION, marketTicker: "KXBTC15M-TEST-000", side,
    policyHash: "a".repeat(64), artifactDigest: "b".repeat(64), feeMetadataDigest: "c".repeat(64),
    seriesDigest: "d".repeat(64), gridDigest: digest(grid) };
  const selectedSide = side === "YES" ? "yes" : "no";
  const cashRisk = { ...identity, modelFingerprint: cashRiskModelFingerprint(identity), gridEvidence: structuredClone(grid),
    entryCashDebitPerContractMicros: maximumEntryCashDebitPerContractMicros(1, price.toFixed(4), grid.ranges, selectedSide)!,
    entryTradeFeePerContractMicros: maximumEntryFeePerContractMicros(1, price.toFixed(4), ticks(grid), selectedSide)!,
    exitLossPerContractMicros: maximumExitFeePerContractMicros(1, ticks(grid), selectedSide)! };
  const result = { policyVersion: "verified-test-policy", sourceUrl: "https://invalid.test/fees", formulaVersion: "verified-formula",
    verifiedAtMs: 12345, contracts: 1, limitPrice: price, fingerprint: "", cashRisk,
    reservedEntryFeeCents: Math.ceil(cashRisk.entryTradeFeePerContractMicros / 10000),
    reservedExitFeeCents: Math.ceil(cashRisk.exitLossPerContractMicros / 10000) };
  result.fingerprint = cashRiskFeeFingerprint(result);
  assert.equal(validEntryCashRisk(result), true);
  return result;
}

test("selected 38-cent fee is recomputed from a verified 37-cent basis, not borrowed or capped to basis count", () => {
  for (const grid of [full, tapered]) for (const side of ["YES", "NO"] as const) {
    const old = fixture(grid, side), before = structuredClone(old);
    assert.equal(validEntryFeePriceGrid(old, grid), true);
    const selected = repriceVerifiedEntryFee(old, grid, 3, .38)!;
    assert.ok(selected); assert.equal(selected.contracts, 3); assert.equal(selected.limitPrice, .38);
    assert.equal(selected.cashRisk!.entryTradeFeePerContractMicros, 16500);
    assert.equal(old.cashRisk!.entryTradeFeePerContractMicros, 16400);
    assert.equal(selected.reservedEntryFeeCents, 5); assert.equal(selected.reservedExitFeeCents, 300);
    assert.equal(entryCashProof(selected, 3, 625)!.plannedAllInCents, 600);
    assert.equal(validEntryCashRisk(selected), true); assert.notEqual(selected.fingerprint, old.fingerprint);
    assert.deepEqual(old, before);
    assert.equal(selected.cashRisk!.modelFingerprint, old.cashRisk!.modelFingerprint);
    assert.equal(selected.cashRisk!.gridDigest, old.cashRisk!.gridDigest);
    for (const key of ["policyVersion", "sourceUrl", "formulaVersion", "verifiedAtMs"] as const) assert.equal(selected[key], old[key]);
  }
});

test("an asymmetric YES grid is complemented for NO prices, including on-grid membership", () => {
  const grid: EntryFeePriceGrid = { structure: "deci_cent", ranges: [{ start: "0.2000", end: "0.4000", step: "0.1000" }] };
  const yes = fixture(grid, "YES", .2), no = fixture(grid, "NO", .6);
  assert.ok(repriceVerifiedEntryFee(yes, grid, 3, .3));
  assert.equal(repriceVerifiedEntryFee(yes, grid, 3, .7), null);
  assert.ok(repriceVerifiedEntryFee(no, grid, 3, .7));
  assert.equal(repriceVerifiedEntryFee(no, grid, 3, .3), null);
  assert.equal(repriceVerifiedEntryFee(no, grid, 3, .65), null);
});

test("missing, modified, reversed, overlapping, oversized and out-of-range grids fail closed", () => {
  const fee = fixture();
  const bad: unknown[] = [undefined, null, {}, { ...full, structure: "unknown" }, { ...full, extra: true },
    { ...full, ranges: [] }, { ...full, ranges: Array(101).fill(full.ranges[0]) },
    { ...full, ranges: [{ start: "0.0000", end: "1.0000", step: "0.0010" }] },
    { ...full, ranges: [{ start: "0.5000", end: "0.1000", step: "0.0100" }] },
    { ...full, ranges: [{ start: "-0.0010", end: "1.0000", step: "0.0100" }] },
    { ...full, ranges: [{ start: "0.0000", end: "1.0001", step: "0.0001" }] },
    { ...full, ranges: [{ start: "0.0000", end: "1.0000", step: "0.0000" }] },
    { ...full, ranges: [{ start: "0.0000", end: "0.9999", step: "0.0100" }] },
    { ...full, ranges: [{ start: "0", end: "1.0000", step: "0.0001" }] },
    { ...full, ranges: [{ start: "0.0000", end: "1.0000", step: "1e-4" }] },
    { ...full, ranges: [{ start: "0.0000", end: "1.0000", step: "0.0001", extra: true }] },
    { ...full, ranges: [{ start: "0.0000", end: "0.5000", step: "0.1000" }, { start: "0.4000", end: "1.0000", step: "0.1000" }] },
  ];
  for (const grid of bad) {
    assert.equal(validEntryFeePriceGrid(fee, grid), false); assert.equal(repriceVerifiedEntryFee(fee, grid, 3, .38), null);
  }
  // Malformed ranges remain rejected even if a caller repairs the unkeyed hashes.
  for (const grid of bad.filter(g => g && typeof g === "object" && (g as {ranges?:unknown}).ranges)) {
    const tampered = structuredClone(fee); tampered.cashRisk!.gridDigest = digest(grid);
    tampered.cashRisk!.modelFingerprint = cashRiskModelFingerprint(tampered.cashRisk!);
    tampered.fingerprint = cashRiskFeeFingerprint(tampered);
    if (JSON.stringify(grid) === JSON.stringify(bad[7])) continue; // valid but different grid: digest test above is sufficient
    assert.equal(repriceVerifiedEntryFee(tampered, grid, 3, .38), null);
  }
});

test("old basis under-reservation cannot be laundered by recomputing receipt checksums", () => {
  for (const field of ["entryTradeFeePerContractMicros", "exitLossPerContractMicros"] as const) {
    const fee = fixture(); fee.cashRisk![field] = 100;
    fee.reservedEntryFeeCents = Math.ceil(fee.cashRisk!.entryTradeFeePerContractMicros / 10000);
    fee.reservedExitFeeCents = Math.ceil(fee.cashRisk!.exitLossPerContractMicros / 10000);
    fee.fingerprint = cashRiskFeeFingerprint(fee);
    assert.equal(validEntryCashRisk(fee), true);
    assert.equal(validEntryFeePriceGrid(fee, full), false); assert.equal(repriceVerifiedEntryFee(fee, full, 3, .38), null);
  }
});

test("whole-count, four-decimal and actual tapered-grid boundaries remain exact", () => {
  const fee = fixture(tapered);
  for (const count of [0, -1, .01, 1.5, NaN, Infinity, 1000000000]) assert.equal(repriceVerifiedEntryFee(fee, tapered, count, .38), null);
  for (const price of [0, 1, -1, NaN, Infinity, .38001, .375]) assert.equal(repriceVerifiedEntryFee(fee, tapered, 3, price), null);
  for (const price of [.001, .1, .11, .38, .9, .901, .999]) assert.ok(repriceVerifiedEntryFee(fee, tapered, 3, price));
  const large = repriceVerifiedEntryFee(fee, tapered, 999999999, .38)!;
  assert.equal(large.reservedEntryFeeCents, Number((16500n * 999999999n + 9999n) / 10000n));
});

test("repricing never reads current time, renews a receipt, mutates source or aliases its stored grid", () => {
  const fee = fixture(), before = structuredClone(fee), now = Date.now;
  let result: V13VerifiedFeeEvidence | null;
  try {
    Date.now = () => { throw Error("must not refresh authority time"); };
    result = repriceVerifiedEntryFee(fee, full, 3, .38);
  } finally { Date.now = now; }
  assert.ok(result); assert.equal(result.verifiedAtMs, 12345); assert.deepEqual(fee, before);
  const stored = fee.cashRisk as NonNullable<V13VerifiedFeeEvidence["cashRisk"]> & {gridEvidence:EntryFeePriceGrid};
  const selected = result.cashRisk as typeof stored;
  assert.notEqual(selected.gridEvidence, stored.gridEvidence); stored.gridEvidence.ranges[0]!.step = "0.0010";
  assert.equal(selected.gridEvidence.ranges[0]!.step, "0.0001");
  const missing = { ...fee, cashRisk: undefined };
  assert.equal(repriceVerifiedEntryFee(missing, full, 3, .38), null);
});

import {prepareVerifiedEntryFeeRepricing} from './entryCashFeeRepricing';
test('invocation-local repricing preserves exact outputs and cannot retain caller aliases',()=>{
 for(const grid of [full,tapered])for(const side of ['YES','NO'] as const){
  const fee=fixture(grid,side),before=structuredClone(fee),inputGrid=structuredClone(grid);
  const selected=prepareVerifiedEntryFeeRepricing(fee,inputGrid)!;assert.ok(selected);
  fee.limitPrice=.99;fee.verifiedAtMs=999999;fee.cashRisk!.entryCashDebitPerContractMicros=1;inputGrid.ranges.length=0;
  for(const price of [.01,.37,.38,.50,.99])for(const contracts of [1,3,100]){
   const expected=repriceVerifiedEntryFee(before,grid,contracts,price);
   const actual=selected(contracts,price);assert.deepEqual(actual,expected);
   if(actual){actual.cashRisk!.gridEvidence!.ranges.length=0;assert.deepEqual(selected(contracts,price),expected);}
  }
 }
});
test('invocation-local repricing rejects malformed or under-reserved original proof before selection',()=>{
 const fee=fixture();fee.reservedEntryFeeCents=0;
 assert.equal(prepareVerifiedEntryFeeRepricing(fee,full),null);
 assert.equal(prepareVerifiedEntryFeeRepricing(fixture(),{...full,ranges:[]}),null);
});
