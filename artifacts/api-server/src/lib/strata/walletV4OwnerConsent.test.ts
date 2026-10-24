import test from "node:test";
import assert from "node:assert/strict";
import {recordWalletV4FeeEvidence,authorizeWalletV4FeeModel,revokeWalletV4FeeConsent,
 WALLET_V4_EVIDENCE_CONFIRM,WALLET_V4_CONSENT_CONFIRM,
 WALLET_V4_REVOKE_CONFIRM} from "./walletV4OwnerConsent";
import type {DynamicFeeResult} from "./dynamicOfficialFeeSchedule";

const owner="11111111-1111-4111-8111-111111111111";
const sha="a".repeat(40),hash="b".repeat(64),source="c".repeat(64),metadata="d".repeat(64);
const ticker="KXBTC15M-26OCT232000";
const started=Date.parse("2026-10-23T20:00:00Z");
const valid:DynamicFeeResult={ok:true,reason:"dynamic_fee_observation_for_review_only",
 providerContentChanged:false,tradingAuthorized:false,
 model:{issuer:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 publicationDigest:source,effectiveDate:"2026-07-07",takerRatePpm:70000,
 makerRatePpm:17500,defaultTakerMultiplierPpm:1_000_000,
 defaultMakerMultiplierPpm:0,feeType:"quadratic",feeMultiplier:"1",
 marketTicker:ticker,eventTicker:ticker,metadataDigest:metadata,modelDigest:hash,
 observedAt:new Date(started).toISOString(),tradingAuthorized:false,
 requiresVersionedReview:true}};
const deps={enabled:()=>true,sha:()=>sha,now:()=>started+1000,observe:async()=>valid};
const evidence={marketTicker:ticker,expectedDeployedSha:sha,
 expectedModelDigest:hash,confirmation:WALLET_V4_EVIDENCE_CONFIRM};
const consent={evidenceId:"33333333-3333-4333-8333-333333333333",
 expectedDeployedSha:sha,expectedModelDigest:hash,
 confirmation:WALLET_V4_CONSENT_CONFIRM};
function dbFake(handler:(sql:string,args:unknown[])=>{rows:Record<string,unknown>[]}){
 const all:string[]=[];
 const client={async query(sql:string,args:unknown[]=[]){
  all.push(sql);return handler(sql,args);
 },release(){}};
 return {all,db:{async connect(){return client;},query:client.query}};
}
test("V4 evidence requires real owner, exact SHA, exact observed digest and explicit consent",async()=>{
 let requested=0;
 const options={...deps,observe:async()=>{requested++;return valid;}};
 const rejects=[
  { ...evidence,confirmation:"YES"},
  { ...evidence,marketTicker:"other-market"},
  { ...evidence,expectedModelDigest:"!" },
  { ...evidence,expectedDeployedSha:"f".repeat(40) },
 ];
 for(const b of rejects)assert.equal((await recordWalletV4FeeEvidence(owner,b,options)).ok,false);
 assert.equal(requested,0);
 assert.equal((await recordWalletV4FeeEvidence(owner,evidence,{
  ...options,enabled:()=>false})).ok,false);
 assert.equal(requested,0);
 const drift=await recordWalletV4FeeEvidence(owner,evidence,{
  ...options,observe:async()=>({...valid,model:{...valid.model,modelDigest:"e".repeat(64)}})});
 assert.equal(drift.ok,false);
});
test("Evidence recording is serializable, scoped and never executes a trade",async()=>{
 const {all,db}=dbFake((sql)=>{
  if(sql.includes("FROM public.v13_production_account"))return {rows:[{
   id:"wallet-account",commissioned:true,kill_switch:true,
   execution_enabled:false,cash_precision_verified:true}]};
  if(sql.includes("FROM private.kalshi_account_worker_lease"))return {rows:[]};
  if(sql.includes("INSERT INTO private.strata_wallet_v4_fee_evidence"))
   return {rows:[{evidence_id:"33333333-3333-4333-8333-333333333333"}]};
  return {rows:[]};
 });
 const r=await recordWalletV4FeeEvidence(owner,evidence,{...deps,db});
 assert.equal(r.ok,true);
 if(r.ok){
  assert.equal(r.evidenceRecorded,true);
  assert.equal(r.grantIssued,false);
  assert.equal(r.tradingAuthorized,false);
  assert.equal(r.ordersSubmitted,false);
 }
 assert.ok(all.includes("BEGIN ISOLATION LEVEL SERIALIZABLE"));
 assert.ok(all.includes("COMMIT"));
 assert.ok(all.some(s=>s.includes("FOR UPDATE")&&s.includes("owner_user_id=$1::uuid")));
 assert.ok(!all.some(s=>/submitOrder|START|ARM|UPDATE .*kill_switch/.test(s)));
});
test("No consent grant on missing V4-approved $5 policy, even with fresh fee proof",async()=>{
 const {all,db}=dbFake(sql=>{
  if(sql.includes("SELECT market_ticker,official_source_digest"))return {rows:[{
   market_ticker:ticker,official_source_digest:source}]};
  if(sql.includes("FROM public.v13_production_account")&&sql.includes("FOR UPDATE"))
   return {rows:[{id:"wallet-account",commissioned:true,kill_switch:true,
      execution_enabled:false,cash_precision_verified:true}]};
  if(sql.includes("FROM private.kalshi_account_worker_lease"))return {rows:[]};
  if(sql.includes("FROM private.strata_wallet_v4_fee_evidence")&&sql.includes("FOR SHARE"))
   return {rows:[{evidence_id:consent.evidenceId,market_ticker:ticker,
     model_digest:hash,official_source_digest:source,expires_at:new Date(started+9*60_000)}]};
  if(sql.includes("FROM public.v13_production_account")&&sql.includes("v13_live_money_policy"))
   return {rows:[]};
  return {rows:[]};
 });
 const r=await authorizeWalletV4FeeModel(owner,consent,{...deps,db});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"wallet_v4_approved_policy_not_found");
 assert.ok(!all.some(s=>s.includes("INSERT INTO private.strata_wallet_v4_fee_authority")));
 assert.ok(all.includes("ROLLBACK"));
});
test("V4 evidence revoked/incomplete issuer and no verified account fail closed",async()=>{
 const {db}=dbFake(sql=>sql.includes("FROM public.v13_production_account")?{rows:[]}:{rows:[]});
 assert.equal((await recordWalletV4FeeEvidence(owner,evidence,{...deps,db})).ok,false);
 const r=await authorizeWalletV4FeeModel(owner,{...consent,confirmation:"auto"},{
  ...deps,db});
 assert.equal(r.ok,false);
});
test("Revocation requires owner confirmation even when feature disabled",async()=>{
 assert.equal((await revokeWalletV4FeeConsent(owner,{authorityId:consent.evidenceId,
    confirmation:"yes"},deps)).ok,false);
 const {db,all}=dbFake(sql=>{
  if(sql.includes("FROM private.strata_wallet_v4_fee_authority")&&sql.includes("FOR UPDATE"))
   return {rows:[{authority_id:consent.evidenceId}]};
  if(sql.includes("UPDATE private.strata_wallet_v4_fee_authority"))
   return {rows:[{authority_id:consent.evidenceId}]};
  return {rows:[]};
 });
 const r=await revokeWalletV4FeeConsent(owner,{
  authorityId:consent.evidenceId,confirmation:WALLET_V4_REVOKE_CONFIRM
 },{...deps,enabled:()=>false,db});
 assert.equal(r.ok,true);
 assert.ok(all.some(s=>s.includes("revoked_at=now()")));
 assert.ok(all.includes("COMMIT"));
});
