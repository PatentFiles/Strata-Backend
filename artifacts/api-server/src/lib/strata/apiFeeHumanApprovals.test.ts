import test from "node:test";
import assert from "node:assert/strict";
import {
 recordApiFeeRateReview,issueApiFeeSourceGrant,
 recordApiFeeOwnerConsent,revokeApiFeeOwnerConsent,revokeApiFeeSourceGrant,
 API_REVIEW_CONFIRM,API_GRANT_CONFIRM,API_CONSENT_CONFIRM,
 API_CONSENT_REVOKE,API_GRANT_REVOKE,
} from "./apiFeeHumanApprovals";
import { PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 } from "./apiFeeRateReference";
import type { KalshiMarketFeeReadOnly } from "./twoSourceFeeEvidence";

const owner="11111111-1111-4111-8111-111111111111";
const admin="22222222-2222-4222-8222-222222222222";
const grant="55555555-5555-4555-8555-555555555555";
const digest=PDF_FREE_API_RATE_REVIEW_DECISION_SHA256;
const note="I independently checked the current effective Kalshi KXBTC15M fee publication and verified the rate model, required rounding, exceptions, and model test vectors before attesting.";
const review={ownerUserId:owner,rateDecisionDigest:digest,confirmation:API_REVIEW_CONFIRM,
 note,verifiedRateSource:"kalshi_official_fee_publication"};
const assertNoAuthority=(v:{policyApproved:boolean;commissioningApproved:boolean;tradingAuthorized:boolean})=>{
 assert.equal(v.policyApproved,false);
 assert.equal(v.commissioningApproved,false);
 assert.equal(v.tradingAuthorized,false);
};
function fixture(options:{admin?:boolean;reviewers?:number;grant?:boolean;activeGrant?:boolean}={}){
 const calls:string[]=[];
 let commits=0;
 const client={
  query:async(sql:string,_params?:unknown[])=>{
   calls.push(sql);
   if(sql==="COMMIT")commits++;
   if(sql.includes("FROM auth.users u JOIN private.role_assignments"))return {rows:options.admin===false?[]:[{one:1}]};
   if(sql.includes("FROM public.v13_production_account"))return {rows:[{id:"acc"}]};
   if(sql.includes("SELECT grant_id FROM private.strata_api_fee_source_grants") && sql.includes("LIMIT 1"))
    return {rows:options.activeGrant?[{grant_id:grant}]:[]};
   if(sql.includes("SELECT r.reviewer_user_id,r.expires_at")){
    return {rows:Array.from({length:options.reviewers??1},(_,i)=>({
     reviewer_user_id:i===0?admin:"44444444-4444-4444-8444-444444444444",
     expires_at:new Date(Date.now()+90*60_000)
    }))};
   }
   if(sql.includes("FROM private.strata_api_fee_source_grants") && sql.includes("SELECT grant_id"))
    return {rows:options.grant===false?[]:[{grant_id:grant}]};
   if(sql.includes("INSERT INTO private.strata_api_fee_rate_reviews"))
    return {rows:[{review_id:"review",expires_at:new Date(Date.now()+60_000)}]};
   if(sql.includes("INSERT INTO private.strata_api_fee_source_grants"))
    return {rows:[{grant_id:grant}]};
   if(sql.includes("INSERT INTO private.strata_api_fee_owner_consents"))
    return {rows:[{consent_id:"consent"}]};
   if(sql.includes("UPDATE private.strata_api_fee_owner_consents"))
    return {rows:[{consent_id:"consent"}]};
   if(sql.includes("UPDATE private.strata_api_fee_source_grants"))
    return {rows:[{grant_id:grant}]};
   return {rows:[]};
  },
  release:()=>{}
 };
 return {calls,get commits(){return commits},db:{connect:async()=>client}};
}
function observed():KalshiMarketFeeReadOnly{
 return {
 ok:true,reason:"live_series_event_fee_metadata_verified_read_only",
 series:"KXBTC15M",exchangeIndex:2,
 referenceDigest:"a".repeat(64),
 liveVerifiedAt:new Date(Date.now()-100).toISOString(),
 marketTicker:"KXBTC15M-26OCT180945-00",
 eventTicker:"KXBTC15M-26OCT180945",
 feeType:"quadratic",feeMultiplier:"1",metadataDigest:"b".repeat(64),
 pdfProvenanceApproved:false,ownerPolicyApproved:false,
 commissioningApproved:false,tradingEnabled:false
 };
}
test("rate review requires distinct confirmed ADMIN and exact signed decision digest",async()=>{
 const rejected=[
  {...review,rateDecisionDigest:"a".repeat(64)},
  {...review,note:"agreed"},
  {...review,confirmation:"approve"},
  {...review,verifiedRateSource:"self_verified"}
 ];
 for(const body of rejected){
  const state=fixture();
  const r=await recordApiFeeRateReview(admin,body,state.db);
  assert.equal(r.ok,false);
  assert.equal(state.calls.length,0);
  assertNoAuthority(r);
 }
 const blocked=fixture({admin:false});
 assert.equal((await recordApiFeeRateReview(admin,review,blocked.db)).ok,false);
 assert.equal(blocked.commits,0);
 const allowed=fixture();
 const r=await recordApiFeeRateReview(admin,review,allowed.db);
 assert.equal(r.ok,true);assert.equal(allowed.commits,1);assertNoAuthority(r);
});
test("grant requires same technical attesting admin, fresh canonical Kalshi fee observation and distinct owner",async()=>{
 for(const reviewers of [0,2,3]){
  const state=fixture({reviewers});
  const r=await issueApiFeeSourceGrant(admin,
   {ownerUserId:owner,rateDecisionDigest:digest,confirmation:API_GRANT_CONFIRM},
   state.db,(async()=>observed()) as never);
  assert.equal(r.ok,false);assert.equal(state.commits,0);assertNoAuthority(r);
 }
 const stale=fixture();
 const r=await issueApiFeeSourceGrant(admin,
  {ownerUserId:owner,rateDecisionDigest:digest,confirmation:API_GRANT_CONFIRM},
  stale.db,(async()=>({...observed(),feeMultiplier:"2"})) as never);
 assert.equal(r.ok,false);assert.equal(stale.calls.length,0);
 const duplicate=fixture({activeGrant:true});
 const refused=await issueApiFeeSourceGrant(admin,
  {ownerUserId:owner,rateDecisionDigest:digest,confirmation:API_GRANT_CONFIRM},
  duplicate.db,(async()=>observed()) as never);
 assert.equal(refused.ok,false);assert.equal(duplicate.commits,0);assertNoAuthority(refused);
 const accepted=fixture();
 const good=await issueApiFeeSourceGrant(admin,
   {ownerUserId:owner,rateDecisionDigest:digest,confirmation:API_GRANT_CONFIRM},
   accepted.db,(async()=>observed()) as never);
 assert.equal(good.ok,true);assert.equal(accepted.commits,1);assertNoAuthority(good);
});
test("owner consent requires authenticated grant ownership and explicit confirmation",async()=>{
 const missing=fixture({grant:false});
 const bad=await recordApiFeeOwnerConsent(owner,{grantId:grant,confirmation:API_CONSENT_CONFIRM},missing.db);
 assert.equal(bad.ok,false);assert.equal(missing.commits,0);
 const other=fixture();
 const forged=await recordApiFeeOwnerConsent(owner,{grantId:grant,ownerUserId:admin,confirmation:"wrong"},other.db);
 assert.equal(forged.ok,false);assert.equal(other.calls.length,0);
 const valid=fixture();
 const recorded=await recordApiFeeOwnerConsent(owner,{grantId:grant,confirmation:API_CONSENT_CONFIRM},valid.db);
 assert.equal(recorded.ok,true);assertNoAuthority(recorded);
 assert.equal(valid.commits,1);
});
test("revocation requires authenticated owner or issuing admin and is never trading approval",async()=>{
 const ownerDb=fixture();
 const bad=await revokeApiFeeOwnerConsent(owner,{grantId:grant,confirmation:API_CONSENT_REVOKE,reason:"x"},ownerDb.db);
 assert.equal(bad.ok,false);
 const r=await revokeApiFeeOwnerConsent(owner,
  {grantId:grant,confirmation:API_CONSENT_REVOKE,reason:"Owner terminates current permission"},
  ownerDb.db);
 assert.equal(r.ok,true);assertNoAuthority(r);
 const adminDb=fixture();
 const terminated=await revokeApiFeeSourceGrant(admin,
  {grantId:grant,confirmation:API_GRANT_REVOKE,reason:"Fee evidence has changed"},
  adminDb.db);
 assert.equal(terminated.ok,true);assertNoAuthority(terminated);
});
