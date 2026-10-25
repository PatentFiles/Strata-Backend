/**
 * #165: show personal account setup separately from live execution release.
 * Owner-scoped, read-only, no exchange traffic or credential material.
 * This is a record audit: stored verified timestamps are NOT fresh signed
 * exchange evidence and never clear commission/fee/kill or risk blockers.
 */
import {pool} from "@workspace/db";

type Row=Record<string,unknown>;
type Db={query(sql:string,params?:unknown[]):Promise<{rows:Row[]}>};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROLES=["provisioning","verification","account_setup_execution","restricted_execution"] as const;
type Phase="account_missing"|"credentials_incomplete"|"funding_or_policy_incomplete"|
 "commissioning_required"|"commissioned_provisional_hold"|
 "commissioned_other_risk_freeze"|"commissioned_release_pending";
export type OwnerOnboardingReadiness={
 ok:boolean;reason:string;readOnly:true;tradingAuthorized:false;ordersSubmitted:false;
 signedKalshiEvidenceRefreshed:false;
 phase:Phase;
 emailVerified:boolean;ownedAccountUnique:boolean;
 credentials:{verifiedRoles:string[];allFourRecorded:boolean};
 funding:{historicalOrCompletedTransferRecorded:boolean;freshExchangeCashRequired:true};
 policy:{approvedRecord:boolean;configuredStakeCents:number|null};
 account:{commissioned:boolean;killSwitchOn:boolean;provisionalHold:boolean;otherFreeze:boolean};
 nextActions:string[];
};
const empty=(reason:string):OwnerOnboardingReadiness=>({
 ok:false,reason,readOnly:true,tradingAuthorized:false,ordersSubmitted:false,
 signedKalshiEvidenceRefreshed:false,phase:"account_missing",emailVerified:false,
 ownedAccountUnique:false,credentials:{verifiedRoles:[],allFourRecorded:false},
 funding:{historicalOrCompletedTransferRecorded:false,freshExchangeCashRequired:true},
 policy:{approvedRecord:false,configuredStakeCents:null},
 account:{commissioned:false,killSwitchOn:true,provisionalHold:false,otherFreeze:false},
 nextActions:[reason],
});
const isTrue=(value:unknown)=>value===true;
const asInt=(value:unknown):number|null=>{
 const n=typeof value==="number"?value:
  typeof value==="string"&&/^(0|[1-9]\d*)$/.test(value)?Number(value):NaN;
 return Number.isSafeInteger(n)&&n>=0?n:null;
};
export const OWNER_ONBOARDING_READ_SQL=[
 "/* owner-onboarding:status; no account identifiers or secrets returned to browser */",
 "SELECT u.email_confirmed_at IS NOT NULL AS email_verified,",
 "a.id IS NOT NULL AS account_exists,a.commissioned,a.kill_switch,a.blocked_reason,",
 "p.state AS policy_state, s.configured_stake_cents,",
 "(SELECT array_agg(c.role ORDER BY c.role) FROM private.kalshi_connection_credentials c",
 " WHERE c.owner_user_id=u.id AND c.financial_account_id=a.kalshi_connection_id",
 " AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL",
 " AND c.verification_reason='credential_verified'",
 " AND c.vault_secret_id IS NOT NULL",
 " AND c.role=ANY(ARRAY['provisioning','verification','account_setup_execution','restricted_execution']::text[])) AS active_roles,",
 "EXISTS(SELECT 1 FROM private.kalshi_owner_historical_funding f",
 " WHERE f.owner_user_id=u.id AND f.execution_account_id=a.id",
 " AND f.verified_at IS NOT NULL AND f.primary_after_cents=0 AND f.bot_after_cents=2500)",
 "OR EXISTS(SELECT 1 FROM private.kalshi_owner_pilot_transfers t",
 " WHERE t.owner_user_id=u.id AND t.execution_account_id=a.id",
 " AND t.state='completed' AND t.completed_at IS NOT NULL AND t.bot_after_cents>=2500)",
 "AS funding_recorded",
 "FROM auth.users u",
 "LEFT JOIN public.v13_production_account a ON a.owner_user_id=u.id",
 " AND a.subaccount=1 AND a.exchange_index=2",
 "LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id",
 " AND p.execution_account_id=a.id AND p.created_by=u.id::text",
 "LEFT JOIN public.strata_configured_stake s ON s.execution_account_id=a.id",
 "WHERE u.id=$1::uuid LIMIT 2"
].join(" ");
export async function inspectOwnerAccountOnboardingReadiness(
 ownerId:string, deps:{db?:Db}={},
):Promise<OwnerOnboardingReadiness>{
 if(!UUID.test(ownerId))return empty("authenticated_owner_required");
 try{
  const rows=(await (deps.db??pool).query(OWNER_ONBOARDING_READ_SQL,[ownerId])).rows;
  if(rows.length!==1)return empty("auth_owner_or_execution_account_ambiguous");
  const a=rows[0]!;
  const r=empty("personal_onboarding_read_only_status");
  r.ok=true;r.nextActions=[];
  r.emailVerified=isTrue(a.email_verified);
  r.ownedAccountUnique=isTrue(a.account_exists);
  const roles=Array.isArray(a.active_roles)?a.active_roles.filter((v):v is string=>typeof v==="string"):[];
  r.credentials.verifiedRoles=ROLES.filter(role=>roles.filter(x=>x===role).length===1);
  r.credentials.allFourRecorded=r.credentials.verifiedRoles.length===ROLES.length&&
    roles.length===ROLES.length;
  r.funding.historicalOrCompletedTransferRecorded=isTrue(a.funding_recorded);
  r.policy.approvedRecord=a.policy_state==="APPROVED";
  r.policy.configuredStakeCents=asInt(a.configured_stake_cents);
  r.account.commissioned=isTrue(a.commissioned);
  r.account.killSwitchOn=isTrue(a.kill_switch);
  r.account.provisionalHold=a.blocked_reason==="awaiting_account_commissioning";
  r.account.otherFreeze=a.blocked_reason!==null&&a.blocked_reason!==undefined&&
    !r.account.provisionalHold;
  if(!r.emailVerified)r.nextActions.push("confirm_own_email_before_account_setup");
  if(!r.ownedAccountUnique){
   r.phase="account_missing";
   r.nextActions.push("complete_authenticated_execution_account_provisioning");
   return r;
  }
  if(!r.credentials.allFourRecorded){
   r.phase="credentials_incomplete";
   r.nextActions.push("verify_four_distinct_active_owner_credential_roles");
  }else if(!r.funding.historicalOrCompletedTransferRecorded||
           !r.policy.approvedRecord||r.policy.configuredStakeCents===null){
   r.phase="funding_or_policy_incomplete";
   if(!r.funding.historicalOrCompletedTransferRecorded)
    r.nextActions.push("verify_owned_index2_funding_without_repeating_transfer");
   if(!r.policy.approvedRecord||r.policy.configuredStakeCents===null)
    r.nextActions.push("review_and_approve_owner_policy_and_stake");
  }else if(!r.account.commissioned){
   r.phase="commissioning_required";
   r.nextActions.push("complete_current_fee_authority_and_fresh_signed_cash_for_step11");
   r.nextActions.push("owner_mfa_commission_own_account");
  }else if(r.account.otherFreeze){
   r.phase="commissioned_other_risk_freeze";
   r.nextActions.push("engineering_reconcile_non_provisional_financial_freeze");
  }else if(r.account.provisionalHold){
   r.phase="commissioned_provisional_hold";
   r.nextActions.push("independent_fee_review_and_own_grant_consent");
   r.nextActions.push("owner_approved_versioned_migration_repairs_provisional_hold_after_signed_flatness");
  }else{
   r.phase="commissioned_release_pending";
   r.nextActions.push("finish_independent_protective_exit_and_owner_sha_release");
  }
  // The owner decides whether/when to proceed. A dashboard must never claim
  // trading authority from a saved funding record or credential timestamp.
  if(!r.account.killSwitchOn)
   r.nextActions.push("investigate_account_kill_switch_off_before_release");
  return r;
 }catch{return empty("onboarding_read_only_database_unavailable");}
}
