import test from "node:test";
import assert from "node:assert/strict";
import {
 migrateOwnedV3FeePolicy,previewOwnedV3FeeMigration,
 OWNER_V3_POLICY_MIGRATION_CONFIRM,v3MigrationFlatHistoryCheck,
 deriveOwnerV3PresetLimits,
} from "./ownerFeeV3Migration";
import {V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION} from "./ownerFeeV3Authority";
import type {Snapshot,Request} from "../v13-production/types";
import {computeV13LiveMoneyPolicyHash,evaluateV13LiveMoneyRisk,type V13ApprovedLiveMoneyPolicy} from "../v13LiveMoneyRisk";
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_ENTRY_POLICY_VERSION} from "@workspace/v13-strategy";
import {TEST_TWENTY_PERCENT_PRESET_ID,TEST_TWENTY_PERCENT_PRESET} from "./sharedPresets";
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

test("V3 policy migration preserves champion and owner risk, invalidates previous approvals without fabricating reviewer",async()=>{
 const accountId="strata-kalshi-owner-opaque-v13-account";
 const now=Date.now();
 const old:V13ApprovedLiveMoneyPolicy={
  id:POLICY,version:1,supersedesPolicyId:null,state:"APPROVED",
  strategyVersion:"V1.3",strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,
  strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,entryPolicyVersion:V13_ENTRY_POLICY_VERSION,
  championSelectionReviewId:"independent-champion",championSelectionEvidenceHash:"b".repeat(64),
  championSelectedBy:OWNER,championSelectedAt:new Date("2026-10-01T00:00:00Z"),
  capitalLimitCents:2500,maxEntryStakeCents:150,maxEntryAllInCents:200,maxOpenPositions:1,
  maxDailyLossCents:500,maxTotalLossCents:1500,maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000,
  feePolicyVersion:"micro-live-standing-fee-policy-v1",
  feeSourceUrl:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
  feeFormulaVersion:V3_FEE_FORMULA_VERSION,requireFullDepth:true,
  entryTimeInForce:"IOC",entryLimitSource:"SIGNAL_REFERENCE_OFFER",
  policyHash:null,createdBy:OWNER,approvedBy:OWNER,approvedAt:new Date("2026-10-01T01:00:00Z"),
 };
 old.policyHash=computeV13LiveMoneyPolicyHash(old);
 const row={
  id:old.id,version:old.version,state:old.state,supersedes_policy_id:old.supersedesPolicyId,
  strategy_version:old.strategyVersion,strategy_parameter_set_id:old.strategyParameterSetId,
  strategy_parameter_hash:old.strategyParameterHash,entry_policy_version:old.entryPolicyVersion,
  champion_selection_review_id:old.championSelectionReviewId,
  champion_selection_evidence_hash:old.championSelectionEvidenceHash,
  champion_selected_by:old.championSelectedBy,champion_selected_at:old.championSelectedAt,
  capital_limit_cents:old.capitalLimitCents,max_entry_stake_cents:old.maxEntryStakeCents,
  max_entry_all_in_cents:old.maxEntryAllInCents,max_open_positions:old.maxOpenPositions,
  max_daily_loss_cents:old.maxDailyLossCents,max_total_loss_cents:old.maxTotalLossCents,
  max_quote_age_ms:old.maxQuoteAgeMs,max_fee_evidence_age_ms:old.maxFeeEvidenceAgeMs,
  fee_policy_version:old.feePolicyVersion,fee_source_url:old.feeSourceUrl,
  fee_formula_version:old.feeFormulaVersion,require_full_depth:old.requireFullDepth,
  entry_time_in_force:old.entryTimeInForce,entry_limit_source:old.entryLimitSource,
  policy_hash:old.policyHash,created_by:old.createdBy,approved_by:old.approvedBy,
  approved_at:old.approvedAt,
 };
 const market="KXBTC15M-26OCT220000";
 const historicalRequest={market,side:"YES",action:"BUY",contracts:1,limitMicros:400000,timeInForce:"IOC",reduceOnly:false,clientOrderId:"historical-reconciled-1"} as const;
 const statements:{sql:string;params?:unknown[]}[]=[];
 const query=async(sql:string,params?:unknown[])=>{
  statements.push({sql,params});
  if(sql.startsWith("BEGIN")||sql.startsWith("SET LOCAL")||sql==="COMMIT"||sql==="ROLLBACK")return {rows:[]};
  if(sql.includes("SELECT * FROM public.v13_production_account"))return {rows:[{
   id:accountId,owner_user_id:OWNER,commissioned:true,cash_precision_verified:true,
   execution_enabled:false,kill_switch:true,blocked_reason:null,policy_id:POLICY,
   cash_micros:"25000000",reserved_micros:"0",reconciled_at:new Date(now).toISOString(),
   key_fingerprint:"b".repeat(64),
  }]};
  if(sql.includes("SELECT\n   (SELECT count(*)::int FROM public.v13_production_intent"))return {rows:[{
   intents:0,positions:0,workers:0,exits:0,
  }]};
  if(sql.includes("FROM private.kalshi_connection_credentials"))return {rows:[{
   decrypted_secret:JSON.stringify({api_key_id:"test-only-id",private_key:"fake-test-only"}),
  }]};
  if(sql.includes("SELECT request FROM public.v13_production_intent"))return {rows:[{request:historicalRequest}]};
  if(sql.includes("SELECT * FROM public.v13_live_money_policy"))return {rows:[row]};
  if(sql.includes("FROM private.strata_owner_fee_authority_v3 g"))
    return {rows:[{authority_id:"33333333-3333-4333-8333-333333333333"}]};
  if(sql.includes("FROM public.strata_configured_stake"))
    return {rows:[{configured_stake_cents:500,risk_preset_id:TEST_TWENTY_PERCENT_PRESET_ID,
      risk_preset_revision:TEST_TWENTY_PERCENT_PRESET.revision,risk_capital_cents:2500}]};
  if(sql.includes("FROM private.kalshi_account_worker_lease"))
    return {rows:[{state:"killed",arm_requested:false,account_kill:true}]};
  if(sql.includes("SELECT COALESCE(MAX(version)"))return {rows:[{last_version:1}]};
  if(sql.includes("UPDATE public.v13_live_money_policy SET state='REVOKED'"))return {rows:[{id:POLICY}]};
  if(sql.includes("INSERT INTO public.v13_live_money_policy"))return {rows:[{id:"new-policy"}]};
  if(sql.includes("UPDATE public.v13_production_account"))return {rows:[{id:accountId}]};
  if(sql.includes("UPDATE private.strata_owner_sha_approvals"))return {rows:[]};
  if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
  throw Error("unexpected SQL in migration test");
 };
 const db={connect:async()=>({query,release(){}})};
 const read=async(_creds:unknown,t:number)=>({ok:true,observedAtMs:t,cashMicros:"25000000",
  orders:[{client_order_id:historicalRequest.clientOrderId,order_id:"historical-order-1",
   status:"executed",ticker:market,book_side:"bid",yes_price_dollars:"0.400000",
   initial_count_fp:"1.00",fill_count_fp:"1.00"}],
  fills:[{order_id:"historical-order-1",trade_id:"historical-fill-1",ticker:market,
   count_fp:"1.00",yes_price_dollars:"0.400000",fee_cost:"0.010000",
   created_time:"2026-10-20T01:00:00Z"}],
  positions:[],
  settlements:[{ticker:market,yes_count_fp:"1.00",no_count_fp:"0.00",
   market_result:"yes",settled_time:"2026-10-20T01:15:00Z",revenue_dollars:"1.000000"}]}) as never;
 const verify=async()=>({ok:true,identity:{
  authorityId:"33333333-3333-4333-8333-333333333333",
  sourceUrl:SOURCE,
  sourceDigest:HASH,releaseCommitSha:SHA,feePolicyVersion:V3_FEE_POLICY_VERSION,
  formulaVersion:V3_FEE_FORMULA_VERSION,marketTicker:"KXBTC15M-26OCT222015",
  verifiedAtMs:now,
 }}) as never;
 const res=await migrateOwnedV3FeePolicy(OWNER,{
  confirmation:OWNER_V3_POLICY_MIGRATION_CONFIRM,expectedPolicyId:POLICY,
  expectedPolicyHash:old.policyHash,expectedPolicyVersion:1,
  expectedV3SourceUrl:SOURCE,
 },{db,read,verify,now:()=>now,enabled:()=>true});
 assert.equal(res.ok,true,JSON.stringify(res));
 if(!res.ok)return;
 assert.equal(res.tradingAuthorized,false);
 assert.equal(res.newVersion,2);
 assert.ok(statements.some(x=>x.sql.includes("SELECT request FROM public.v13_production_intent")));
 assert.equal(statements.some(x=>/DELETE FROM public\.v13_production_(intent|position|observation)/.test(x.sql)),false);
 assert.ok(statements.some(x=>x.sql==="COMMIT"));
 const create=statements.find(x=>x.sql.includes("INSERT INTO public.v13_live_money_policy"));
 assert.ok(create);
 // Superseded V1 still has 150/200 caps. The new policy uses the
 // selected, approved 20% preset: 500 gross, 625 including fees, 1000 daily.
 assert.match(create.sql,/p\.strategy_parameter_hash/);
 assert.match(create.sql,/p\.max_open_positions/);
 assert.doesNotMatch(create.sql,/p\.max_entry_stake_cents/);
 assert.doesNotMatch(create.sql,/p\.max_entry_all_in_cents/);
 assert.match(create.sql,/\$11::int,\$12::int,\$13::int/);
 assert.deepEqual(create.params?.slice(10),[2500,500,625,1000,1500,5000,15000]);
 assert.equal(create.params?.[2],V3_FEE_POLICY_VERSION);
 assert.equal(create.params?.[4],V3_FEE_FORMULA_VERSION);
 const persisted={...old,id:create.params?.[0] as string,version:2,
   supersedesPolicyId:old.id,capitalLimitCents:2500,maxEntryStakeCents:500,
   maxEntryAllInCents:625,maxDailyLossCents:1000,maxTotalLossCents:1500,
   maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000,
   feePolicyVersion:V3_FEE_POLICY_VERSION,feeSourceUrl:SOURCE,
   feeFormulaVersion:V3_FEE_FORMULA_VERSION,approvedBy:OWNER,
   approvedAt:new Date(create.params?.[7] as string)};
 assert.equal(create.params?.[5],computeV13LiveMoneyPolicyHash(persisted));
 const riskInput={policy:{...persisted,policyHash:computeV13LiveMoneyPolicyHash(persisted)},
   plannedGrossCents:500,reservedEntryFeeCents:100,reservedExitFeeCents:25,
   availableCashCents:2500,capitalRemainingCents:2500,openPositions:0,
   realizedDailyLossCents:0,realizedTotalLossCents:0,quoteAgeMs:1000,
   feeEvidenceAgeMs:1000,feePolicyVersion:V3_FEE_POLICY_VERSION,
   feeSourceUrl:SOURCE,feeFormulaVersion:V3_FEE_FORMULA_VERSION,
   feeEvidenceFingerprint:"verified",fullDepthProven:true};
 assert.deepEqual(evaluateV13LiveMoneyRisk(riskInput),{ok:true,plannedAllInCents:625});
 assert.equal(evaluateV13LiveMoneyRisk({...riskInput,reservedExitFeeCents:26}).ok,false);
 assert.equal(evaluateV13LiveMoneyRisk({...riskInput,plannedGrossCents:499}).ok,false);
 assert.ok(statements.some(x=>x.sql.includes("UPDATE private.strata_owner_sha_approvals")));
 assert.ok(statements.some(x=>x.sql.includes("OWNER_V3_FEE_POLICY_MIGRATION")));
 assert.equal(statements.some(x=>/UPDATE public\.live_execution_config|INSERT INTO public\.v13_production_intent/.test(x.sql)),false);
});


test("V3 $5 preset proof is exact-versioned and bounded by authenticated cash",()=>{
 const saved={configured_stake_cents:500,risk_preset_id:TEST_TWENTY_PERCENT_PRESET_ID,
   risk_preset_revision:TEST_TWENTY_PERCENT_PRESET.revision,risk_capital_cents:2500};
 const good=deriveOwnerV3PresetLimits(saved,25_000_000n);
 assert.equal(good.ok,true,JSON.stringify(good));
 if(good.ok)assert.deepEqual(good.limits,{
   capitalLimitCents:2500,maxEntryStakeCents:500,maxEntryAllInCents:625,
   maxDailyLossCents:1000,maxTotalLossCents:1500,
   maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000,
 });
 for(const broken of [
   {...saved,risk_preset_revision:0},
   {...saved,risk_preset_id:"unapproved"},
   {...saved,risk_capital_cents:5000},
   {...saved,configured_stake_cents:499},
   {...saved,risk_preset_revision:null},
 ])assert.equal(deriveOwnerV3PresetLimits(broken,25_000_000n).ok,false,JSON.stringify(broken));
 assert.equal(deriveOwnerV3PresetLimits(saved,24_999_999n).ok,false);
 assert.equal(deriveOwnerV3PresetLimits(saved,-1n).ok,false);
});
