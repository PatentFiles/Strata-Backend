import { pool } from "@workspace/db";

/** Admin-only, read-only proof of the *running backend's* PostgreSQL connection.
 * No hostnames, connection strings, passwords, API tokens, or user identifiers
 * are returned. Fingerprint is based on existing account IDs and is compared
 * against the trusted Supabase SQL editor's independent read.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Db = {query:(sql:string,params?:unknown[])=>Promise<{rows:Array<Record<string,unknown>>}>};
const deny=(reason:string)=>({
 ok:false as const,reason,policyApproved:false as const,
 commissioningApproved:false as const,tradingAuthorized:false as const
});
export const RUNTIME_DB_IDENTITY_SQL=`
 SELECT current_user::text AS runtime_role,
        current_database()::text AS database_name,
        has_schema_privilege(current_user,'private','USAGE') AS private_schema_usable,
        to_regclass('private.strata_api_fee_rate_reviews') IS NOT NULL AS reviews_ready,
        to_regclass('private.strata_api_fee_source_grants') IS NOT NULL AS grants_ready,
        to_regclass('private.strata_api_fee_owner_consents') IS NOT NULL AS consents_ready,
        (SELECT md5(coalesce(string_agg(
           a.id::text || ':' || coalesce(a.owner_user_id::text,''),
           ',' ORDER BY a.id::text),''))
         FROM public.v13_production_account a) AS account_fingerprint
`;
export async function inspectRuntimeDbIdentity(actorId:string,db:Db=pool){
 if(!UUID.test(actorId))return deny("authentication_subject_invalid");
 try{
  const allowed=await db.query(`
   SELECT EXISTS(
    SELECT 1 FROM auth.users u
    JOIN private.role_assignments r ON lower(btrim(r.email))=lower(btrim(u.email))
    WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL AND r.role='ADMIN'
   ) AS is_admin`,[actorId]);
  if(allowed.rows.length!==1||allowed.rows[0]?.is_admin!==true)
   return deny("confirmed_administrator_required");
  const state=await db.query(RUNTIME_DB_IDENTITY_SQL);
  if(state.rows.length!==1)return deny("runtime_db_identity_unavailable");
  const r=state.rows[0]!;
  if(typeof r.runtime_role!=="string"||typeof r.database_name!=="string"||
   typeof r.account_fingerprint!=="string"|| !/^[0-9a-f]{32}$/.test(r.account_fingerprint))
   return deny("runtime_db_identity_invalid");
  const keys=["private_schema_usable","reviews_ready","grants_ready","consents_ready"] as const;
  if(keys.some(k=>typeof r[k]!=="boolean"))
   return deny("runtime_db_schema_observation_invalid");
  return {
   ...deny("read_only_runtime_database_identity_observed"),
   ok:true as const,runtimeRole:r.runtime_role,
   databaseName:r.database_name,
   privateSchemaUsable:r.private_schema_usable as boolean,
   reviewsReady:r.reviews_ready as boolean,
   grantsReady:r.grants_ready as boolean,
   consentsReady:r.consents_ready as boolean,
   accountFingerprint:r.account_fingerprint,
  };
 }catch{
  return deny("runtime_db_identity_unavailable");
 }
}
