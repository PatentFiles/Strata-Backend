import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

/**
 * Owner authenticated by existing Strata JWT middleware, never HTTP body.
 * A consent is NOT fee policy approval, commissioning, arming or order consent.
 * A single database transaction binds ownership, current grant and release.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FEE_SOURCE_CONSENT_CONFIRMATION = "CONFIRM_OPERATOR_FEE_SOURCE_ONLY";
type ConsentResult = { ok: boolean; reason: string; consentId?: string;
  policyApproved: false; commissioningApproved: false; tradingAuthorized: false };
const denied = (reason:string):ConsentResult => ({
  ok:false,reason,policyApproved:false,commissioningApproved:false,tradingAuthorized:false,
});
export async function recordOwnerFeeSourceConsent(ownerUserId:string, body:unknown):Promise<ConsentResult> {
  if(!UUID.test(ownerUserId)||!body||typeof body!=="object"||Array.isArray(body))
    return denied("owner_identity_or_confirmation_invalid");
  const values=body as Record<string,unknown>;
  if(values.confirmation!==FEE_SOURCE_CONSENT_CONFIRMATION||
    typeof values.grantId!=="string"||!UUID.test(values.grantId))
    return denied("explicit_owner_source_consent_required");
  const client=await pool.connect();
  let completed=false;
  try {
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
    if(!completed){try{await client.query("ROLLBACK");}catch{}}
    client.release();
  }
}
