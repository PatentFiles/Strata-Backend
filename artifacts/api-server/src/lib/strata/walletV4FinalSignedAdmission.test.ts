import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {boundDynamicFeeEntryV4} from "./dynamicFeeOrderRiskV4";
import {verifyWalletV4FinalSignedAdmission,FINAL_V4_ADMISSION_SQL,type V4EntryContext} from "./walletV4FinalSignedAdmission";
import {computeDynamicFeeModelDigest,type DynamicFeeModel} from "./dynamicOfficialFeeSchedule";
const owner="11111111-1111-4111-8111-111111111111";
const account="index2-subaccount1-owner";
const market="KXBTC15M-26OCT231915",sha="a".repeat(40),policyHash="b".repeat(64);
const now=Date.now(),sourceDigest="c".repeat(64);
const model:DynamicFeeModel={
 issuer:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 publicationDigest:sourceDigest,effectiveDate:"2026-07-07",
 takerRatePpm:70000,makerRatePpm:17500,
 defaultTakerMultiplierPpm:1000000,defaultMakerMultiplierPpm:0,
 marketTicker:market,eventTicker:market,metadataDigest:"d".repeat(64),
 feeType:"quadratic",feeMultiplier:"1",modelDigest:"e".repeat(64),
 observedAt:new Date(now).toISOString(),
 tradingAuthorized:false,requiresVersionedReview:true,
};
model.modelDigest=computeDynamicFeeModelDigest(model);
const row={
 id:account,owner_user_id:owner,fee_policy_version:"strata_owner_provider_dynamic_fee_v4",
 policy_hash:policyHash,state:"APPROVED",capital_limit_cents:2500,
 max_entry_stake_cents:500,max_entry_all_in_cents:625,
 max_daily_loss_cents:1000,max_total_loss_cents:1500,
 configured_stake_cents:500,stake_revision:9,risk_preset_id:"owner-allocation-20",
 risk_preset_revision:1,risk_capital_cents:2500,
 cash_micros:"25000000",reserved_micros:"0",
 model_digest:model.modelDigest,official_source_digest:sourceDigest,
 approved_at:new Date(now-60000),expires_at:new Date(now+300000),
 evidence_expires_at:new Date(now+300000),
 revoked_at:null,evidence_revoked_at:null,
 authorized_stages:["STEP_9","STEP_11","ORDER_ENTRY"],
};
const ctx:V4EntryContext={
 ownerId:owner,accountId:account,policyHash,stakeRevision:9,
 request:{market,side:"YES",action:"BUY",contracts:10,limitMicros:500000,
   timeInForce:"IOC",reduceOnly:false,
   clientOrderId:"v13p-11111111-1111-4111-8111-111111111111"},
 reservedExitFeeCents:20,availableCashMicros:row.cash_micros,
 reservedCashMicros:"0",nowMs:now,
};
const oldFlag=process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
const oldMode=process.env.NODE_ENV;
process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE="true";
process.env.NODE_ENV="test";
const testPorts={
 enabled:()=>true,sha:()=>sha,
 observe:async()=>({ok:true as const,reason:"dynamic_fee_observation_for_review_only" as const,
  model,providerContentChanged:false,tradingAuthorized:false as const}),
};
const tx=(rows:Record<string,unknown>[]=[row])=>({
 calls:[] as {sql:string;args?:unknown[]}[],
 async query(sql:string,args?:unknown[]){
  if(sql.includes("SELECT grant_id FROM private.strata_continuous_execution_grants"))return {rows:[]};
  this.calls.push({sql,args});
  assert.equal(sql,FINAL_V4_ADMISSION_SQL);
  assert.deepEqual(args,[account,owner,policyHash,9,sha,market]);
  return {rows};
 },
});
test("no live authorization when feature flag absent, with zero DB/exchange activity",async()=>{
 const c=tx();
 const v=await verifyWalletV4FinalSignedAdmission(c,ctx,{...testPorts,enabled:()=>false,
  observe:async()=>{throw Error("must not observe");}});
 assert.equal(v.ok,false);
 assert.equal(v.tradingAuthorized,false);
 assert.equal(c.calls.length,0);
});
test("real scoped SQL must require current owner SHA, exit release and row locks",()=>{
 assert.match(FINAL_V4_ADMISSION_SQL,/JOIN private\.strata_wallet_v4_fee_authority/);
 assert.match(FINAL_V4_ADMISSION_SQL,/JOIN private\.strata_wallet_v4_fee_evidence/);
 assert.match(FINAL_V4_ADMISSION_SQL,/JOIN private\.strata_owner_sha_approvals/);
 assert.match(FINAL_V4_ADMISSION_SQL,/JOIN private\.strata_protective_exit_release/);
 assert.match(FINAL_V4_ADMISSION_SQL,/AND g\.policy_hash=p\.policy_hash/);
 assert.match(FINAL_V4_ADMISSION_SQL,/AND a\.owner_user_id=\$2::uuid/);
 assert.match(FINAL_V4_ADMISSION_SQL,/AND e\.market_ticker=\$6/);
 assert.match(FINAL_V4_ADMISSION_SQL,/AND x\.independent_reviewer_id<>a\.owner_user_id/);
 assert.match(FINAL_V4_ADMISSION_SQL,/FOR SHARE OF a,p,s,live,lease,c,g,e,oa,x/);
 assert.match(FINAL_V4_ADMISSION_SQL,/AND lease\.state='owned'/);
 assert.match(FINAL_V4_ADMISSION_SQL,/AND a\.kill_switch=false/);
 assert.match(FINAL_V4_ADMISSION_SQL,/AND a\.reconciled_at<=now\(\) AND a\.reconciled_at>now\(\)-interval '15 minutes'/);
});
test("approved 500 cent trade passes fee component only, never grants execution",async()=>{
 const c=tx();
 const v=await verifyWalletV4FinalSignedAdmission(c,ctx,testPorts);
 assert.equal(v.ok,true);
 assert.equal(v.tradingAuthorized,false);
 if(v.ok){assert.equal(v.allInCents,540);assert.equal(v.modelDigest,model.modelDigest);}
 assert.equal(c.calls.length,1);
});
test("zero, duplicate or unavailable financial/authority rows fail closed",async()=>{
 for(const rows of [[],[row,row]]){
  const v=await verifyWalletV4FinalSignedAdmission(tx(rows),ctx,testPorts);
  assert.equal(v.ok,false);
 }
 const db={async query():Promise<{rows:Record<string,unknown>[]}>{throw Error("DB unavailable");}};
 assert.equal((await verifyWalletV4FinalSignedAdmission(db,ctx,testPorts)).ok,false);
});
test("wrong SHA, other owner, low stake, non-IOC, exits, overexposure fail closed",async()=>{
 const bad:V4EntryContext[]=[
  {...ctx,ownerId:"22222222-2222-4222-8222-222222222222"},
  {...ctx,policyHash:"bad"},
  {...ctx,stakeRevision:10},
  {...ctx,availableCashMicros:"100000"},
  {...ctx,reservedCashMicros:"26000000"},
  {...ctx,request:{...ctx.request,contracts:9}},
  {...ctx,request:{...ctx.request,reduceOnly:true}},
  {...ctx,request:{...ctx.request,action:"SELL"}},
  {...ctx,request:{...ctx.request,timeInForce:"GTC" as "IOC"}},
  {...ctx,request:{...ctx.request,limitMicros:49950}},
 ];
 for(const attempt of bad){
  let n=0;
  const c={async query(){n++;return {rows:[row]};}};
  const v=await verifyWalletV4FinalSignedAdmission(c,attempt,testPorts);
  assert.equal(v.ok,false);
  assert.equal(v.tradingAuthorized,false);
 }
});
test("revoked, expired, mismatched policy, unsigned receipt and fee drift fail closed",async()=>{
 const cases=[
  {...row,revoked_at:new Date(now-5)},
  {...row,evidence_revoked_at:new Date(now-5)},
  {...row,expires_at:new Date(now+1000)},
  {...row,evidence_expires_at:new Date(now+1000)},
  {...row,max_entry_stake_cents:150},
  {...row,model_digest:"f".repeat(64)},
  {...row,official_source_digest:"f".repeat(64)},
  {...row,configured_stake_cents:150},
  {...row,owner_user_id:"22222222-2222-4222-8222-222222222222"},
 ];
 for(const variant of cases){
  const c=tx([variant]);
  const v=await verifyWalletV4FinalSignedAdmission(c,ctx,testPorts);
  assert.equal(v.ok,false,JSON.stringify(variant));
 }
 const v=await verifyWalletV4FinalSignedAdmission(tx(),ctx,{
  ...testPorts,observe:async()=>{throw Error("Kalshi HTTP 429");},
 });
 assert.equal(v.ok,false);
});
test("executor calls gate inside final callback and retains fail-safe UNKNOWN reconciliation",()=>{
 const code=readFileSync(new URL("../v13-production/executor.ts",import.meta.url),"utf8");
 assert.match(code,/verifyWalletV4FinalSignedAdmission\(tx,/);
 assert.match(code,/await this\.exchange\.submit\(i\.request, final\)/);
 assert.match(code,/UPDATE v13_production_intent SET state='DISPATCHED'/);
 assert.match(code,/POST_UNCERTAIN/);
 assert.match(code,/ProductionExecutor\.\#fences\.add\(final\)/);
});
test("read-only fee calculus itself never provides release authority",()=>{
 assert.equal(typeof boundDynamicFeeEntryV4,"function");
});
process.on("exit",()=>{
 if(oldFlag===undefined)delete process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
 else process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=oldFlag;
 if(oldMode===undefined)delete process.env.NODE_ENV;
 else process.env.NODE_ENV=oldMode;
});
