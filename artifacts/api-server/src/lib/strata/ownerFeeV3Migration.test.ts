import test from "node:test";
import assert from "node:assert/strict";
import {
 migrateOwnedV3FeePolicy,previewOwnedV3FeeMigration,
 OWNER_V3_POLICY_MIGRATION_CONFIRM,v3MigrationFlatHistoryCheck,
} from "./ownerFeeV3Migration";
import {V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION} from "./ownerFeeV3Authority";
import type {Snapshot,Request} from "../v13-production/types";
const OWNER="11111111-1111-4111-8111-111111111111",
  POLICY="22222222-2222-4222-8222-222222222222",
  GRANT="33333333-3333-4333-8333-333333333333",
  HASH="a".repeat(64),SHA="b".repeat(40),
  SOURCE="strata-owner-fee-v3://kxbtc15m/"+GRANT;
const raw={confirmation:OWNER_V3_POLICY_MIGRATION_CONFIRM,
 expectedPolicyId:POLICY,expectedPolicyHash:HASH,expectedPolicyVersion:1,
 expectedV3SourceUrl:SOURCE};

test("V3 migration is feature disabled even with a seemingly valid owner proof",async()=>{
 let calls=0;
 const x=await migrateOwnedV3FeePolicy(OWNER,raw,{enabled:()=>false,
   verify:async()=>{calls++;throw Error("must not check");}});
 assert.equal(x.ok,false);
 assert.equal(x.reason,"owner_v3_fee_policy_migration_feature_disabled");
 assert.equal(calls,0);
 assert.equal(x.policyMigrated,false);
 assert.equal(x.tradingAuthorized,false);
});
test("V3 migration rejects missing exact CAS or consent and invented reviewer grant",async()=>{
 for(const b of [{},{...raw,confirmation:"forged"},
    {...raw,expectedPolicyHash:"bad"},{...raw,expectedV3SourceUrl:"V2-reviewed-fake"},
    {...raw,expectedPolicyVersion:0}]){
  const x=await migrateOwnedV3FeePolicy(OWNER,b,{enabled:()=>true});
  assert.equal(x.ok,false,JSON.stringify(x));
 }
});
test("live 429/expired official PDF prevents V3 migration before any DB write",async()=>{
 let called=false;
 const x=await migrateOwnedV3FeePolicy(OWNER,raw,{
  enabled:()=>true,
  verify:async()=>({ok:false,reason:"official_fee_schedule_http_429"}) as never,
  db:{connect:async()=>{called=true;throw Error("DB must not be touched");}} as never,
 });
 assert.equal(x.ok,false);
 assert.match(x.reason,/owner_v3_fee/);
 assert.equal(called,false);
});
test("V3 preview is non-mutating and distinguishes historical freeze and immutable policy",async()=>{
 const q:string[]=[];
 const db={connect:async()=>({query:async(sql:string)=>{q.push(sql);return {rows:[{
  policy_id:POLICY,policy_hash:HASH,version:1,state:"APPROVED",
  fee_policy_version:"micro-live-standing-fee-policy-v1",
  commissioned:true,execution_enabled:true,kill_switch:true,
  cash_precision_verified:true,reconciled_at:new Date().toISOString(),
  blocked_reason:"awaiting_account_commissioning",
 }]};},release(){}})};
 const x=await previewOwnedV3FeeMigration(OWNER,{db:db as never});
 assert.equal(x.ok,true,JSON.stringify(x));
 if(!x.ok)return;
 assert.equal(x.requiresCommissioningRepair,true);
 assert.equal(x.expectedPolicyId,POLICY);
 assert.equal(x.tradingAuthorized,false);
 assert.equal(q.length,1);
 assert.doesNotMatch(q.join(" " ),/\b(?:UPDATE|INSERT|DELETE)\b/i);
});
test("V3 policy version is distinct from historical V2 reviewed route",()=>{
 assert.equal(V3_FEE_POLICY_VERSION,"strata_owner_official_monetary_fee_v3");
 assert.equal(V3_FEE_FORMULA_VERSION,"standard-quadratic-0.07-v1");
});
test("V3 legacy-marker repair cannot bypass signed history and flatness",()=>{
 const incomplete={authenticated:false,complete:false,cashExact:false,
  unexplainedCashActivity:true,orders:[],fills:[],positions:[]} as unknown as Snapshot;
 assert.deepEqual(v3MigrationFlatHistoryCheck(incomplete,[]),
  {ok:false,reason:"authenticated_exchange_history_incomplete"});
 const open={...incomplete,authenticated:true,complete:true,cashExact:true,
  unexplainedCashActivity:false,positions:[{marketTicker:"KXBTC15M"}]} as unknown as Snapshot;
 assert.deepEqual(v3MigrationFlatHistoryCheck(open,[]),
  {ok:false,reason:"authenticated_exchange_not_flat"});
});
test("V3 policy switch SQL must lock authority AND consent, and require exact stake/preset",async()=>{
 // A source test supplements live PostgreSQL integration tests and never
 // falsely claims a signed provider was queried or commission cleared.
 const source=await import("node:fs").then(fs=>fs.readFileSync(
  "src/lib/strata/ownerFeeV3Migration.ts","utf8"));
 assert.match(source,/FROM private\.strata_owner_fee_authority_v3 g/);
 assert.match(source,/JOIN private\.strata_owner_fee_evidence_v3 e/);
 assert.match(source,/FOR SHARE OF g,e/);
 assert.match(source,/TEST_TWENTY_PERCENT_PRESET_ID/);
 assert.match(source,/migrationFlatHistoryCheck|v3MigrationFlatHistoryCheck/);
 assert.match(source,/BEGIN ISOLATION LEVEL SERIALIZABLE/);
 assert.match(source,/OWNER_V3_FEE_POLICY_MIGRATION/);
 assert.doesNotMatch(source,/UPDATE private\.strata_api_fee_source_grants/);
});
