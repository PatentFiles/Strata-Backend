import {computeV13LiveMoneyPolicyHash,type V13ApprovedLiveMoneyPolicy} from '../v13LiveMoneyRisk';
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_ENTRY_POLICY_VERSION} from '@workspace/v13-strategy';
const OWNER='11111111-1111-4111-8111-111111111111',POLICY='22222222-2222-4222-8222-222222222222',V3_FEE_FORMULA_VERSION='standard-quadratic-0.07-v1';
 const old:V13ApprovedLiveMoneyPolicy={
  id:POLICY,version:1,supersedesPolicyId:null,state:"APPROVED",
  strategyVersion:"V1.3",strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,
  strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,entryPolicyVersion:V13_ENTRY_POLICY_VERSION,
  championSelectionReviewId:"independent-champion",championSelectionEvidenceHash:"b".repeat(64),
  championSelectedBy:OWNER,championSelectedAt:new Date("2026-10-01T00:00:00Z"),
  capitalLimitCents:2500,maxEntryStakeCents:150,maxEntryAllInCents:200,maxOpenPositions:1,
  maxDailyLossCents:500,maxTotalLossCents:1500,maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000,
  feePolicyVersion:'micro-live-standing-fee-policy-v1',
  feeSourceUrl:'https://kalshi.com/docs/kalshi-fee-schedule.pdf',
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

export {row,old,computeV13LiveMoneyPolicyHash};
