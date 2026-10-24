import test from "node:test";
import assert from "node:assert/strict";
import {inspectWalletV4Readiness} from "./walletV4CommissioningReadiness";
import {TEST_TWENTY_PERCENT_PRESET} from "./sharedPresets";
const owner="11111111-1111-4111-8111-111111111111";
const sha="a".repeat(40);
const now=Date.parse("2026-10-23T20:00:00Z");
const row={id:"wallet-test-account",commissioned:true,
 execution_enabled:true,kill_switch:false,blocked_reason:null,
 cash_precision_verified:true,reconciled_at:new Date(now-5_000),
 cash_micros:"25000000",reserved_micros:"0",configured_stake_cents:500,
 risk_capital_cents:2500,risk_preset_id:TEST_TWENTY_PERCENT_PRESET.id,
 risk_preset_revision:TEST_TWENTY_PERCENT_PRESET.revision,
 policy_hash:"b".repeat(64),fee_policy_version:"strata_owner_provider_dynamic_fee_v4",state:"APPROVED",
 capital_limit_cents:2500,max_entry_stake_cents:500,max_entry_all_in_cents:625,
 max_daily_loss_cents:1000,max_total_loss_cents:1500};
test("Wallets owner readiness checks actual saved preset and all current authoritative records but never issues trade grants",async()=>{
 const queries:string[]=[];
 const db={async query(sql:string){queries.push(sql);return {
 rows:queries.length===1?[row]:[{
  model_evidence:true,fee_authority:true,owner_sha_approval:true,
  protective_exit_release:true,
 }]};}};
 const result=await inspectWalletV4Readiness(owner,{db,getSha:()=>sha,now:()=>now});
 assert.equal(result.ok,true);
 assert.equal(result.checks.approvedStakePolicy,true);
 assert.equal(result.checks.feeAuthority,true);
 assert.equal(result.checks.signedPostAuthority,false);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(result.ordersSubmitted,false);
 assert.ok(result.blockers.includes("wallet_v4_signedPostAuthority_required"));
 assert.equal(queries.length,2);
 assert.match(queries[0]!,/a.owner_user_id=\$1::uuid/);
 assert.match(queries[1]!,/g.owner_user_id=\$1::uuid/);
});
test("Missing/ambiguous owned account and unknown deployed SHA always fail closed",async()=>{
 const none=await inspectWalletV4Readiness(owner,{
  db:{async query(){return {rows:[]};}},
  getSha:()=>sha,now:()=>now});
 assert.equal(none.ok,false);
 let queried=0;
 const badSha=await inspectWalletV4Readiness(owner,{
  db:{async query(){queried++;return {rows:[row]};}},
  getSha:()=> "DEPLOYED_SHA_RUNTIME_UNAVAILABLE",now:()=>now});
 assert.equal(badSha.ok,true);
 assert.equal(badSha.checks.feeAuthority,false);
 assert.ok(badSha.blockers.includes("wallet_v4_deployed_sha_unavailable"));
 assert.equal(queried,1);
});
test("Stale cash, unknown stake revision and transient database errors refuse readiness",async()=>{
 const stale=await inspectWalletV4Readiness(owner,{
  db:{async query(){return {rows:[{...row,reconciled_at:new Date(now-900_001),
    risk_preset_revision:-1}]};}},
  getSha:()=>sha,now:()=>now});
 assert.equal(stale.checks.cashReconciled,false);
 assert.equal(stale.checks.approvedStakePolicy,false);
 const down=await inspectWalletV4Readiness(owner,{
  db:{async query():Promise<{rows:Record<string,unknown>[]}>{throw Error("DB unavailable");}},
  getSha:()=>sha,now:()=>now});
 assert.equal(down.ok,false);
 assert.equal(down.tradingAuthorized,false);
});

test("valid arbitrary $50 and $19,457 policies are read back using signed required capital",async()=>{
 for(const [stake,budget,fee] of [[5000,25000,6250],[1945700,9728500,2432125]]){
   const policy={...row,cash_micros:String(budget*10000),reserved_micros:"0",
     configured_stake_cents:stake,risk_capital_cents:budget,
     max_entry_stake_cents:stake,max_entry_all_in_cents:fee,
     capital_limit_cents:budget,max_daily_loss_cents:budget,
     max_total_loss_cents:budget};
   let queries=0;
   const response=await inspectWalletV4Readiness(owner,{
     db:{async query(){queries++;return {rows:queries===1?[policy]:[{
        model_evidence:false,fee_authority:false,owner_sha_approval:false,protective_exit_release:false
     }]};}},getSha:()=>sha,now:()=>now
   });
   assert.equal(response.checks.approvedStakePolicy,true);
   assert.equal(response.checks.cashReconciled,true);
   assert.equal(response.tradingAuthorized,false);
 }
});
test("insufficient capital and malformed policy hash cannot qualify",async()=>{
 const insufficient={...row,cash_micros:"100000",reserved_micros:"0"};
 let r=await inspectWalletV4Readiness(owner,{
  db:{async query(){return {rows:[insufficient]};}},getSha:()=>"",now:()=>now});
 assert.equal(r.checks.cashReconciled,false);
 const invalid={...row,policy_hash:"bad",max_entry_stake_cents:150};
 r=await inspectWalletV4Readiness(owner,{
  db:{async query(){return {rows:[invalid]};}},getSha:()=>"",now:()=>now});
 assert.equal(r.checks.approvedStakePolicy,false);
});


test("Wallets V4 signed POST readiness remains false during account kill, disarm, or commissioning hold",async()=>{
 const authoritative={
  model_evidence:true,fee_authority:true,owner_sha_approval:true,
  protective_exit_release:true,
 };
 const verify=async(account:Record<string,unknown>)=>{
  let reads=0;
  const result=await inspectWalletV4Readiness(owner,{
   db:{async query(){reads++;return {rows:reads===1?[account]:[authoritative]};}},
   getSha:()=>sha,now:()=>now,
   featureState:()=>({signedPost:true,protectiveExit:true}),
  });
  assert.equal(reads,2);
  assert.equal(result.ok,true);
  assert.equal(result.checks.feeAuthority,true);
  assert.equal(result.checks.protectiveExitRelease,true);
  assert.equal(result.tradingAuthorized,false);
  assert.equal(result.ordersSubmitted,false);
  return result;
 };
 const ready=await verify(row);
 assert.equal(ready.checks.signedPostAuthority,true);
 assert.equal(ready.blockers.includes("wallet_v4_account_execution_authority_inactive"),false);
 for(const patch of [
   {kill_switch:true},
   {execution_enabled:false},
   {blocked_reason:"awaiting_account_commissioning"},
   {blocked_reason:"frozen_pending_review"},
   {kill_switch:null},
   {execution_enabled:null},
   {blocked_reason:undefined},
 ]){
   const stopped=await verify({...row,...patch});
   assert.equal(stopped.checks.signedPostAuthority,false,JSON.stringify(patch));
   assert.ok(stopped.blockers.includes("wallet_v4_account_execution_authority_inactive"),
     JSON.stringify(patch));
   assert.ok(stopped.blockers.includes("wallet_v4_signedPostAuthority_required"));
 }
});
