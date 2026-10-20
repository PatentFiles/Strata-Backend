import { pool } from "@workspace/db";
import { API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION } from "./apiFeeSourceStage";
import { PDF_FREE_API_RATE_REVIEW_DECISION_SHA256, PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
  validateConservativeFeeVectors } from "./apiFeeRateReference";
import { readExactEmergencyFeeEvidence } from "./ownerFeeEmergencyExitMarket";

/**
 * A protected EXIT must remain possible after an *owner's short-lived API
 * source grant expires*, without pretending the 429-blocked PDF was fetched.
 * The approved owner's persisted policy binds the original independently
 * signed model. Any revoked model review or changed live provider fee
 * metadata fails closed. This is a source proof, not a trading approval:
 * the one-use signed dispatcher separately requires the account, lease,
 * kill-switch and independently reviewed exact deployed code release.
 */
type DB={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type FeeReader=typeof readExactEmergencyFeeEvidence;
export type ProtectiveExitFeeProof={
 ok:boolean;reason:string;monetaryFeeAuthorized:boolean;
 marketTicker?:string;sourceDigest?:string;verifiedAt?:string;
 policyApproved:false;tradingAuthorized:false;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const fail=(reason:string):ProtectiveExitFeeProof=>({
 ok:false,reason,monetaryFeeAuthorized:false,policyApproved:false,tradingAuthorized:false,
});
const REVIEW_SQL=`
 SELECT g.grant_id::text AS grant_id
 FROM public.v13_production_account a
 JOIN public.v13_live_money_policy p
   ON p.id=a.policy_id AND p.execution_account_id=a.id
 JOIN private.strata_api_fee_source_grants g
   ON p.fee_source_url=('strata-api-reviewed://kxbtc15m/'||g.grant_id::text)
   AND g.owner_user_id=a.owner_user_id
 JOIN private.strata_api_fee_rate_reviews r
   ON r.owner_user_id=g.owner_user_id
   AND r.reviewer_user_id=g.issuer_admin_id
   AND r.rate_decision_digest=g.rate_decision_digest
   AND r.fee_model_version=g.fee_model_version
   AND r.scope=g.scope
 JOIN private.strata_api_fee_owner_consents c
   ON c.owner_user_id=g.owner_user_id AND c.grant_id=g.grant_id
 WHERE a.id=$1::text AND a.owner_user_id=$2::uuid
   AND a.subaccount=1 AND a.exchange_index=2
   AND a.commissioned=true AND a.execution_enabled=true
   AND a.kill_switch=false
   AND p.state='APPROVED' AND p.approved_at IS NOT NULL
   AND p.fee_policy_version=$3::text
   AND p.fee_formula_version=$4::text
   AND p.fee_source_url LIKE 'strata-api-reviewed://kxbtc15m/%'
   AND g.policy_version=$3::text
   AND g.scope='KXBTC15M:INDEX2'
   AND g.rate_decision_digest=$5::text
   AND g.fee_model_version=$6::text
   AND g.issuer_admin_id<>a.owner_user_id
   AND g.confirmation='ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1'
   AND r.confirmation='I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1'
   AND r.reviewer_user_id<>a.owner_user_id
   AND r.revoked_at IS NULL
   AND r.signed_at<=g.issued_at
   AND c.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'
   AND c.confirmed_at>=g.issued_at
   AND c.confirmed_at<=p.approved_at
   AND g.issued_at<=p.approved_at
 LIMIT 2`;
export async function verifyReviewedProtectiveExitFee(
 ownerId:string,accountId:string,exactTicker:string,
 deps:{db?:DB;readFee?:FeeReader;now?:()=>number}={},
):Promise<ProtectiveExitFeeProof>{
 if(!UUID.test(ownerId) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(accountId) ||
    !MARKET.test(exactTicker) || !validateConservativeFeeVectors())
   return fail("protective_fee_identity_or_model_invalid");
 const now=(deps.now??Date.now)();
 if(!Number.isSafeInteger(now)||now<=0)return fail("protective_fee_clock_invalid");
 let records:Record<string,unknown>[];
 try{
   const result=await(deps.db??pool).query(REVIEW_SQL,[
    accountId,ownerId,API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION,
    PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
   ]);
   records=result.rows;
 }catch{return fail("protective_fee_historic_review_unavailable");}
 if(records.length!==1||!UUID.test(String(records[0]?.grant_id??"")))
   return fail("protective_fee_independent_owner_review_missing");
 const live=await(deps.readFee??readExactEmergencyFeeEvidence)(exactTicker,deps.now??Date.now);
 if(!live.ok || live.marketOpen!==true || live.marketTicker!==exactTicker ||
    !/^[a-f0-9]{64}$/.test(live.fingerprint) ||
    !Number.isSafeInteger(live.observedAtMs) || live.observedAtMs>now+3_000 ||
    now-live.observedAtMs>3_000)
   return fail("protective_fee_provider_metadata_unverified");
 // The signed review binds the previously approved monetary coefficient.
 // The current exact-market GET proves the relevant series/event/override
 // configuration has not changed. The final transactional release fence is
 // still the *sole* order authorization, not this read-only verifier.
 return {ok:true,reason:"protective_fee_approved_historical_model_and_current_api",
   monetaryFeeAuthorized:true,marketTicker:exactTicker,
   sourceDigest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
   verifiedAt:new Date(live.observedAtMs).toISOString(),
   policyApproved:false,tradingAuthorized:false};
}
