import test from "node:test";
import assert from "node:assert/strict";
import { verifyReviewedApiFeeSourceStage, parseReviewedApiSource } from "./apiFeeSourceStage";
import { PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION }
 from "./apiFeeRateReference";
import type {KalshiMarketFeeReadOnly} from "./twoSourceFeeEvidence";
const now=Date.parse("2026-10-18T03:25:00Z");
const owner="11111111-1111-4111-8111-111111111111";
const issuer="22222222-2222-4222-8222-222222222222";
const first="33333333-3333-4333-8333-333333333333";
const second="44444444-4444-4444-8444-444444444444";
const gid="55555555-5555-4555-8555-555555555555";
const ticker="KXBTC15M-26OCT18T0325";
const sourceUrl="strata-api-reviewed://kxbtc15m/"+gid;
const result=():KalshiMarketFeeReadOnly=>({
 ok:true,reason:"live_series_event_fee_metadata_verified_read_only",series:"KXBTC15M",
 exchangeIndex:2,referenceDigest:"a".repeat(64),
 liveVerifiedAt:new Date(now-500).toISOString(),
 marketTicker:ticker,eventTicker:ticker,
 feeType:"quadratic",feeMultiplier:"1",metadataDigest:"b".repeat(64),
 pdfProvenanceApproved:false,ownerPolicyApproved:false,
 commissioningApproved:false,tradingEnabled:false,
});
const row=()=>({
 grant_id:gid,owner_user_id:owner,issuer_admin_id:issuer,
 rate_decision_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
 fee_model_version:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
 issued_at:new Date(now-20_000),expires_at:new Date(now+60_000),revoked_at:null,
 authorized_stages:["STEP_9","STEP_11","ORDER_ENTRY"],
 consent_owner:owner,confirmed_at:new Date(now-15_000),consent_revoked_at:null,
 first_review_id:"66666666-6666-4666-8666-666666666666",
 first_reviewer:first,first_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
 first_model:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,first_scope:"KXBTC15M:INDEX2",
 first_signed:new Date(now-30_000),first_expires:new Date(now+70_000),first_revoked:null,
 second_review_id:"77777777-7777-4777-8777-777777777777",
 second_reviewer:second,second_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
 second_model:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,second_scope:"KXBTC15M:INDEX2",
 second_signed:new Date(now-29_000),second_expires:new Date(now+70_000),second_revoked:null,
});
const deps=(rows:Record<string,unknown>[]= [row()])=>({
 now:()=>now,probe:async (_f:typeof fetch,_c:()=>number,_m?:string)=>result(),
 db:{query:async (_sql:string,_params?:unknown[])=>({rows})},
});
test("source parser accepts exact owner-bound review grant URL only",()=>{
 assert.equal(parseReviewedApiSource(sourceUrl)?.grantId,gid);
 assert.equal(parseReviewedApiSource("https://kalshi.com/docs/kalshi-fee-schedule.pdf"),null);
 assert.equal(parseReviewedApiSource(sourceUrl+"/other"),null);
});
test("current two-admin grant passes stage as eligibility, not authority",async()=>{
 const v=await verifyReviewedApiFeeSourceStage(owner,"STEP_9",sourceUrl,undefined,deps());
 assert.equal(v.ok,true);
 if(v.ok){
  assert.equal(v.identity.sourceUrl,sourceUrl);
  assert.match(v.identity.digest,/^[a-f0-9]{64}$/);
 }
});
test("every order probe must bind the exact ticker",async()=>{
 let observedMarket="";
 const data=deps();
 const ok=await verifyReviewedApiFeeSourceStage(owner,"ORDER_ENTRY",sourceUrl,ticker,
  {...data,probe:async(_fetch:typeof fetch,_clock:()=>number,m?:string)=>{
    observedMarket=m??"";return result();
  }});
 assert.equal(ok.ok,true);
 assert.equal(observedMarket,ticker);
 assert.equal((await verifyReviewedApiFeeSourceStage(owner,"ORDER_ENTRY",sourceUrl,
  "WRONG",deps())).ok,false);
 const diff=await verifyReviewedApiFeeSourceStage(owner,"ORDER_ENTRY",sourceUrl,
  "KXBTC15M-26OCT18T0340",deps());
 assert.equal(diff.ok,false);
});
test("missing, ambiguous, revoked and owner-crossed source records fail closed",async()=>{
 const variants=[
  [] as Record<string,unknown>[],
  [row(),row()],
  [{...row(),consent_owner:issuer}],
  [{...row(),first_reviewer:second}],
  [{...row(),second_revoked:new Date(now-1)}],
  [{...row(),rate_decision_digest:"e".repeat(64)}],
  [{...row(),expires_at:new Date(now-100)}],
 ];
 for(const rows of variants){
  const decision=await verifyReviewedApiFeeSourceStage(owner,"STEP_9",
    sourceUrl,undefined,deps(rows));
  assert.equal(decision.ok,false);
 }
});
test("no database and no reviewed grant cannot create fee approval",async()=>{
 const d=deps();
 const v=await verifyReviewedApiFeeSourceStage(owner,"STEP_11",sourceUrl,
  undefined,{...d,db:{query:async()=>{throw Error("not connected");}}});
 assert.equal(v.ok,false);
});
