/**
 * #165: owner-only five-gate RELEASE EVIDENCE audit; non-authorizing.
 * Uses existing, independently guarded fee-path readbacks and adds precise
 * financial-ledger diagnostics. Never fetches a fee PDF, signs a Kalshi request,
 * clears a kill, creates an approval, or submits an order.
 */
import {pool} from "@workspace/db";
import {inspectApiFeeSourceReadiness} from "./apiFeeHumanApprovals";
import {inspectWalletV4Readiness} from "./walletV4CommissioningReadiness";
import {approvedDynamicStakeSnapshot} from "./approvedDynamicStakeSnapshot";

type Db={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeInteger=(v:unknown):number|null=>{
 if(typeof v==="number"&&Number.isSafeInteger(v))return v;
 if(typeof v==="string"&&/^(0|[1-9]\\d*)$/.test(v)){
  const n=Number(v);return Number.isSafeInteger(n)?n:null;
 }
 return null;
};
/** V4's signed gate deliberately rejects reviewed-API policy versions.
 * This separate readback verifies only persisted, coherent $5 risk limits
 * for a reviewed-API policy; it NEVER authorizes that policy or an order.
 */
const reviewedApiFiveDollarSnapshot=(row:Record<string,unknown>):boolean=>{
 if(row.fee_policy_version!=="strata_api_fee_source_signed_review_v2"||
    row.state!=="APPROVED"||
    typeof row.policy_hash!=="string"||!/^[a-f0-9]{64}$/.test(row.policy_hash))return false;
 const stake=safeInteger(row.configured_stake_cents);
 const max=safeInteger(row.max_entry_stake_cents);
 const allIn=safeInteger(row.max_entry_all_in_cents);
 const capital=safeInteger(row.capital_limit_cents);
 const budget=safeInteger(row.risk_capital_cents);
 const daily=safeInteger(row.max_daily_loss_cents);
 const total=safeInteger(row.max_total_loss_cents);
 const revision=safeInteger(row.risk_preset_revision);
 return stake===500&&max===500&&allIn!==null&&allIn>=500&&
   capital!==null&&capital>=allIn&&budget===capital&&
   daily!==null&&daily>0&&daily<=capital&&
   total!==null&&total>0&&total<=capital&&
   revision!==null&&revision>=1&&
   typeof row.risk_preset_id==="string"&&row.risk_preset_id.length>0&&
   row.risk_preset_id.length<=120;
};
type Gate={recordPresent:boolean;verifiedInThisRequest:false};
type Result={
 ok:boolean;reason:string;readOnly:true;tradingAuthorized:false;ordersSubmitted:false;
 policyPath:"reviewed_api_v2"|"dynamic_v4"|"unrecognized";
 fee:{independentReview:Gate;reviewedApiGrant:Gate;ownerFeeConsent:Gate;
      v4Evidence:Gate;v4Authority:Gate};
 cash:{persistedReconciliationFresh:boolean;localExposureFlat:boolean;
       signedExchangeReconciliationPerformed:false};
 exit:{protectiveRelease:Gate};
 owner:{exactShaApproval:Gate};
 account:{commissioned:boolean;fiveDollarPolicyApproved:boolean;killSwitchOn:boolean};
 deployedSha:string|null;remaining:string[];
};
const gate=(value=false):Gate=>({recordPresent:value,verifiedInThisRequest:false});
const empty=(reason:string):Result=>({
 ok:false,reason,readOnly:true,tradingAuthorized:false,ordersSubmitted:false,
 policyPath:"unrecognized",
 fee:{independentReview:gate(),reviewedApiGrant:gate(),ownerFeeConsent:gate(),
      v4Evidence:gate(),v4Authority:gate()},
 cash:{persistedReconciliationFresh:false,localExposureFlat:false,signedExchangeReconciliationPerformed:false},
 exit:{protectiveRelease:gate()},owner:{exactShaApproval:gate()},
 account:{commissioned:false,fiveDollarPolicyApproved:false,killSwitchOn:true},
 deployedSha:null,remaining:[reason],
});
/** SQL reads no credential, auth user identifier, or source artifact bytes. */
const LEDGER_SQL=[
 "SELECT a.id,a.commissioned,a.kill_switch,a.cash_precision_verified,a.reconciled_at,",
 "p.fee_policy_version,p.state,p.policy_hash,p.capital_limit_cents,",
 "p.max_entry_stake_cents,p.max_entry_all_in_cents,p.max_daily_loss_cents,p.max_total_loss_cents,",
 "s.configured_stake_cents,s.risk_capital_cents,s.risk_preset_id,s.risk_preset_revision,",
 "(SELECT count(*)::int FROM public.v13_production_intent i",
 " WHERE i.account_id=a.id AND i.terminal IS DISTINCT FROM TRUE) open_intents,",
 "(SELECT count(*)::int FROM public.v13_production_position pos",
 " WHERE pos.account_id=a.id AND pos.quantity_hundredths<>0) open_positions,",
 "(SELECT count(*)::int FROM private.strata_emergency_exit_reservations x",
 " WHERE x.execution_account_id=a.id AND x.state IN ('PREPARED','DISPATCHED','UNKNOWN')) open_exits",
 "FROM public.v13_production_account a",
 "LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id",
 "LEFT JOIN public.strata_configured_stake s ON s.execution_account_id=a.id",
 "WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2"
].join(" ");
export async function inspectOwnerFiveGateReleaseAudit(
 owner:string,deps:{db?:Db;now?:()=>number;
 reviewed?:typeof inspectApiFeeSourceReadiness;
 v4?:typeof inspectWalletV4Readiness}={},
):Promise<Result>{
 if(!UUID.test(owner))return empty("authenticated_owner_required");
 try{
  const db=deps.db??pool;
  const records=await db.query(LEDGER_SQL,[owner]);
  if(records.rows.length!==1)return empty("owned_execution_account_missing_or_ambiguous");
  const a=records.rows[0]!;
  const [api,v4]=await Promise.all([
    (deps.reviewed??inspectApiFeeSourceReadiness)(owner,undefined,db as never),
    (deps.v4??inspectWalletV4Readiness)(owner,{db}),
  ]);
  const r=empty("owner_five_gate_read_only_evidence");
  r.ok=true;r.remaining=[];
  r.deployedSha=v4.deployedSha;
  r.policyPath=a.fee_policy_version==="strata_api_fee_source_signed_review_v2"
   ?"reviewed_api_v2":a.fee_policy_version==="strata_owner_provider_dynamic_fee_v4"
   ?"dynamic_v4":"unrecognized";
  r.account.commissioned=a.commissioned===true;
  r.account.fiveDollarPolicyApproved=a.fee_policy_version==="strata_api_fee_source_signed_review_v2"
   ?reviewedApiFiveDollarSnapshot(a)
   :approvedDynamicStakeSnapshot(a).ok&&a.configured_stake_cents===500;
  r.account.killSwitchOn=a.kill_switch===true;
  const t=a.reconciled_at instanceof Date?a.reconciled_at.getTime():
    Date.parse(String(a.reconciled_at??""));
  const now=(deps.now??Date.now)();
  r.cash.persistedReconciliationFresh=a.cash_precision_verified===true &&
   Number.isFinite(t)&&t<=now&&now-t<=900_000;
  r.cash.localExposureFlat=a.open_intents===0&&a.open_positions===0&&a.open_exits===0;
  // API readiness is an owner-scoped DB read. No live provider observation is
  // performed here; do not describe a stored review as verified market fees.
  r.fee.independentReview=gate(api.ok===true&&Number(api.currentReviewers??0)>0);
  r.fee.reviewedApiGrant=gate(api.ok===true&&!!api.grantId);
  r.fee.ownerFeeConsent=gate(api.ok===true&&api.ownerConsentRecorded===true);
  r.fee.v4Evidence=gate(v4.checks.modelEvidence);
  r.fee.v4Authority=gate(v4.checks.feeAuthority);
  r.exit.protectiveRelease=gate(v4.checks.protectiveExitRelease);
  r.owner.exactShaApproval=gate(v4.checks.ownerShaApproval);
  if(!r.account.commissioned||!r.account.fiveDollarPolicyApproved)
   r.remaining.push("verify_owner_commissioning_and_approved_five_dollar_policy");
  if(!(r.fee.independentReview.recordPresent&&r.fee.reviewedApiGrant.recordPresent&&
       r.fee.ownerFeeConsent.recordPresent)&&
     !(r.fee.v4Evidence.recordPresent&&r.fee.v4Authority.recordPresent))
   r.remaining.push("obtain_authentic_fee_issuer_terms_admin_review_grant_and_owner_consent");
  if(!r.cash.persistedReconciliationFresh||!r.cash.localExposureFlat)
   r.remaining.push("refresh_kalshi_signed_cash_positions_orders_fills_and_exit_reservations");
  // Even current DB cash is NOT a signed exchange read performed by this audit.
  r.remaining.push("verify_current_signed_kalshi_exchange_evidence_in_owner_reconciliation");
  if(!r.exit.protectiveRelease.recordPresent)
   r.remaining.push("qualify_and_independently_review_exact_sha_protective_exit");
  if(!r.owner.exactShaApproval.recordPresent)
   r.remaining.push("owner_aal2_approve_running_backend_sha");
  if(r.account.killSwitchOn)
   r.remaining.push("retain_kill_until_independent_activation_checks_pass");
  return r;
 }catch{return empty("release_audit_read_only_database_unavailable");}
}
