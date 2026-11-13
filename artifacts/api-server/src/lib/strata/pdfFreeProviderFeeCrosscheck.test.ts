import test from "node:test";
import assert from "node:assert/strict";
import {readPdfFreeProviderFeeReviewEvidence} from "./pdfFreeProviderFeeCrosscheck";
import {OFFICIAL_PREDICTION_FEE_PAGE,
 type FeePageCandidate} from "./providerFeePageCapture";
import type {KalshiMarketFeeReadOnly} from "./twoSourceFeeEvidence";

const NOW=Date.parse("2026-10-19T03:50:00.000Z");
const MARKET="KXBTC15M-26OCT190400-00";
const EVENT="KXBTC15M-26OCT190400";
const page=()=>({
 ok:true,reason:"official_prediction_fee_page_bytes_captured_for_review",
 canonicalUrl:OFFICIAL_PREDICTION_FEE_PAGE,capturedAt:new Date(NOW).toISOString(),
 sha256:"a".repeat(64),byteLength:8127,providerContentReceived:true,
 currentFeeFormulaVerified:false,sourcePolicyApproved:false,
 exchangeExecutionAuthorized:false,
}) as const;
const api=():KalshiMarketFeeReadOnly=>({
 ok:true,reason:"live_series_event_fee_metadata_verified_read_only",
 series:"KXBTC15M",exchangeIndex:2,referenceDigest:"b".repeat(64),
 liveVerifiedAt:new Date(NOW).toISOString(),
 marketTicker:MARKET,eventTicker:EVENT,feeType:"quadratic",
 feeMultiplier:"1",metadataDigest:"c".repeat(64),
 pdfProvenanceApproved:false,ownerPolicyApproved:false,
 commissioningApproved:false,tradingEnabled:false,
});
const deps=(p:FeePageCandidate=page(),a:KalshiMarketFeeReadOnly=api())=>({
 clock:()=>NOW,
 capture:(async()=>p) as unknown as typeof import("./providerFeePageCapture").captureOfficialPredictionFeePage,
 probe:(async()=>a) as unknown as typeof import("./twoSourceFeeEvidence").probeCurrentKalshiFeeApi,
 transport:(async()=>{throw Error("unexpected fetch")}) as typeof fetch,
});
test("two matching provider observations result in an immutable review digest, never approval",async()=>{
 const one=await readPdfFreeProviderFeeReviewEvidence(MARKET,deps());
 const two=await readPdfFreeProviderFeeReviewEvidence(MARKET,deps());
 assert.deepEqual(one,two);
 assert.equal(one.ok,true);
 if(one.ok){
  assert.match(one.reviewEvidenceSha256,/^[a-f0-9]{64}$/);
  assert.equal(one.marketTicker,MARKET);
  assert.equal(one.formulaIndependentlyVerified,false);
  assert.equal(one.ownerFeeApproval,false);
  assert.equal(one.protectiveExitExecutionVerified,false);
  assert.equal(one.tradingAuthorized,false);
 }
});
test("page HTTP 429 or unavailable live market never emits a successful crosscheck",async()=>{
 const deniedPage:FeePageCandidate={
  ok:false,reason:"official_page_http_429",providerContentReceived:false,
  currentFeeFormulaVerified:false,sourcePolicyApproved:false,
  exchangeExecutionAuthorized:false,
 };
 const unavailable:KalshiMarketFeeReadOnly={
  ...api(),ok:false,reason:"official_api_metadata_unavailable",
 };
 for(const d of [deps(deniedPage),deps(page(),unavailable)]){
  const r=await readPdfFreeProviderFeeReviewEvidence(MARKET,d);
  assert.equal(r.ok,false);
  assert.equal(r.tradingAuthorized,false);
  assert.equal(r.ownerFeeApproval,false);
 }
});
test("rejects mismatched order market, corrupt digest, unbound page and invalid clock",async()=>{
 const alternate="KXBTC15M-26OCT190415-15";
 const mismatch=await readPdfFreeProviderFeeReviewEvidence(alternate,deps());
 assert.equal(mismatch.ok,false);
 const corrupt=await readPdfFreeProviderFeeReviewEvidence(MARKET,deps({...page(),sha256:"missing"},api()));
 assert.equal(corrupt.ok,false);
 const timestamp=await readPdfFreeProviderFeeReviewEvidence(MARKET,deps({...page(),
  capturedAt:new Date(NOW+60_000).toISOString()},api()));
 assert.equal(timestamp.ok,false);
 const badClock=await readPdfFreeProviderFeeReviewEvidence(MARKET,{...deps(),clock:()=>Number.NaN});
 assert.equal(badClock.ok,false);
 assert.equal((await readPdfFreeProviderFeeReviewEvidence("KXBTC15M",deps())).ok,false);
});
test("differing authenticated observations produce different review hashes",async()=>{
 const a=await readPdfFreeProviderFeeReviewEvidence(MARKET,deps());
 const b=await readPdfFreeProviderFeeReviewEvidence(MARKET,deps(
  {...page(),sha256:"d".repeat(64)},api()));
 const c=await readPdfFreeProviderFeeReviewEvidence(MARKET,deps(
  page(),{...api(),metadataDigest:"e".repeat(64)}));
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(c.ok,true);
 if(a.ok&&b.ok&&c.ok){
  assert.notEqual(a.reviewEvidenceSha256,b.reviewEvidenceSha256);
  assert.notEqual(a.reviewEvidenceSha256,c.reviewEvidenceSha256);
 }
});
