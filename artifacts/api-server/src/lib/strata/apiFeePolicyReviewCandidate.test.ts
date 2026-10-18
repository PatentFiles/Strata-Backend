import test from "node:test";
import assert from "node:assert/strict";
import { preparePdfFreeApiFeePolicyReview, API_FEE_POLICY_SOURCE_V1 } from
  "./apiFeePolicyReviewCandidate";
import type { KalshiMarketFeeReadOnly } from "./twoSourceFeeEvidence";
const now=Date.parse("2026-10-18T02:30:00.000Z");
function fixture():KalshiMarketFeeReadOnly {
 return {
  ok:true,reason:"live_series_event_fee_metadata_verified_read_only",
  series:"KXBTC15M",exchangeIndex:2,
  referenceDigest:"a".repeat(64),
  liveVerifiedAt:new Date(now-500).toISOString(),
  marketTicker:"KXBTC15M-26OCT172230-00",
  eventTicker:"KXBTC15M-26OCT172230",
  feeType:"quadratic",feeMultiplier:"1",
  metadataDigest:"b".repeat(64),
  pdfProvenanceApproved:false,ownerPolicyApproved:false,
  commissioningApproved:false,tradingEnabled:false,
 };
}
test("PDF-free source produces review candidate only; never trading or policy authority",()=>{
 const a=preparePdfFreeApiFeePolicyReview(fixture(),now);
 assert.equal(a.ok,true);
 if(!a.ok)return;
 assert.equal(a.sourceKind,API_FEE_POLICY_SOURCE_V1);
 assert.match(a.reviewCandidateDigest,/^[a-f0-9]{64}$/);
 assert.notEqual(a.reviewCandidateDigest,a.observationDigest);
 assert.equal(a.policyApproved,false);
 assert.equal(a.commissioningApproved,false);
 assert.equal(a.tradingAuthorized,false);
 assert.equal(a.requiresIndependentFeeModelReview,true);
 assert.equal("feeArtifactDigest" in a,false);
 assert.equal("pdfVerified" in a,false);
});
test("PDF-free candidate is deterministic and binds market, source, time and formula version",()=>{
 const a=preparePdfFreeApiFeePolicyReview(fixture(),now);
 const b=preparePdfFreeApiFeePolicyReview(fixture(),now);
 assert.deepEqual(a,b);
 const changed=fixture();changed.marketTicker="KXBTC15M-26OCT172245-00";
 const c=preparePdfFreeApiFeePolicyReview(changed,now);
 assert.equal(c.ok,true);
 if(a.ok&&c.ok)assert.notEqual(a.reviewCandidateDigest,c.reviewCandidateDigest);
});
test("PDF-free candidate refuses unauthenticated, false-authority and stale metadata",()=>{
 const variants:Partial<KalshiMarketFeeReadOnly>[]=[
   {ok:false},{exchangeIndex:0 as 2},{feeType:"other" as "quadratic"},
   {feeMultiplier:"2" as "1"},{pdfProvenanceApproved:true as false},
   {ownerPolicyApproved:true as false},{commissioningApproved:true as false},
   {tradingEnabled:true as false},{metadataDigest:"not-a-hash"},
   {marketTicker:"NOT-BTC"},{eventTicker:"NOT-BTC"},
   {liveVerifiedAt:"not-a-date"},
 ];
 for(const patch of variants) {
  const rejected=preparePdfFreeApiFeePolicyReview({...fixture(),...patch},now);
  assert.equal(rejected.ok,false,JSON.stringify(patch));
 }
 assert.equal(preparePdfFreeApiFeePolicyReview(fixture(),now+11_000).ok,false);
 assert.equal(preparePdfFreeApiFeePolicyReview(fixture(),now-1_000).ok,false);
});
