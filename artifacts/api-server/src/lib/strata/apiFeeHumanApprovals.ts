import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";
import { preparePdfFreeApiFeePolicyReview } from "./apiFeePolicyReviewCandidate";
import { PDF_FREE_API_RATE_REVIEW_DECISION_SHA256, PDF_FREE_RATE_REVIEW_VECTOR_VERSION } from "./apiFeeRateReference";
import { API_POLICY_SIGNED_REVIEW_V1 } from "./apiFeeGrantEligibility";

/**
 * Human-authorized fee-source record creation. These actions are only reachable
 * behind the existing JWT-authenticated owner router. They record attestations
 * and scoped consent, never policy approval, commissioning or trading.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const API_REVIEW_CONFIRM = "I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1";
export const API_GRANT_CONFIRM = "ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1";
export const API_CONSENT_CONFIRM = "CONFIRM_REVIEWED_API_FEE_SOURCE_V1";
export const API_CONSENT_REVOKE = "REVOKE_REVIEWED_API_FEE_SOURCE_CONSENT_V1";
export const API_GRANT_REVOKE = "REVOKE_REVIEWED_API_FEE_SOURCE_GRANT_V1";
type DbClient = {
 query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
 release():void;
};
export type ApiApprovalDb = {connect():Promise<DbClient>};
type Result = {ok:boolean;reason:string;recordId?:string;expiresAt?:string;
 policyApproved:false;commissioningApproved:false;tradingAuthorized:false};
const denied = (reason:string):Result => ({
 ok:false,reason,policyApproved:false,commissioningApproved:false,tradingAuthorized:false
});
const recorded=(reason:string,recordId:string,expiresAt?:string):Result=>({
 ...denied(reason),ok:true,recordId,expiresAt
});
const bodyObject=(body:unknown):Record<string,unknown>|null=>
 body && typeof body==="object" && !Array.isArray(body) ? body as Record<string,unknown> : null;
const validOwner=(s:unknown):s is string=>typeof s==="string" && UUID.test(s);
async function confirmedAdmin(db:DbClient,userId:string):Promise<boolean>{
 const r=await db.query(`
 SELECT 1 FROM auth.users u JOIN private.role_assignments r
   ON lower(btrim(u.email))=lower(btrim(r.email))
 WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL AND r.role='ADMIN'
 LIMIT 1`,[userId]);
 return r.rows.length===1;
}
async function singleOwnedPair(db:DbClient,ownerId:string):Promise<boolean>{
 const r=await db.query(`
 SELECT id FROM public.v13_production_account
 WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 LIMIT 2`,[ownerId]);
 return r.rows.length===1;
}
async function transaction(db:ApiApprovalDb,run:(client:DbClient)=>Promise<Result>):Promise<Result>{
 let client:DbClient|undefined;
 let committed=false;
 try{
  client=await db.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='1000ms'");
  await client.query("SET LOCAL statement_timeout='10000ms'");
  const result=await run(client);
  if(result.ok){
   await client.query("COMMIT");
   committed=true;
  }
  return result;
 }catch{return denied("api_fee_authorization_database_unavailable");}
 finally{
  if(client){
   if(!committed){try{await client.query("ROLLBACK");}catch{}}
   client.release();
  }
 }
}

/** An independent ADMIN attests a separate, real provider publication/support
 * confirming fee rate and rounding; API metadata alone does not prove 0.07.
 * The client must submit an affirmative exact-digest acknowledgment and note.
 */
export async function recordApiFeeRateReview(
 adminId:string,raw:unknown,db:ApiApprovalDb=pool,
):Promise<Result>{
 const b=bodyObject(raw);
 if(!validOwner(adminId)||!b||!validOwner(b.ownerUserId)||
    b.ownerUserId===adminId || b.confirmation!==API_REVIEW_CONFIRM ||
    b.rateDecisionDigest!==PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 ||
    typeof b.note!=="string"||b.note.trim().length<100||b.note.trim().length>1600 ||
    !["kalshi_official_fee_publication","kalshi_official_support_confirmation"].includes(String(b.verifiedRateSource)))
  return denied("explicit_independent_rate_source_review_required");
 return transaction(db,async c=>{
  if(!await confirmedAdmin(c,adminId))return denied("administrator_required");
  if(!await singleOwnedPair(c,b.ownerUserId as string))return denied("owned_index2_account_missing_or_ambiguous");
  // Serialize authentic review renewals per owner. The permanent triple
  // uniqueness constraint was removed by migration 0031; without this lock,
  // concurrent requests could create ambiguous simultaneously active reviews.
  const locked=await c.query(`
    SELECT id FROM public.v13_production_account
    WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2
    FOR UPDATE`,[b.ownerUserId]);
  if(locked.rows.length!==1)return denied("owned_fee_review_lock_unavailable");
  const active=await c.query(`
    SELECT review_id FROM private.strata_api_fee_rate_reviews
    WHERE owner_user_id=$1::uuid AND reviewer_user_id=$2::uuid
      AND rate_decision_digest=$3 AND revoked_at IS NULL
      AND expires_at>now()
    LIMIT 1`,[b.ownerUserId,adminId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256]);
  if(active.rows.length!==0)return denied("active_fee_rate_review_already_exists");
  const id=randomUUID();
  const rows=await c.query(`
  INSERT INTO private.strata_api_fee_rate_reviews
   (review_id,owner_user_id,reviewer_user_id,rate_decision_digest,
    fee_model_version,scope,confirmation,review_note,verified_rate_source,
    signed_at,expires_at)
  VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,'KXBTC15M:INDEX2',
    $6,$7,$8,now(),now()+interval '2 hours')
  ON CONFLICT DO NOTHING RETURNING review_id,expires_at`,[
   id,b.ownerUserId,adminId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
   PDF_FREE_RATE_REVIEW_VECTOR_VERSION,API_REVIEW_CONFIRM,(b.note as string).trim(),b.verifiedRateSource
  ]);
  if(rows.rows.length!==1)return denied("rate_review_already_recorded_no_retry");
  return recorded("independent_rate_source_review_recorded_only",
    id,new Date(rows.rows[0]!.expires_at as string).toISOString());
 });
}

/** Technical issuer must personally have made the single independently verified
 * ADMIN fee model attestation. A different, authenticated owner must consent.
 * Fresh Kalshi API observation and current rate attestation are prerequisites.
 * A grant never changes policy/commissioning/worker flags.
 */
export async function issueApiFeeSourceGrant(
 adminId:string,raw:unknown,db:ApiApprovalDb=pool,
 probe:typeof probeCurrentKalshiFeeApi=probeCurrentKalshiFeeApi,
):Promise<Result>{
 const b=bodyObject(raw);
 if(!validOwner(adminId)||!b||!validOwner(b.ownerUserId)||
    b.ownerUserId===adminId||b.confirmation!==API_GRANT_CONFIRM||
    b.rateDecisionDigest!==PDF_FREE_API_RATE_REVIEW_DECISION_SHA256)
  return denied("explicit_rate_source_grant_issuance_required");
 let observation;
 try{
  observation=preparePdfFreeApiFeePolicyReview(await probe());
 }catch{return denied("kalshi_fee_api_read_unavailable");}
 if(!observation.ok)return denied("kalshi_api_fee_observation_not_current");
 return transaction(db,async c=>{
  if(!await confirmedAdmin(c,adminId))return denied("administrator_required");
  if(!await singleOwnedPair(c,b.ownerUserId as string))return denied("owned_index2_account_missing_or_ambiguous");
  // Serialize issuance on the owned execution-account row. Duplicate
  // simultaneously valid grants would make source lookup ambiguous.
  const ownerLock=await c.query(`
   SELECT id FROM public.v13_production_account
   WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2
   FOR UPDATE`,[b.ownerUserId]);
  if(ownerLock.rows.length!==1)return denied("owned_account_issuance_lock_unavailable");
  const existing=await c.query(`
   SELECT grant_id FROM private.strata_api_fee_source_grants
   WHERE owner_user_id=$1::uuid AND revoked_at IS NULL AND expires_at>now()
   LIMIT 1`,[b.ownerUserId]);
  if(existing.rows.length)return denied("active_api_fee_source_grant_already_exists");
  const reviews=await c.query(`
   SELECT r.reviewer_user_id,r.expires_at FROM private.strata_api_fee_rate_reviews r
   JOIN auth.users u ON u.id=r.reviewer_user_id
   JOIN private.role_assignments role
     ON lower(btrim(role.email))=lower(btrim(u.email)) AND role.role='ADMIN'
   WHERE r.owner_user_id=$1::uuid
     AND r.reviewer_user_id<>$1::uuid
     AND r.reviewer_user_id=$2::uuid
     AND r.rate_decision_digest=$3 AND r.fee_model_version=$4
     AND r.scope='KXBTC15M:INDEX2' AND r.confirmation=$5
     AND r.revoked_at IS NULL AND r.expires_at>now()+interval '60 seconds'
     AND u.email_confirmed_at IS NOT NULL
   ORDER BY r.reviewer_user_id FOR SHARE OF r`,[
   b.ownerUserId,adminId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
   PDF_FREE_RATE_REVIEW_VECTOR_VERSION,API_REVIEW_CONFIRM
  ]);
  const distinct=new Set(reviews.rows.map(r=>String(r.reviewer_user_id)));
  if(distinct.size!==1 || reviews.rows.length!==1 || !distinct.has(adminId))
    return denied("technical_admin_rate_review_missing_or_ambiguous");
  // Derive issued_at and expires_at from the same PostgreSQL transaction clock.
  // JS Date.now()+60min can exceed the SQL CHECK by milliseconds due to clock skew.
  // The locked review query above already enforces >60 seconds of validity.
  const reviewExpiresAt=reviews.rows[0]!.expires_at;
  if(!Number.isFinite(new Date(reviewExpiresAt as string).getTime()))
    return denied("rate_review_expiring");
  const id=randomUUID();
  const rows=await c.query(`
   INSERT INTO private.strata_api_fee_source_grants
    (grant_id,owner_user_id,issuer_admin_id,rate_decision_digest,
     fee_model_version,policy_version,scope,authorized_stages,
     confirmation,issued_at,expires_at)
   VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'KXBTC15M:INDEX2',
     ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],$7,now(),
     LEAST(now()+interval '60 minutes',$8::timestamptz))
   RETURNING grant_id,expires_at`,[
    id,b.ownerUserId,adminId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
    PDF_FREE_RATE_REVIEW_VECTOR_VERSION,API_POLICY_SIGNED_REVIEW_V1,
    API_GRANT_CONFIRM,reviewExpiresAt
   ]);
  return rows.rows.length===1
   ?recorded("reviewed_api_fee_grant_recorded_only",id,
      new Date(rows.rows[0]!.expires_at as string).toISOString())
   :denied("api_fee_grant_not_created"); });
}

/** Only the authenticated execution-account owner can consent to a current
 * reviewed grant. Consent is not an order or owner risk-policy approval.
 */
export async function recordApiFeeOwnerConsent(
 ownerId:string,raw:unknown,db:ApiApprovalDb=pool,
):Promise<Result>{
 const b=bodyObject(raw);
 if(!validOwner(ownerId)||!b||!validOwner(b.grantId)||
    b.confirmation!==API_CONSENT_CONFIRM)
  return denied("explicit_owner_api_fee_consent_required");
 return transaction(db,async c=>{
  if(!await singleOwnedPair(c,ownerId))return denied("owned_index2_account_missing_or_ambiguous");
  const grant=await c.query(`
   SELECT grant_id FROM private.strata_api_fee_source_grants
   WHERE grant_id=$1::uuid AND owner_user_id=$2::uuid
     AND policy_version=$3 AND rate_decision_digest=$4
     AND revoked_at IS NULL AND expires_at>now()+interval '60 seconds'
     AND authorized_stages @> ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[]
   FOR SHARE`,[
   b.grantId,ownerId,API_POLICY_SIGNED_REVIEW_V1,
   PDF_FREE_API_RATE_REVIEW_DECISION_SHA256
  ]);
  if(grant.rows.length!==1)return denied("owner_api_fee_grant_unavailable");
  const id=randomUUID();
  const rows=await c.query(`
   INSERT INTO private.strata_api_fee_owner_consents
     (consent_id,grant_id,owner_user_id,confirmation,confirmed_at)
   VALUES ($1::uuid,$2::uuid,$3::uuid,$4,now())
   ON CONFLICT(grant_id,owner_user_id) DO NOTHING RETURNING consent_id`,
   [id,b.grantId,ownerId,API_CONSENT_CONFIRM]);
  return rows.rows.length===1
   ?recorded("owner_api_fee_source_consent_recorded_only",id)
   :denied("owner_fee_consent_already_recorded_or_revoked");
 });
}

export async function revokeApiFeeOwnerConsent(
 ownerId:string,raw:unknown,db:ApiApprovalDb=pool,
):Promise<Result>{
 const b=bodyObject(raw);
 if(!validOwner(ownerId)||!b||!validOwner(b.grantId)||
    b.confirmation!==API_CONSENT_REVOKE||
    typeof b.reason!=="string"||b.reason.trim().length<8||b.reason.trim().length>300)
  return denied("explicit_owner_api_fee_revocation_required");
 return transaction(db,async c=>{
  const rows=await c.query(`
   UPDATE private.strata_api_fee_owner_consents
   SET revoked_at=now(),revocation_reason=$3
   WHERE grant_id=$1::uuid AND owner_user_id=$2::uuid AND revoked_at IS NULL
   RETURNING consent_id`,[b.grantId,ownerId,(b.reason as string).trim()]);
  return rows.rows.length===1
    ?recorded("owner_api_fee_consent_revoked_only",String(rows.rows[0]!.consent_id))
    :denied("owner_api_fee_consent_not_active");
 });
}

export async function revokeApiFeeSourceGrant(
 adminId:string,raw:unknown,db:ApiApprovalDb=pool,
):Promise<Result>{
 const b=bodyObject(raw);
 if(!validOwner(adminId)||!b||!validOwner(b.grantId)||
    b.confirmation!==API_GRANT_REVOKE||
    typeof b.reason!=="string"||b.reason.trim().length<8||b.reason.trim().length>300)
  return denied("explicit_admin_api_fee_revocation_required");
 return transaction(db,async c=>{
  if(!await confirmedAdmin(c,adminId))return denied("administrator_required");
  const rows=await c.query(`
   UPDATE private.strata_api_fee_source_grants
   SET revoked_at=now(),revocation_reason=$3
   WHERE grant_id=$1::uuid AND issuer_admin_id=$2::uuid AND revoked_at IS NULL
   RETURNING grant_id`,[b.grantId,adminId,(b.reason as string).trim()]);
  return rows.rows.length===1
    ?recorded("api_fee_source_grant_revoked_only",String(rows.rows[0]!.grant_id))
    :denied("api_fee_grant_not_owned_or_revoked");
 });
}

/** Read-only owner-scoped view for the PDF-free API fee-source review flow.
 * Other owners may only be selected by currently confirmed administrators.
 * Never returns the human review notes, credentials, or approval authority.
 */
export type ApiFeeSourceReadiness = {
 ok:boolean;reason:string;ownerUserId?:string;
 rateDecisionDigest?:string;feeModelVersion?:string;
 currentReviewers?:number; grantId?:string|null;grantExpiresAt?:string|null;
 ownerConsentRecorded?:boolean;
 policyApproved:false;commissioningApproved:false;tradingAuthorized:false;
};
export async function inspectApiFeeSourceReadiness(
 viewerId:string, selectedOwnerId?:string,
 db:Pick<DbClient,"query">=pool,
):Promise<ApiFeeSourceReadiness>{
 const ownerId=selectedOwnerId??viewerId;
 if(!validOwner(viewerId)||!validOwner(ownerId))
  return denied("api_fee_readiness_owner_invalid");
 try{
  if(viewerId!==ownerId && !await confirmedAdmin(db as DbClient,viewerId))
   return denied("administrator_required_for_other_owner");
  if(!await singleOwnedPair(db as DbClient,ownerId))
   return denied("owned_index2_account_missing_or_ambiguous");
  const candidates=await db.query(`
   SELECT r.reviewer_user_id FROM private.strata_api_fee_rate_reviews r
   JOIN auth.users u ON u.id=r.reviewer_user_id
   JOIN private.role_assignments role
    ON lower(btrim(role.email))=lower(btrim(u.email)) AND role.role='ADMIN'
   WHERE r.owner_user_id=$1::uuid AND r.reviewer_user_id<>$1::uuid
    AND r.rate_decision_digest=$2 AND r.fee_model_version=$3
    AND r.confirmation=$4 AND r.scope='KXBTC15M:INDEX2'
    AND r.revoked_at IS NULL AND r.expires_at>now()+interval '60 seconds'
    AND u.email_confirmed_at IS NOT NULL
    AND ($5::uuid IS NULL OR r.reviewer_user_id=$5::uuid)`,[
    ownerId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
    PDF_FREE_RATE_REVIEW_VECTOR_VERSION,API_REVIEW_CONFIRM,
    viewerId!==ownerId?viewerId:null
  ]);
  const currentReviewers=new Set(candidates.rows.map(r=>String(r.reviewer_user_id))).size;
  const g=await db.query(`
   SELECT g.grant_id,g.expires_at,
     EXISTS(SELECT 1 FROM private.strata_api_fee_owner_consents c
       WHERE c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id
       AND c.revoked_at IS NULL AND c.confirmation=$3) AS owner_consented
   FROM private.strata_api_fee_source_grants g
   WHERE g.owner_user_id=$1::uuid AND g.rate_decision_digest=$2
    AND g.revoked_at IS NULL AND g.expires_at>now()
    AND g.scope='KXBTC15M:INDEX2' AND g.policy_version=$4
   LIMIT 2`,[
   ownerId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
   API_CONSENT_CONFIRM,API_POLICY_SIGNED_REVIEW_V1
  ]);
  if(g.rows.length>1)return denied("api_fee_multiple_active_grants_ambiguous");
  const grant=g.rows[0];
  return {
   ...denied("api_fee_source_status_read_only"),
   ok:true,ownerUserId:ownerId,rateDecisionDigest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
   feeModelVersion:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
   currentReviewers,grantId:grant?String(grant.grant_id):null,
   grantExpiresAt:grant?new Date(grant.expires_at as string).toISOString():null,
   ownerConsentRecorded:grant?.owner_consented===true,
  };
 }catch{
  return denied("api_fee_source_status_unavailable");
 }
}
