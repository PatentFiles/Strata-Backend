import test from "node:test";
import assert from "node:assert/strict";
import {
 conservativeWholeCentTakerReference,validateConservativeFeeVectors,
 conservativeExactFillFeeAndRoundingBoundMicros,conservativeUnknownPriceFeeAndRoundingBoundMicros,
 TAKER_FEE_REVIEW_VECTORS,PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
} from "./apiFeeRateReference";

test("conservative integer taker reference reproduces independently reviewable fee examples",()=>{
 assert.match(PDF_FREE_RATE_REVIEW_VECTOR_VERSION,/conservative_reference_v1$/);
 assert.equal(validateConservativeFeeVectors(),true);
 assert.equal(TAKER_FEE_REVIEW_VECTORS.length,8);
 for(const vector of TAKER_FEE_REVIEW_VECTORS) {
  assert.equal(conservativeWholeCentTakerReference(
    vector.priceMicros,vector.contracts),vector.maximumCents);
 }
});

test("rejects invalid prices, counts and unknown multipliers",()=>{
 for(const [price,qty,mult] of [
  [0n,1n,1n],[1_000_000n,1n,1n],
  [-1n,1n,1n],[500_000n,0n,1n],
  [500_000n,-1n,1n],[500_000n,1_000_001n,1n],
  [500_000n,10n,2n],[500_000n,10n,0n]
 ] as const) assert.equal(conservativeWholeCentTakerReference(price,qty,mult),null);
});

test("whole-cent ceiling is conservative and preserves integer symmetry",()=>{
 const bounds=[1n,500n,1_000n,12_500n,99_999n,125_000n,480_001n,500_000n,999_999n];
 for(const price of bounds)for(const qty of [1n,2n,3n,100n,9999n]) {
  const fee=conservativeWholeCentTakerReference(price,qty);
  const inverse=conservativeWholeCentTakerReference(1_000_000n-price,qty);
  assert.equal(fee,inverse);
  assert.equal(typeof fee,"bigint");
  const exactCentsNumerator=7n*qty*price*(1_000_000n-price);
  assert.ok(fee!*1_000_000_000_000n>=exactCentsNumerator);
  assert.ok((fee!-1n)*1_000_000_000_000n<exactCentsNumerator);
 }
});


test("official six-decimal fee example and balance-grid worst case are conservatively bounded",()=>{
 // Kalshi public docs use a 5.5c fill with a model fee of $0.00363825:
 // ceiling to six decimals is exactly 3,639 micros.
 const direct=conservativeExactFillFeeAndRoundingBoundMicros(55_000n,1n,100n,1n);
 const nondirect=conservativeExactFillFeeAndRoundingBoundMicros(55_000n,1n,10_000n,1n);
 assert.equal(direct,3_639n+99n);
 assert.equal(nondirect,3_639n+9_999n);
 // Published non-direct worked example yields 5,000 micros in net debit fee.
 assert.ok(nondirect! >= 5_000n);
});

test("maximum model rate at 50c dominates any exact fill price",()=>{
 for (const grid of [100n,10_000n] as const) {
  for (const qty of [1n,2n,7n,100n]) {
   for (const fills of [1n,qty]) {
    const universal=conservativeUnknownPriceFeeAndRoundingBoundMicros(qty,grid,fills)!;
    for(const price of [1n,55_000n,100_000n,250_000n,500_000n,750_000n,999_999n]) {
      const exact=conservativeExactFillFeeAndRoundingBoundMicros(price,qty,grid,fills)!;
      assert.ok(universal>=exact);
    }
   }
  }
 }
});

test("splitting an order can only increase conservative rounding overhead",()=>{
 const cases=[100n,10_000n] as const;
 for(const grid of cases){
  const one=conservativeUnknownPriceFeeAndRoundingBoundMicros(8n,grid,1n)!;
  const eight=conservativeUnknownPriceFeeAndRoundingBoundMicros(8n,grid,8n)!;
  assert.equal(eight-one,7n*grid);
  // At 50 cents, one-contract model fee is 17,500 micros.
  assert.equal(conservativeUnknownPriceFeeAndRoundingBoundMicros(1n,grid,1n),
   17_500n+grid-1n);
 }
});

test("partial-fill bounds fail closed on invalid ranges or account precision",()=>{
 for(const [qty,grid,fills] of [
  [0n,100n,1n],[1_000_001n,100n,1n],[1n,100n,0n],
  [1n,100n,2n],[1n,10n,1n],[1n,1000n,1n],
 ] as const){
   assert.equal(conservativeUnknownPriceFeeAndRoundingBoundMicros(qty,grid as 100n, fills),null);
 }
 assert.equal(conservativeExactFillFeeAndRoundingBoundMicros(0n,1n,100n,1n),null);
 assert.equal(conservativeExactFillFeeAndRoundingBoundMicros(1_000_000n,1n,100n,1n),null);
});
