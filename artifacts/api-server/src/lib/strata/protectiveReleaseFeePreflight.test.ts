import test from "node:test";
import assert from "node:assert/strict";
import { verifyProtectiveReleaseFeePreflight } from "./protectiveReleaseFeePreflight";
import { INDEPENDENT_OFFICIAL_FEE_SNAPSHOT } from "./verifiedOfficialFeeSnapshotLease";
const now=Date.parse("2026-10-20T05:31:00.000Z");
const pdfUnavailable=async()=>({ok:false,reason:"official_fee_schedule_http_429",
  stage:"STEP_11",monetaryFeeAuthorized:false,policyApproved:false,tradingAuthorized:false}) as never;
const observation=(ts=now)=>({
 ok:true,reason:"live_series_event_fee_metadata_verified_read_only",
 series:"KXBTC15M",exchangeIndex:2,referenceDigest:INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.sha256,
 liveVerifiedAt:new Date(ts).toISOString(),marketTicker:"KXBTC15M-26OCT200545-45",
 eventTicker:"KXBTC15M-26OCT200545",feeType:"quadratic",feeMultiplier:"1",
 metadataDigest:"a".repeat(64),pdfProvenanceApproved:false,ownerPolicyApproved:false,
 commissioningApproved:false,tradingEnabled:false,
});

test("Primary fresh provider PDF and market approval remains preferred",async()=>{
 let probed=false;
 const r=await verifyProtectiveReleaseFeePreflight({
  direct:(async()=>({ok:true,reason:"verified",stage:"STEP_11",monetaryFeeAuthorized:true,
    sourceDigest:"b".repeat(64),verifiedAt:new Date(now).toISOString()})) as never,
  probe:(async()=>{probed=true;return observation()}) as never,now:()=>now,
 });
 assert.equal(r.ok,true);
 assert.equal(r.ok&&r.sourceKind,"direct_official_pdf");
 assert.equal(probed,false);
 assert.equal(r.tradingAuthorized,false);
});
test("Rate-limited PDF may use ONLY unexpired independently captured provider bytes plus fresh live API",async()=>{
 let probes=0;
 const r=await verifyProtectiveReleaseFeePreflight({
  direct:pdfUnavailable as never,
  probe:(async()=>{probes++;return observation()}) as never,
  now:()=>now,
 });
 assert.deepEqual({ok:r.ok,source:r.ok&&r.sourceKind,digest:r.ok&&r.sourceDigest,authorized:r.tradingAuthorized},{
  ok:true,source:"unexpired_reviewed_official_pdf_lease",
  digest:INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.sha256,authorized:false});
 assert.equal(probes,1);
});
test("Expired reviewed official source cannot be silently carried forward",async()=>{
 let probes=0;
 const r=await verifyProtectiveReleaseFeePreflight({
  direct:pdfUnavailable as never,now:()=>Date.parse("2026-10-21T05:31:00Z"),
  probe:(async()=>{probes++;return observation()}) as never,
 });
 assert.equal(r.ok,false);assert.equal(r.reason,"official_fee_schedule_http_429_and_snapshot_expired");
 assert.equal(probes,0);
});
test("Current provider fee overrides or stale metadata refuse qualification",async()=>{
 const r=await verifyProtectiveReleaseFeePreflight({
  direct:pdfUnavailable as never,now:()=>now,
  probe:(async()=>({...observation(),feeMultiplier:"1.5"})) as never,
 });
 assert.equal(r.ok,false);
 const stale=await verifyProtectiveReleaseFeePreflight({
  direct:pdfUnavailable as never,now:()=>now,
  probe:(async()=>observation(now-20_000)) as never,
 });
 assert.equal(stale.ok,false);
});
test("Nontransport monetary mismatch is never rescued by snapshot",async()=>{
 let called=false;
 const r=await verifyProtectiveReleaseFeePreflight({
  direct:(async()=>({ok:false,reason:"live_event_fee_override",monetaryFeeAuthorized:false})) as never,
  probe:(async()=>{called=true;return observation()}) as never,now:()=>now,
 });
 assert.equal(r.ok,false);assert.equal(r.reason,"live_event_fee_override");
 assert.equal(called,false);
});


test("Expired snapshot preserves sanitized network transport failure and never claims PDF provenance",async()=>{
 const result=await verifyProtectiveReleaseFeePreflight({
   direct:(async()=>({ok:false,reason:"official_monetary_fee_source_unavailable",
     monetaryFeeAuthorized:false})) as never,
   now:()=>Date.parse("2026-10-21T02:05:00Z"),
   probe:(async()=>{throw Error("should not probe a stale snapshot")}) as never,
 });
 assert.equal(result.ok,false);
 assert.equal(result.reason,"official_monetary_fee_source_unavailable_and_snapshot_expired");
 assert.equal(result.tradingAuthorized,false);
});
