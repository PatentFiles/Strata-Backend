import test from "node:test";
import assert from "node:assert/strict";
import { commissionOwnedAccount, COMMISSION_OWNED_ACCOUNT_CONFIRMATION } from "./personalAccountActivation";
import type { verifyMonetaryFeeContract } from "./monetaryFeeContract";

const OWNER="11111111-1111-4111-8111-111111111111";
const FEE="d".repeat(64);
const fresh=()=>new Date(Date.now()-30_000).toISOString();
const funded=()=>new Date(Date.now()-90_000).toISOString();
function sampleDb(){
 const statements:{sql:string;args?:unknown[]}[]=[];
 const ready={
  id:"account-1",subaccount:1,exchange_index:2,
  key_fingerprint:"a".repeat(64),credential_fingerprint:"a".repeat(64),
  policy_id:"policy-1",policy_state:"APPROVED",
  fee_policy_version:"micro-live-standing-fee-policy-v1",
  fee_source_url:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
  fee_formula_version:"standard-quadratic-0.07-v1",
  configured_stake_cents:150,cash_precision_verified:true,
  cash_micros:"25000000",reconciled_at:fresh(),verified_funding_at:funded(),
  minimum_exit_micros:null,fee_artifact_digest:null,
  commissioned:false,execution_enabled:false,kill_switch:true,
  activation_requests:0,
 };
 const db={query:async(sql:string,args?:unknown[])=>{
  statements.push({sql,args});
  if(sql.includes("personal-activation:readiness"))return {rows:[ready]};
  if(sql.includes("SELECT live_execution_enabled, manual_kill_switch"))
   return {rows:[{live_execution_enabled:false,manual_kill_switch:true}]};
  if(sql.includes("personal-activation:commission"))
   return {rows:[{id:"account-1"}],rowCount:1};
  throw Error("unexpected test query: "+sql.slice(0,80));
 }};
 return {db,statements};
}
const artifact=(async()=>({valid:true,status:"verified" as const,
 sourceUrl:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 digest:FEE,formulaVersion:"standard-quadratic-0.07-v1",
 verifiedAt:Date.now(),reason:null})) as never;
function verifier(source=FEE){
 return (async()=>({ok:true,reason:"provider_monetary_fee_schedule_and_market_verified",
  stage:"STEP_11",sourceDigest:source,monetaryFeeAuthorized:true,
  policyApproved:false,tradingAuthorized:false})) as unknown as typeof verifyMonetaryFeeContract;
}
test("Step 11 requires owner confirmation and cannot write via UI fee flag",async()=>{
 const {db,statements}=sampleDb();
 const result=await commissionOwnedAccount(db,{
  ownerUserId:OWNER,confirmation:"not_confirmed",feeArtifactDigest:FEE,
  minimumExitMicros:10000,verifyFee:artifact,verifyMonetary:verifier()});
 assert.equal(result.reason,"explicit_authorization_required");
 assert.equal(statements.length,0);
});
test("Step 11 accepts matching verified monetary proof and explicit $0.01 floor only",async()=>{
 const {db,statements}=sampleDb();
 const result=await commissionOwnedAccount(db,{
  ownerUserId:OWNER,confirmation:COMMISSION_OWNED_ACCOUNT_CONFIRMATION,
  feeArtifactDigest:FEE,minimumExitMicros:10000,
  verifyFee:artifact,verifyMonetary:verifier()});
 assert.equal(result.ok,true,result.reason);
 const update=statements.find(s=>s.sql.includes("personal-activation:commission"));
 assert.ok(update);
 assert.equal(update.args?.[3],FEE);
 assert.equal(update.args?.[4],10000);
 assert.ok(!statements.some(s=>/UPDATE live_execution_config/i.test(s.sql)));
});
test("Step 11 rejects a different fee digest before commissioning write",async()=>{
 const {db,statements}=sampleDb();
 const result=await commissionOwnedAccount(db,{
  ownerUserId:OWNER,confirmation:COMMISSION_OWNED_ACCOUNT_CONFIRMATION,
  feeArtifactDigest:FEE,minimumExitMicros:10000,
  verifyFee:artifact,verifyMonetary:verifier("e".repeat(64))});
 assert.equal(result.ok,false);
 assert.equal(result.reason,"fee_artifact_unverified");
 assert.ok(!statements.some(s=>s.sql.includes("personal-activation:commission")));
});
