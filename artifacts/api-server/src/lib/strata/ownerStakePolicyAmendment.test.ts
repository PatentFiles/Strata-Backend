import test from "node:test";
import assert from "node:assert/strict";
import {computeV13LiveMoneyPolicyHash,type V13ApprovedLiveMoneyPolicy} from "../v13LiveMoneyRisk";
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_ENTRY_POLICY_VERSION} from "@workspace/v13-strategy";
import {amendOwnedStakePolicy,OWNER_STAKE_POLICY_CONFIRM} from "./ownerStakePolicyAmendment";
import {STANDARD_PROPORTIONAL_PRESET,TEST_TWENTY_PERCENT_PRESET} from "./sharedPresets";

const OWNER="11111111-1111-4111-8111-111111111111";
const ACCOUNT="owned-funded-account";
const old:V13ApprovedLiveMoneyPolicy={
 id:"approved-policy-1",version:1,supersedesPolicyId:null,state:"APPROVED",
 strategyVersion:"V1.3",strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,
 strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,entryPolicyVersion:V13_ENTRY_POLICY_VERSION,
 championSelectionReviewId:"independent-champion",championSelectionEvidenceHash:"b".repeat(64),
 championSelectedBy:OWNER,championSelectedAt:new Date("2026-10-01T00:00:00Z"),
 capitalLimitCents:1000,maxEntryStakeCents:150,maxEntryAllInCents:250,maxOpenPositions:1,
 maxDailyLossCents:300,maxTotalLossCents:500,maxQuoteAgeMs:1000,maxFeeEvidenceAgeMs:1000,
 feePolicyVersion:"standing-fee-v1",feeSourceUrl:"https://example.com/official-schedule",
 feeFormulaVersion:"standard-quadratic-0.07-v1",requireFullDepth:true,
 entryTimeInForce:"IOC",entryLimitSource:"SIGNAL_REFERENCE_OFFER",
 policyHash:null,createdBy:OWNER,approvedBy:OWNER,approvedAt:new Date("2026-10-01T01:00:00Z"),
};
old.policyHash=computeV13LiveMoneyPolicyHash(old);
const policyRow={
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
 fee_policy_version:old.feePolicyVersion,fee_source_url:old.feeSourceUrl,fee_formula_version:old.feeFormulaVersion,
 require_full_depth:old.requireFullDepth,entry_time_in_force:old.entryTimeInForce,
 entry_limit_source:old.entryLimitSource,policy_hash:old.policyHash,created_by:old.createdBy,
 approved_by:old.approvedBy,approved_at:old.approvedAt,
};
function mock(availableMicros="5000000") {
 const sqls:string[]=[];
 const query=async(sql:string)=> {
  sqls.push(sql);
  if(sql.startsWith("BEGIN")||sql.startsWith("SET LOCAL")||sql==="ROLLBACK"||sql==="COMMIT")return {rows:[]};
  if(sql.includes("SELECT * FROM public.v13_production_account"))
   return {rows:[{id:ACCOUNT,owner_user_id:OWNER,commissioned:true,cash_precision_verified:true,
    policy_id:old.id,cash_micros:availableMicros,reserved_micros:"0",
    reconciled_at:new Date().toISOString(),fee_artifact_digest:"a".repeat(64),commissioning_digest:"b".repeat(64),
    minimum_exit_micros:10000}]};
  if(sql.includes("SELECT\n      (SELECT count(*)::int FROM public.v13_production_position"))
   return {rows:[{positions:0,unresolved:0,running:0}]};
  if(sql.includes("SELECT revision FROM public.strata_configured_stake"))return {rows:[{revision:1}]};
  if(sql.includes("SELECT * FROM public.v13_live_money_policy"))return {rows:[policyRow]};
  if(sql.includes("SELECT COALESCE(MAX(version)"))return {rows:[{last_version:1}]};
  if(sql.includes("UPDATE public.v13_live_money_policy SET state='REVOKED'"))return {rows:[{id:old.id}]};
  if(sql.includes("INSERT INTO public.v13_live_money_policy"))return {rows:[{id:"new-policy"}]};
  if(sql.includes("UPDATE public.v13_production_account SET policy_id"))return {rows:[{id:ACCOUNT}]};
  if(sql.includes("INSERT INTO public.strata_configured_stake"))return {rows:[{revision:2}]};
  if(sql.includes("SELECT EXISTS(SELECT 1 FROM public.v13_production_observation"))return {rows:[{requested:false}]};
  if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
  throw Error("unrecognized query");
 };
 const db={connect:async()=>({query,release(){}})};
 return {db,sqls};
}

test("a risk-policy increase cannot be authorized by stake amount alone",async()=>{
 const h=mock();
 const no=await amendOwnedStakePolicy(h.db,OWNER,ACCOUNT,500,1);
 assert.equal(no.ok,false);
 assert.equal(no.reason,"explicit_owner_risk_policy_consent_required");
 assert.equal(h.sqls.includes("ROLLBACK"),true);
 assert.equal(h.sqls.some(s=>s.includes("UPDATE public.v13_live_money_policy")),false);
 assert.equal(h.sqls.some(s=>s.includes("INSERT INTO public.strata_configured_stake")),false);
});
test("explicit owner consent atomically versions, audits and saves without START",async()=>{
 const h=mock();
 const ok=await amendOwnedStakePolicy(h.db,OWNER,ACCOUNT,500,1,OWNER_STAKE_POLICY_CONFIRM);
 assert.equal(ok.ok,true,JSON.stringify(ok));
 assert.equal(h.sqls.some(s=>s.includes("OWNER_STAKE_POLICY_AMENDMENT")),true);
 assert.equal(h.sqls.includes("COMMIT"),true);
 assert.equal(h.sqls.some(s=>/kalshiPost|submitOrder|workerStarted|UPDATE public.live_execution_config/.test(s)),false);
});
test("stake beyond $25,000 is rejected before any DB side effect",async()=>{
 const h=mock();
 const bad=await amendOwnedStakePolicy(h.db,OWNER,ACCOUNT,2_500_001,1,OWNER_STAKE_POLICY_CONFIRM);
 assert.equal(bad.ok,false);
 assert.equal(h.sqls.length,0);
});

test("explicitly chosen standard preset atomically derives matching $25 capital, 6% stake and policy ceilings",async()=>{
 const h=mock("25000000");
 const preset=STANDARD_PROPORTIONAL_PRESET;
 const chosen={presetId:preset.id,presetRevision:preset.revision,capitalBudgetCents:2500};
 const ok=await amendOwnedStakePolicy(h.db,OWNER,ACCOUNT,150,1,
   OWNER_STAKE_POLICY_CONFIRM,chosen);
 assert.equal(ok.ok,true,JSON.stringify(ok));
 assert.ok(h.sqls.some(s=>s.includes("risk_preset_id,risk_preset_revision,risk_capital_cents")));
 assert.ok(h.sqls.some(s=>s.includes("UPDATE public.v13_live_money_policy SET state='REVOKED'")));
 assert.ok(h.sqls.some(s=>s.includes("INSERT INTO public.v13_production_observation")));
 assert.ok(h.sqls.includes("COMMIT"));
});

test("a spoofed stale preset amount is rejected before risk-policy mutation",async()=>{
 const h=mock("25000000");
 const preset=STANDARD_PROPORTIONAL_PRESET;
 const chosen={presetId:preset.id,presetRevision:preset.revision,capitalBudgetCents:2500};
 const bad=await amendOwnedStakePolicy(h.db,OWNER,ACCOUNT,2000,1,
   OWNER_STAKE_POLICY_CONFIRM,chosen);
 assert.deepEqual(bad,{ok:false,reason:"stake_must_match_selected_proportional_preset"});
 assert.ok(h.sqls.includes("ROLLBACK"));
 assert.equal(h.sqls.some(s=>s.includes("UPDATE public.v13_live_money_policy")),false);
 assert.equal(h.sqls.some(s=>s.includes("INSERT INTO public.strata_configured_stake")),false);
});

test("20% $5 owner-approved test preset versions the live policy without arming",async()=>{
 const h=mock("25000000"),preset=TEST_TWENTY_PERCENT_PRESET;
 const result=await amendOwnedStakePolicy(h.db,OWNER,ACCOUNT,500,1,
  OWNER_STAKE_POLICY_CONFIRM,
  {presetId:preset.id,presetRevision:preset.revision,capitalBudgetCents:2500});
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.ok(h.sqls.some(x=>x.includes("UPDATE public.v13_live_money_policy SET state='REVOKED'")));
 assert.ok(h.sqls.some(x=>x.includes("risk_preset_id,risk_preset_revision,risk_capital_cents")));
 assert.ok(!h.sqls.some(x=>x.includes("UPDATE public.live_execution_config")));
 assert.ok(h.sqls.includes("COMMIT"));
});
test("20% preset cannot be used to exceed the verified capital or silently replace 6%",async()=>{
 const h=mock("25000000");
 const p=TEST_TWENTY_PERCENT_PRESET;
 const excessive=await amendOwnedStakePolicy(h.db,OWNER,ACCOUNT,5_000,1,
  OWNER_STAKE_POLICY_CONFIRM,
  {presetId:p.id,presetRevision:p.revision,capitalBudgetCents:25_000});
 assert.equal(excessive.ok,false);
 assert.equal(h.sqls.some(x=>x.includes("UPDATE public.v13_live_money_policy")),false);
});
