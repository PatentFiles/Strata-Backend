import test from "node:test";
import assert from "node:assert/strict";
import {
 conservativeWholeCentTakerReference,validateConservativeFeeVectors,
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
