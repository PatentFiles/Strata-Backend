import test from "node:test";
import assert from "node:assert/strict";
import {inspectWalletV4Readiness} from "./walletV4CommissioningReadiness";
import {TEST_TWENTY_PERCENT_PRESET} from "./sharedPresets";
const owner="11111111-1111-4111-8111-111111111111";
const sha="a".repeat(40);
const now=Date.parse("2026-10-23T20:00:00Z");
const row={id:"wallet-test-account",commissioned:true,
 cash_precision_verified:true,reconciled_at:new Date(now-5_000),
 cash_micros:"25000000",reserved_micros:"0",configured_stake_cents:500,
 risk_capital_cents:2500,risk_preset_id:TEST_TWENTY_PERCENT_PRESET.id,
 risk_preset_revision:TEST_TWENTY_PERCENT_PRESET.revision,
 policy_hash:"b".repeat(64)};
test("Wallets owner readiness checks actual saved preset and all current authoritative records but never issues trade grants",async()=>{
 const queries:string[]=[];
 const db={async query(sql:string){queries.push(sql);return {
 rows:queries.length===1?[row]:[{
  model_evidence:true,fee_authority:true,owner_sha_approval:true,
  protective_exit_release:true,
 }]};}};
 const result=await inspectWalletV4Readiness(owner,{db,getSha:()=>sha,now:()=>now});
 assert.equal(result.ok,true);
 assert.equal(result.checks.fiveDollarPreset,true);
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
 assert.equal(stale.checks.fiveDollarPreset,false);
 const down=await inspectWalletV4Readiness(owner,{
  db:{async query():Promise<{rows:Record<string,unknown>[]}>{throw Error("DB unavailable");}},
  getSha:()=>sha,now:()=>now});
 assert.equal(down.ok,false);
 assert.equal(down.tradingAuthorized,false);
});
