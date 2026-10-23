import test from "node:test";
import assert from "node:assert/strict";
import {migrateOwnedApiFeePolicy,previewOwnedApiFeeMigration,OWNER_API_FEE_MIGRATION_CONFIRM} from "./ownerApiFeePolicyMigration";

const OWNER="11111111-1111-4111-8111-111111111111";
const POLICY="22222222-2222-4222-8222-222222222222";
const HASH="a".repeat(64);
const request={confirmation:OWNER_API_FEE_MIGRATION_CONFIRM,
 expectedPolicyId:POLICY,expectedPolicyHash:HASH,expectedPolicyVersion:1};

test("migration rejects requests without exact owner authorization and expected immutable policy identity",async()=>{
 for(const body of [{},{...request,confirmation:"not-consent"},{...request,expectedPolicyHash:"bad"},
   {...request,expectedPolicyVersion:0},{...request,expectedPolicyId:"other"}]){
  const r=await migrateOwnedApiFeePolicy(OWNER,body);
  assert.equal(r.ok,false);
  assert.equal(r.reason,"explicit_owner_fee_migration_version_confirmation_required");
  assert.equal(r.tradingAuthorized,false);
 }
});

test("authenticated owner cannot migrate without a genuinely reviewed technical grant",async()=>{
 const r=await migrateOwnedApiFeePolicy(OWNER,request,{
  verify:async()=>({ok:false,reason:"api_fee_independent_reviews_missing_or_ambiguous"}) as never,
  db:{connect:async()=>{throw Error("DB should not be touched before proof");}},
 });
 assert.equal(r.ok,false);
 assert.equal(r.reason,"reviewed_api_fee_api_fee_independent_reviews_missing_or_ambiguous");
 assert.equal(r.tradingAuthorized,false);
});

test("migration preview refuses armed accounts and never writes production state",async()=>{
 const statements:string[]=[];
 const db={connect:async()=>({query:async(sql:string)=>{
   statements.push(sql);
   return {rows:[{state:"APPROVED",commissioned:true,
     fee_policy_version:"micro-live-standing-fee-policy-v1",
     execution_enabled:true,kill_switch:false,blocked_reason:null,
     cash_precision_verified:true,reconciled_at:new Date().toISOString()}]};
 },release(){}})};
 const v=await previewOwnedApiFeeMigration(OWNER,{db});
 assert.equal(v.ok,false);
 assert.equal(v.reason,"stop_and_disarm_before_fee_migration");
 assert.equal(statements.length,1);
 assert.match(statements[0]!,/WHERE a.owner_user_id=\$1::uuid AND a.subaccount=1 AND a.exchange_index=2/);
 assert.doesNotMatch(statements.join(" "),/UPDATE|INSERT|DELETE/i);
});

test("migration refuses an armed account before touching policy or exchange balance",async()=>{
 const statements:string[]=[];
 const db={connect:async()=>({query:async(sql:string)=>{
  statements.push(sql);
  if(sql.includes("FROM public.v13_production_account"))return {rows:[{
   id:"22222222-2222-4222-8222-222222222222",
   owner_user_id:OWNER,subaccount:1,exchange_index:2,commissioned:true,
   cash_precision_verified:true,execution_enabled:true,kill_switch:false,
   policy_id:POLICY
  }]};
  return {rows:[]};
 },release(){}})};
 const r=await migrateOwnedApiFeePolicy(OWNER,request,{
  db,verify:async()=>({ok:true,identity:{
   grantId:"33333333-3333-4333-8333-333333333333",
   sourceUrl:"strata-api-reviewed://kxbtc15m/33333333-3333-4333-8333-333333333333",
   digest:HASH,feePolicyVersion:"strata_api_fee_source_signed_review_v2",
   formulaVersion:"standard_quadratic_v1",
   marketTicker:"KXBTC15M-26OCT222015",verifiedAtMs:Date.now()
  }}) as never
 });
 assert.equal(r.ok,false);
 assert.equal(r.reason,"stop_and_disarm_before_fee_migration");
 assert.ok(statements.some(sql=>sql==="ROLLBACK"));
 assert.equal(statements.some(sql=>sql.includes("UPDATE public.v13_live_money_policy")),false);
});
