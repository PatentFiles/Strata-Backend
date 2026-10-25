import test from "node:test";
import assert from "node:assert/strict";
import {previewOwnerV4CommissioningRepair,repairOwnerV4CommissioningHold,
 OWNER_V4_REPAIR_CONFIRM} from "./ownerV4CommissioningRepair";
import {computeDynamicFeeModelDigest} from "./dynamicOfficialFeeSchedule";
import {PROVISIONAL_REPAIR_CONFIRM} from "./inAppProtectiveRelease";
const owner="11111111-1111-4111-8111-111111111111",authority="22222222-2222-4222-8222-222222222222";
const sha="a".repeat(40),hash="b".repeat(64),source="c".repeat(64);
const now=Date.parse("2026-10-25T12:00:00.000Z"),ticker="KXBTC15M-26OCT251215";
const modelBase={
 issuer:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 publicationDigest:source,effectiveDate:"2026-07-07",
 takerRatePpm:70000,makerRatePpm:17500,
 defaultTakerMultiplierPpm:1000000,defaultMakerMultiplierPpm:0,
 feeType:"quadratic" as const,feeMultiplier:"1" as const,marketTicker:ticker,
 eventTicker:"KXBTC15M-26OCT251215",
};
const modelDigest=computeDynamicFeeModelDigest(modelBase);
const model={...modelBase,metadataDigest:"d".repeat(64),modelDigest,
 observedAt:new Date(now).toISOString(),tradingAuthorized:false as const,
 requiresVersionedReview:true as const};
const base={
 id:"owned-index2",owner_user_id:owner,owner_id:owner,
 key_fingerprint:"e".repeat(64),kalshi_connection_id:"stored-index2-role",
 policy_id:"owner-v4-approved-policy",policy_hash:hash,revision:7,
 state:"APPROVED",fee_policy_version:"strata_owner_provider_dynamic_fee_v4",
 commissioned:true,kill_switch:true,blocked_reason:"awaiting_account_commissioning",
 cash_precision_verified:true,reconciled_at:new Date(now-10_000).toISOString(),
 cash_micros:"25000000",reserved_micros:"0",
 configured_stake_cents:500,max_entry_stake_cents:500,max_entry_all_in_cents:525,
 capital_limit_cents:2500,risk_capital_cents:2500,max_daily_loss_cents:250,
 max_total_loss_cents:250,risk_preset_id:"owner20",risk_preset_revision:1,
};
const body={confirmation:OWNER_V4_REPAIR_CONFIRM,
 provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM,
 expectedPolicyId:base.policy_id,expectedPolicyHash:hash,expectedRevision:7,
 authorityId:authority,expectedDeployedSha:sha};
function fixture(
 overrides:Record<string,unknown>={},
 opts:{onRead?:()=>unknown;fee?:boolean;cash?:string}={},
){
 const a={...base,...overrides},writes:string[]=[];
 let readCalls=0,modelCalls=0;
 const db={async connect(){return {
  async query(sql:string,args?:unknown[]){
   const normalized=sql.trim();
   if(/^(UPDATE|INSERT|DELETE)/i.test(normalized))writes.push(normalized);
   if(normalized.includes("JOIN public.v13_live_money_policy")&&
      normalized.includes("WHERE a.owner_user_id"))return {rows:[a]};
   if(normalized.startsWith("SELECT request FROM public.v13_production_intent"))return {rows:[]};
   if(normalized.startsWith("SELECT g.authority_id::text,g.expires_at"))return {rows:[{authority_id:authority,expires_at:new Date(now+300_000).toISOString()}]};
   if(normalized.startsWith("SELECT e.market_ticker"))return {rows:[{
    market_ticker:ticker,model_digest:modelDigest,official_source_digest:source}]};
   if(normalized.startsWith("SELECT * FROM public.v13_production_account"))return {rows:[a]};
   if(normalized.includes("count(*)::int FROM public.v13_production_intent"))return {rows:[{
    intents:0,positions:0,workers:0,exits:0}]};
   if(normalized.startsWith("SELECT p.*,s.configured_stake_cents"))return {rows:[a]};
   if(normalized.startsWith("SELECT g.authority_id FROM private.strata_wallet_v4_fee_authority"))
     return {rows:[{authority_id:authority}]};
   if(normalized.startsWith("UPDATE public.v13_production_account"))return {rows:[{id:a.id}]};
   return {rows:[]};
  },release(){}};
 }};
 const deps={db,now:()=>now,sha:()=>sha,
  material:async()=>({keyId:"test",privateKey:"never-disclosed"}),
  read:async()=>{readCalls++;opts.onRead?.();return {ok:true,observedAtMs:now,
    cashMicros:opts.cash??"25000000",orders:[],fills:[],positions:[],settlements:[]};},
  observe:async()=>{modelCalls++;return opts.fee===false?{ok:false,reason:"dynamic_fee_publication_http_429",tradingAuthorized:false}:
   {ok:true,reason:"dynamic_fee_observation_for_review_only",
    model,providerContentChanged:false,tradingAuthorized:false};}
 } as never;
 return {deps,writes,counts:()=>({readCalls,modelCalls})};
}
test("preview does not require another reviewer and keeps approved V4 policy unchanged",async()=>{
 const f=fixture(),res=await previewOwnerV4CommissioningRepair(owner,f.deps);
 assert.equal(res.ok,true,JSON.stringify(res));
 if(res.ok){assert.equal(res.expectedPolicyId,base.policy_id);assert.equal(res.authorityId,authority);assert.equal(res.expectedDeployedSha,sha);assert.equal(res.repaired,false);}
 assert.deepEqual(f.writes,[]);
});
test("owner input, unrelated freeze and stale cash fail closed before issuer or signer",async()=>{
 for(const args of [undefined,{...body,authorityId:"wrong"},
  {...body,provisionalRepairConfirmation:""}, {...body,expectedDeployedSha:"c".repeat(40)}]){
  const f=fixture();
  const res=await repairOwnerV4CommissioningHold(owner,args,f.deps);
  assert.equal(res.ok,false);
  assert.deepEqual(f.writes,[]);
  assert.deepEqual(f.counts(),{readCalls:0,modelCalls:0});
 }
 for(const change of [{blocked_reason:"unresolved_exchange_order"},
                       {reconciled_at:new Date(now-901_000).toISOString()},
                       {kill_switch:false}]){
  const f=fixture(change);
  const res=await repairOwnerV4CommissioningHold(owner,body,f.deps);
  assert.equal(res.ok,false);assert.deepEqual(f.writes,[]);
 }
});
test("signed exchange cash mismatch refuses repair before any monetary grant request",async()=>{
 const f=fixture({}, {cash:"24900000"});
 const res=await repairOwnerV4CommissioningHold(owner,body,f.deps);
 assert.equal(res.ok,false);assert.equal(f.counts().modelCalls,0);
 assert.deepEqual(f.writes,[]);
});
test("provider 429 rejects without writes, grant or alternate review path",async()=>{
 const f=fixture({}, {fee:false});
 const res=await repairOwnerV4CommissioningHold(owner,body,f.deps);
 assert.equal(res.ok,false);assert.match(res.reason,/issuer_fee_/);
 assert.deepEqual(f.writes,[]);
});
test("genuine V4 fee + signed flatness clears only provisional hold and invalidates prior SHA",async()=>{
 const f=fixture();
 const res=await repairOwnerV4CommissioningHold(owner,body,f.deps);
 assert.equal(res.ok,true,JSON.stringify(res));
 if(!res.ok)return;
 assert.equal(res.repaired,true);assert.equal(res.tradingAuthorized,false);
 assert.equal(res.killSwitchChanged,false);assert.equal(res.ordersSubmitted,false);
 const changes=f.writes.join("\n");
 assert.match(changes,/UPDATE public.v13_production_account SET blocked_reason=NULL,revision=revision\+1/);
 assert.match(changes,/AND kill_switch=true/);
 assert.match(changes,/UPDATE private.strata_owner_sha_approvals SET revoked_at=now/);
 assert.match(changes,/OWNER_V4_PROVISIONAL_HOLD_REPAIR/);
 assert.doesNotMatch(changes,/UPDATE public.v13_live_money_policy|SET\s+kill_switch\s*=|SET\s+execution_enabled\s*=/i);
 assert.deepEqual(f.counts(),{readCalls:1,modelCalls:1});
});
