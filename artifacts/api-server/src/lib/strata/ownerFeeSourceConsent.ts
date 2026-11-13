import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

/**
 * Owner authenticated by existing Strata JWT middleware, never HTTP body.
 * A consent is NOT fee policy approval, commissioning, arming or order consent.
 * A single database transaction binds ownership, current grant and release.
 */
// Canonical UUID format: 8-4-4-4-12 hexadecimal digits.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type FeeConsentDb = {
  connect(): Promise<{
    query(sql:string, params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
    release():void;
  }>;
  query(sql:string, params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
};
export const FEE_SOURCE_CONSENT_CONFIRMATION = "CONFIRM_OPERATOR_FEE_SOURCE_ONLY";
type ConsentResult = { ok: boolean; reason: string; consentId?: string;
  policyApproved: false; commissioningApproved: false; tradingAuthorized: false };
const denied = (reason:string):ConsentResult => ({
  ok:false,reason,policyApproved:false,commissioningApproved:false,tradingAuthorized:false,
});
export async function recordOwnerFeeSourceConsent(ownerUserId:string, body:unknown, db:FeeConsentDb=pool):Promise<ConsentResult> {
  if(!UUID.test(ownerUserId)||!body||typeof body!=="object"||Array.isArray(body))
    return denied("owner_identity_or_confirmation_invalid");
  const values=body as Record<string,unknown>;
  if(values.confirmation!==FEE_SOURCE_CONSENT_CONFIRMATION||
    typeof values.grantId!=="string"||!UUID.test(values.grantId))
    return denied("explicit_owner_source_consent_required");
  let client;
  let completed=false;
  try {
    client=await db.connect();
    await client.query("BEGIN");
    const accounts=await client.query(`
      SELECT id FROM public.v13_production_account
      WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 LIMIT 2`,
      [ownerUserId]);
    if(accounts.rows.length!==1) return denied("owned_account_not_unique");
    const grants=await client.query(`
      SELECT g.grant_id,g.release_id
      FROM private.strata_fee_source_grants g
      JOIN public.strata_fee_operator_release_candidates r
        ON r.release_id=g.release_id
      WHERE g.grant_id=$1::uuid AND g.owner_user_id=$2::uuid
        AND g.revoked_at IS NULL AND g.expires_at>now()
        AND r.revoked_at IS NULL AND r.expires_at>now()
        AND g.policy_version='operator_attested_fee_source_v1'
        AND g.reviewed_pdf_sha256=r.content_sha256
        AND g.authorized_stages @> ARRAY['STEP_6','STEP_9','STEP_11','ORDER_ENTRY']::text[]
      FOR SHARE OF g,r`,[values.grantId,ownerUserId]);
    if(grants.rows.length!==1) return denied("trusted_owned_grant_not_current");
    const grant=grants.rows[0]!;
    const consentId=randomUUID();
    const added=await client.query(`
      INSERT INTO private.strata_fee_source_owner_consents
        (consent_id,grant_id,owner_user_id,release_id,confirmation,confirmed_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,now())
      ON CONFLICT (grant_id,owner_user_id) DO NOTHING
      RETURNING consent_id`,
      [consentId,grant.grant_id,ownerUserId,grant.release_id,
       FEE_SOURCE_CONSENT_CONFIRMATION]);
    if(added.rows.length!==1) return denied("consent_exists_or_revoked_no_repeat");
    await client.query("COMMIT");completed=true;
    return {ok:true,reason:"owner_source_consent_recorded_only",consentId,
      policyApproved:false,commissioningApproved:false,tradingAuthorized:false};
  }catch{return denied("owner_source_consent_unavailable");}
  finally {
    if(client){
      if(!completed){try{await client.query("ROLLBACK");}catch{}}
      client.release();
    }
  }
}

/** Revocation is owned-user-scoped and append-only; it cannot widen authority. */
export async function revokeOwnerFeeSourceConsent(ownerUserId:string,body:unknown,db:FeeConsentDb=pool):
  Promise<ConsentResult>{
  if(!UUID.test(ownerUserId)||!body||typeof body!=="object"||Array.isArray(body))
    return denied("owner_revocation_invalid");
  const value=body as Record<string,unknown>;
  if(value.confirmation!=="REVOKE_OPERATOR_FEE_SOURCE_CONSENT"||
    typeof value.grantId!=="string"||!UUID.test(value.grantId)||
    typeof value.reason!=="string"||value.reason.trim().length<8||
    value.reason.trim().length>300)return denied("explicit_revocation_required");
  try{
    const revoked=await db.query(`
      UPDATE private.strata_fee_source_owner_consents
      SET revoked_at=now(),revocation_reason=$3
      WHERE grant_id=$1::uuid AND owner_user_id=$2::uuid AND revoked_at IS NULL
      RETURNING consent_id`,[value.grantId,ownerUserId,value.reason.trim()]);
    return revoked.rows.length===1?
      {ok:true,reason:"source_consent_revoked_only",policyApproved:false,
       commissioningApproved:false,tradingAuthorized:false}:
      denied("consent_already_revoked_or_missing");
  }catch{return denied("consent_revocation_unavailable");}
}
