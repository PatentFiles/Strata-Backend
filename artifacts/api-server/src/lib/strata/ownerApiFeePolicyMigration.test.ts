import test from "node:test";
import assert from "node:assert/strict";
import {migrateOwnedApiFeePolicy,previewOwnedApiFeeMigration,OWNER_API_FEE_MIGRATION_CONFIRM,migrationFlatHistoryCheck} from "./ownerApiFeePolicyMigration";
import type {Snapshot,Request} from "../v13-production/types";

import {computeV13LiveMoneyPolicyHash,type V13ApprovedLiveMoneyPolicy} from "../v13LiveMoneyRisk";
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_ENTRY_POLICY_VERSION} from "@workspace/v13-strategy";
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from "./apiFeeSourceStage";

const OWNER="11111111-1111-4111-8111-111111111111";
const POLICY="22222222-2222-4222-8222-222222222222";
const HASH="a".repeat(64);
const acceptedPreviewReadiness=async()=>({ok:true,ownerUserId:OWNER,currentReviewers:1,
 grantId:"33333333-3333-4333-8333-333333333333",ownerConsentRecorded:true,
 grantExpiresAt:new Date(Date.now()+10*60_000).toISOString()}) as never;

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
     policy_id:POLICY,policy_hash:HASH,version:1,
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
 assert.equal(statements.some(sql=>sql.includes("UPDATE public.v13_live_money_policy")),false);
 assert.equal(statements.some(sql=>sql==="BEGIN ISOLATION LEVEL SERIALIZABLE"),false);
});

test("eligible owner receives read-only exact policy identity for subsequent explicit confirm",async()=>{
 const sqls:string[]=[];
 const db={connect:async()=>({query:async(sql:string)=>{
  sqls.push(sql);
  return {rows:[{id:"44444444-4444-4444-8444-444444444444",
   policy_id:POLICY,policy_hash:HASH,version:3,
   state:"APPROVED",commissioned:true,
   fee_policy_version:"micro-live-standing-fee-policy-v1",
   execution_enabled:false,kill_switch:true,blocked_reason:null,
   cash_precision_verified:true,reconciled_at:new Date().toISOString()}]};
 },release(){}})};
 const result=await previewOwnedApiFeeMigration(OWNER,{db,readiness:acceptedPreviewReadiness});
 assert.equal(result.ok,true,JSON.stringify(result));
 if(!result.ok) return;
 assert.equal(result.policyMigrated,false);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(result.expectedPolicyId,POLICY);
 assert.equal(result.expectedPolicyHash,HASH);
 assert.equal(result.expectedPolicyVersion,3);
 assert.equal(sqls.length,1);
 assert.match(sqls[0]!,/p\.policy_hash,p\.version/);
 assert.doesNotMatch(sqls[0]!,/UPDATE|INSERT|DELETE/i);
});

test("owner preview permits killed and stopped account with durable eligibility still enabled",async()=>{
 const queries:string[]=[];
 const db={connect:async()=>({query:async(sql:string)=>{
  queries.push(sql);
  return {rows:[{id:"strata-account-test",policy_id:POLICY,policy_hash:HASH,
   version:1,state:"APPROVED",commissioned:true,
   fee_policy_version:"micro-live-standing-fee-policy-v1",
   execution_enabled:true,kill_switch:true,
   blocked_reason:"awaiting_account_commissioning",
   cash_precision_verified:true,reconciled_at:new Date().toISOString()}]};
 },release(){}})};
 const result=await previewOwnedApiFeeMigration(OWNER,{db,readiness:acceptedPreviewReadiness});
 assert.equal(result.ok,true,JSON.stringify(result));
 if(!result.ok)return;
 assert.equal(result.requiresCommissioningRepair,true);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(queries.some(q=>/UPDATE|INSERT|DELETE/.test(q)),false);
});

test("preview rejects missing, malformed, and future reconciliations instead of falsely showing owner eligibility",async()=>{
 for(const time of [null,"not-a-date",new Date(Date.now()+60_000).toISOString(),
    new Date(Date.now()-16*60_000).toISOString()]){
  let readinessCalled=false;
  const db={connect:async()=>({query:async()=>({rows:[{
   policy_id:POLICY,policy_hash:HASH,version:1,state:"APPROVED",
   commissioned:true,fee_policy_version:"strata_owner_provider_dynamic_fee_v4",
   kill_switch:true,blocked_reason:"awaiting_account_commissioning",
   cash_precision_verified:true,reconciled_at:time,
  }]}),release(){}})};
  const r=await previewOwnedApiFeeMigration(OWNER,{db,readiness:(async()=>{
   readinessCalled=true;return {ok:true};
  }) as never});
  assert.equal(r.ok,false);
  assert.equal(r.reason,"fresh_cash_reconciliation_required");
  assert.equal(readinessCalled,false,"do not request fee status with invalid cash timestamp");
 }
});
test("preview refuses approval sequence until actual independent review, grant, consent and TTL are valid",async()=>{
 const db={connect:async()=>({query:async()=>({rows:[{
  policy_id:POLICY,policy_hash:HASH,version:1,state:"APPROVED",
  commissioned:true,fee_policy_version:"strata_owner_provider_dynamic_fee_v4",
  kill_switch:true,blocked_reason:"awaiting_account_commissioning",
  cash_precision_verified:true,reconciled_at:new Date().toISOString(),
 }]}),release(){}})};
 const base={ok:true,ownerUserId:OWNER,currentReviewers:1,
  grantId:"33333333-3333-4333-8333-333333333333",ownerConsentRecorded:true,
  grantExpiresAt:new Date(Date.now()+10*60_000).toISOString()};
 const cases=[
  [{...base,currentReviewers:0},"independent_api_fee_review_required"],
  [{...base,grantId:null},"owner_reviewed_api_fee_grant_required"],
  [{...base,ownerConsentRecorded:false},"owner_reviewed_api_fee_consent_required"],
  [{...base,grantExpiresAt:new Date(Date.now()+10_000).toISOString()},"reviewed_api_fee_grant_expires_too_soon"],
  [{...base,ownerUserId:"99999999-9999-4999-8999-999999999999"},"reviewed_api_fee_readiness_unavailable"],
 ] as const;
 for(const [response,expected] of cases){
  const r=await previewOwnedApiFeeMigration(OWNER,{db,readiness:async()=>response as never});
  assert.equal(r.ok,false,expected);
  assert.equal(r.reason,expected);
  assert.equal(r.tradingAuthorized,false);
 }
});
test("legacy commissioning sentinel needs a SECOND exact owner confirmation and never silently clears",async()=>{
 const statements:string[]=[];
 const db={connect:async()=>({query:async(sql:string)=>{
  statements.push(sql);
  if(sql.includes("FROM public.v13_production_account"))return {rows:[{
   id:POLICY,owner_user_id:OWNER,commissioned:true,cash_precision_verified:true,
   execution_enabled:false,kill_switch:true,policy_id:POLICY,
   blocked_reason:"awaiting_account_commissioning",cash_micros:"25000000",
   reserved_micros:"0",reconciled_at:new Date().toISOString()
  }]};
  return {rows:[]};
 },release(){}})};
 const verify=async()=>({
  ok:true,reason:"reviewed_api_fee_source_stage_current",
  identity:{grantId:"33333333-3333-4333-8333-333333333333",
   sourceUrl:"strata-api-reviewed://kxbtc15m/33333333-3333-4333-8333-333333333333",
   digest:HASH,feePolicyVersion:"strata_api_fee_source_signed_review_v2",
   formulaVersion:"standard_quadratic_v1",marketTicker:"KXBTC15M-26OCT222015",
   verifiedAtMs:Date.now()}
 }) as never;
 const r=await migrateOwnedApiFeePolicy(OWNER,request,{db,verify});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"explicit_owner_commissioning_repair_confirmation_required");
 assert.equal(statements.some(sql=>/UPDATE public\.v13_(live_money_policy|production_account)/.test(sql)),false);
 assert.equal(statements.some(sql=>sql==="BEGIN ISOLATION LEVEL SERIALIZABLE"),false);
});

test("versioned migration atomically replaces ONLY the fee source, retains risk and champion, and invalidates old owner release",async()=>{
 const accountId="strata-kalshi-owner-opaque-v13-account";
 const now=Date.now();
 const old:V13ApprovedLiveMoneyPolicy={
  id:POLICY,version:1,supersedesPolicyId:null,state:"APPROVED",
  strategyVersion:"V1.3",strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,
  strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,entryPolicyVersion:V13_ENTRY_POLICY_VERSION,
  championSelectionReviewId:"independent-champion",championSelectionEvidenceHash:"b".repeat(64),
  championSelectedBy:OWNER,championSelectedAt:new Date("2026-10-01T00:00:00Z"),
  capitalLimitCents:2500,maxEntryStakeCents:150,maxEntryAllInCents:200,maxOpenPositions:1,
  maxDailyLossCents:250,maxTotalLossCents:500,maxQuoteAgeMs:1000,maxFeeEvidenceAgeMs:1000,
  feePolicyVersion:"micro-live-standing-fee-policy-v1",
  feeSourceUrl:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
  feeFormulaVersion:API_SOURCE_FORMULA_VERSION,requireFullDepth:true,
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
  if(sql.includes("FROM private.strata_api_fee_source_grants g"))return {rows:[{grant_id:"33333333-3333-4333-8333-333333333333"}]};
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
  grantId:"33333333-3333-4333-8333-333333333333",
  sourceUrl:"strata-api-reviewed://kxbtc15m/33333333-3333-4333-8333-333333333333",
  digest:HASH,feePolicyVersion:API_SOURCE_POLICY_VERSION,
  formulaVersion:API_SOURCE_FORMULA_VERSION,marketTicker:"KXBTC15M-26OCT222015",
  verifiedAtMs:now,
 }}) as never;
 const res=await migrateOwnedApiFeePolicy(OWNER,{
  confirmation:OWNER_API_FEE_MIGRATION_CONFIRM,expectedPolicyId:POLICY,
  expectedPolicyHash:old.policyHash,expectedPolicyVersion:1,
 },{db,read,verify,now:()=>now});
 assert.equal(res.ok,true,JSON.stringify(res));
 if(!res.ok)return;
 assert.equal(res.tradingAuthorized,false);
 assert.equal(res.newVersion,2);
 assert.ok(statements.some(x=>x.sql.includes("SELECT request FROM public.v13_production_intent")));
 assert.equal(statements.some(x=>/DELETE FROM public\.v13_production_(intent|position|observation)/.test(x.sql)),false);
 assert.ok(statements.some(x=>x.sql==="COMMIT"));
 const create=statements.find(x=>x.sql.includes("INSERT INTO public.v13_live_money_policy"));
 assert.ok(create);
 // All existing entry, position, capital, and drawdown rules are copied,
 // only fee-source identity values are substituted.
 assert.match(create.sql,/p\.strategy_parameter_hash/);
 assert.match(create.sql,/p\.max_open_positions/);
 assert.match(create.sql,/p\.max_entry_stake_cents/);
 assert.match(create.sql,/p\.max_total_loss_cents/);
 assert.equal(create.params?.[2],API_SOURCE_POLICY_VERSION);
 assert.equal(create.params?.[4],API_SOURCE_FORMULA_VERSION);
 assert.ok(statements.some(x=>x.sql.includes("UPDATE private.strata_owner_sha_approvals")));
 assert.ok(statements.some(x=>x.sql.includes("OWNER_API_FEE_POLICY_MIGRATION")));
 assert.equal(statements.some(x=>/UPDATE public\.live_execution_config|INSERT INTO public\.v13_production_intent/.test(x.sql)),false);
});

test("completed history remains migratable; UNKNOWN, missing orders, open positions and incomplete snapshots fail closed",()=>{
 const request:Request={market:"KXBTC15M-26OCT220000",side:"YES",action:"BUY",
   contracts:1,limitMicros:400000,timeInForce:"IOC",reduceOnly:false,clientOrderId:"historical-1"};
 const flat:Snapshot={
  identity:{subaccount:1,exchangeIndex:2,keyFingerprint:HASH},
  observedAtMs:Date.now(),complete:true,authenticated:true,historyFromMs:0,
  cashMicros:"25000000",cashExact:true,unexplainedCashActivity:false,
  orders:[{orderId:"terminal-history",request,terminal:true,filledHundredths:"100"}],
  fills:[{id:"historical-fill",orderId:"terminal-history",clientOrderId:"historical-1",
    market:request.market,side:"YES",action:"BUY",quantityHundredths:"100",
    priceMicros:400000,grossMicros:"400000",feeMicros:"10000",occurredAtMs:Date.now()-60_000}],
  settlements:[{id:"historical-settlement",market:request.market,side:"YES",result:"YES",
    quantityHundredths:"100",payoutMicros:"1000000",feeMicros:"0",occurredAtMs:Date.now()-30_000}],
  positions:[],
 };
 assert.deepEqual(migrationFlatHistoryCheck(flat,[request]),{ok:true});
 assert.equal(migrationFlatHistoryCheck({...flat,orders:[]},[request]).ok,false);
 assert.deepEqual(migrationFlatHistoryCheck({...flat,fills:[]},[request]),{
   ok:false,reason:"authenticated_exchange_fills_unreconciled"
 });
 assert.equal(migrationFlatHistoryCheck({...flat,orders:[{...flat.orders[0]!,filledHundredths:"200"}]},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck({...flat,fills:[...flat.fills,{...flat.fills[0]!,id:"double-counted-fill"}]},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck({...flat,orders:[{...flat.orders[0]!,terminal:false}]},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck({...flat,positions:[{market:request.market,side:"YES",quantityHundredths:"100"}]},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck({...flat,complete:false},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck({...flat,authenticated:false},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck({...flat,cashExact:false},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck({...flat,unexplainedCashActivity:true},[request]).ok,false);
 assert.equal(migrationFlatHistoryCheck(flat,[request,request]).ok,false);
});
