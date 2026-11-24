/** Admin-supplied document provenance, distinct from a canonical HTTP capture.
 * This service only publishes an approved-format document. It never issues a
 * policy, account authority, worker lease or order.
 */
import {pool,type PoolClient} from "@workspace/db";
import {createHash} from "node:crypto";
import {platformFeeUploadEnabled,isUploadedBaselineId,UPLOADED_FEE_PROVENANCE} from "./platformFeeUploadMode";
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const deny=(reason:string)=>({ok:false as const,reason,digestStored:false,sourceMode:null,effectiveDate:null,formulaVersion:null,tradingAuthorized:false as const});
const latestSql=`SELECT u.upload_id::text,u.baseline_id,u.uploaded_at,b.content_sha256,b.effective_date::text AS effective_date,b.formula_version,
 EXISTS(SELECT 1 FROM private.strata_platform_fee_withdrawal w WHERE w.upload_id=u.upload_id) AS withdrawn,
 pg_catalog.encode(pg_catalog.sha256(b.original_bytes),'hex') AS actual_digest,b.original_bytes
 FROM private.strata_platform_uploaded_fee_schedule u JOIN private.strata_durable_historical_baseline b USING(baseline_id)
 ORDER BY u.upload_id DESC LIMIT 1`;
async function parse(bytes:Buffer){
 const {verifyOfficialFeePdfBytes}=await import("../microLiveFeeArtifact");
 return verifyOfficialFeePdfBytes(bytes);
}
export async function platformFeeAdministrator(admin:string,db:Query=pool,lock=false){
 if(!UUID.test(admin))return false;
 return (await db.query(`SELECT u.id FROM auth.users u
 JOIN public.profiles p ON p.id=u.id
 JOIN private.role_assignments ra ON lower(btrim(ra.email))=lower(btrim(u.email))
 WHERE u.id=$1::uuid AND p.role='ADMIN' AND ra.role='ADMIN' AND u.email_confirmed_at IS NOT NULL
 AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) LIMIT 2`+(lock?" FOR SHARE OF u,p,ra":""),[admin])).rows.length===1;
}
export async function previewPlatformUploadedFeeSchedule(admin:string,bytes:Buffer){
 if(!platformFeeUploadEnabled())return deny("platform_fee_upload_disabled");
 if(!await platformFeeAdministrator(admin))return deny("platform_fee_upload_admin_required");
 const parsed=await parse(bytes);
 if(!parsed.ok)return deny("uploaded_fee_pdf_"+parsed.reason);
 return {ok:true as const,reason:"platform_fee_upload_review_ready",digestStored:false,
  sourceMode:UPLOADED_FEE_PROVENANCE,feeArtifactDigest:parsed.digest,effectiveDate:parsed.effectiveDate,
  formulaVersion:parsed.formulaVersion,feeRule:parsed.feeRule,
  sourceAuthenticityVerified:false,publicationKnownCurrent:false,expiresAutomatically:false,tradingAuthorized:false};
}
export async function platformUploadedFeeScheduleHistory(admin:string,before?:string){
 if(!platformFeeUploadEnabled())return {ok:false,reason:"platform_fee_upload_disabled"};
 if(!await platformFeeAdministrator(admin))return {ok:false,reason:"platform_fee_upload_admin_required"};
 if(before!==undefined&&!/^[1-9][0-9]{0,17}$/.test(before))return {ok:false,reason:"invalid_history_cursor"};
 const active=await readActiveUploadedFeeSchedule();
 const rows=(await pool.query(`SELECT u.upload_id::text AS "uploadId",u.uploaded_at AS "uploadedAt",
  u.uploader_user_id::text AS "uploaderId",u.source_url AS "sourceUrl",u.attestation,
  b.effective_date::text AS "effectiveDate",b.content_sha256 AS digest,b.formula_version AS "formulaVersion",
  b.content_sha256=pg_catalog.encode(pg_catalog.sha256(b.original_bytes),'hex') AS "integrityVerified",
  w.withdrawn_at AS "withdrawnAt",w.administrator_user_id::text AS "withdrawnBy"
  FROM private.strata_platform_uploaded_fee_schedule u JOIN private.strata_durable_historical_baseline b USING(baseline_id)
  LEFT JOIN private.strata_platform_fee_withdrawal w USING(upload_id)
  WHERE ($1::bigint IS NULL OR u.upload_id<$1::bigint) ORDER BY u.upload_id DESC LIMIT 26`,[before??null])).rows;
 return {ok:true,sourceMode:UPLOADED_FEE_PROVENANCE,sourceAuthenticityVerified:false,publicationKnownCurrent:false,
  expiresAutomatically:false,tradingAuthorized:false,activeDigest:active?.digest??null,
  feeRule:active?.feeRule??null,history:rows.slice(0,25),nextCursor:rows.length>25?rows[24]!.uploadId:null};
}
export async function readActiveUploadedFeeSchedule(db:Query=pool){
 if(!platformFeeUploadEnabled())return null;
 try{
  const rows=(await db.query(latestSql)).rows;
  const r=rows[0];if(rows.length!==1||!r||r.withdrawn!==false||!isUploadedBaselineId(r.baseline_id)||!Buffer.isBuffer(r.original_bytes)||
    typeof r.content_sha256!=="string"||!HASH.test(r.content_sha256)||r.actual_digest!==r.content_sha256||
    r.baseline_id!=="platform-upload-"+r.content_sha256||r.formula_version!=="standard-quadratic-0.07-v1")return null;
  const parsed=await parse(r.original_bytes);
  if(!parsed.ok||parsed.digest!==r.content_sha256||parsed.effectiveDate!==r.effective_date||parsed.formulaVersion!==r.formula_version)return null;
  const conflict=await db.query("SELECT 1 FROM private.strata_platform_official_fee_capture_v1 WHERE content_sha256<>$1 LIMIT 1",[parsed.digest]);
  if(conflict.rows.length)return null;
  return {...parsed,bytes:r.original_bytes,baselineId:r.baseline_id,sourceKind:UPLOADED_FEE_PROVENANCE,
    sourceAuthenticityVerified:false as const,publicationKnownCurrent:false as const};
 }catch{return null;}
}
/** Runtime reads only immutable digest and active version identity, no PDF IO. */
export async function activeUploadedBaselineMatches(db:Query,id:unknown,digest:unknown):Promise<boolean>{
 if(!platformFeeUploadEnabled()||!isUploadedBaselineId(id)||typeof digest!=="string"||id!=="platform-upload-"+digest)return false;
 try{
 const r=await db.query(`SELECT approved.baseline_id,b.content_sha256 FROM private.strata_platform_uploaded_fee_schedule approved
 JOIN private.strata_durable_historical_baseline b USING(baseline_id)
 JOIN (SELECT upload_id,supported_terms_id FROM private.strata_platform_uploaded_fee_schedule ORDER BY upload_id DESC LIMIT 1) active
 ON active.supported_terms_id=approved.supported_terms_id
 WHERE approved.baseline_id=$1 AND b.content_sha256=$2
 AND NOT EXISTS(SELECT 1 FROM private.strata_platform_fee_withdrawal w WHERE w.upload_id IN(active.upload_id,approved.upload_id))`,[id,digest]);
 return r.rows.length===1&&r.rows[0]!.baseline_id===id&&r.rows[0]!.content_sha256===digest;
 }catch{return false;}
}
export async function publishPlatformUploadedFeeSchedule(admin:string,bytes:Buffer){
 if(!platformFeeUploadEnabled()||!UUID.test(admin))return deny("platform_fee_upload_disabled");
 if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>2_000_000)return deny("uploaded_fee_pdf_invalid");
 const authorized=(db:Query,lock=false)=>platformFeeAdministrator(admin,db,lock);
 let tx:PoolClient|undefined,committed=false,commitSent=false,discard:Error|undefined;
 try{
  if(!await authorized(pool))return deny("platform_fee_upload_admin_required");
  const parsed=await parse(bytes);
  if(!parsed.ok)return deny("uploaded_fee_pdf_"+parsed.reason);
  const digest=createHash("sha256").update(bytes).digest("hex");
  if(parsed.digest!==digest||parsed.formulaVersion!=="standard-quadratic-0.07-v1")return deny("uploaded_fee_model_unverified");
  const id="platform-upload-"+digest;
  tx=await pool.connect();await tx.query("BEGIN");
  await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='8000ms'");
  await tx.query("SELECT pg_advisory_xact_lock(1958371201,1)");
  if(!await authorized(tx,true))return deny("platform_fee_upload_admin_required");
  const latest=(await tx.query(latestSql)).rows[0];
  if(latest?.baseline_id===id&&latest.withdrawn)return deny("uploaded_fee_withdrawn_document_cannot_be_reactivated");
  if(latest&&String(latest.effective_date)>parsed.effectiveDate)return deny("uploaded_fee_schedule_rollback_refused");
  const conflict=await tx.query("SELECT 1 FROM private.strata_platform_official_fee_capture_v1 WHERE content_sha256<>$1 LIMIT 1",[digest]);
  if(conflict.rows.length)return deny("uploaded_fee_conflicts_with_known_issuer_observation");
  if(latest?.baseline_id!==id){
   await tx.query("SELECT private.strata_platform_fee_require_safe_cutover()");
   if((await tx.query("SELECT 1 FROM private.strata_platform_uploaded_fee_schedule WHERE baseline_id=$1",[id])).rows.length)return deny("uploaded_fee_schedule_rollback_refused");
   await tx.query(`INSERT INTO private.strata_durable_historical_baseline
    (baseline_id,source_kind,content_sha256,original_bytes,effective_date,formula_version)
    VALUES($1,'OWNER_ATTESTED_HISTORICAL_BASELINE',$2,$3,$4,$5)`,[id,digest,bytes,parsed.effectiveDate,parsed.formulaVersion]);
   await tx.query(`INSERT INTO private.strata_platform_uploaded_fee_schedule(baseline_id,uploader_user_id)
    VALUES($1,$2::uuid)`,[id,admin]);
  }
  commitSent=true;await tx.query("COMMIT");committed=true;
  return {ok:true as const,reason:"platform_uploaded_fee_schedule_recorded",digestStored:true,sourceMode:UPLOADED_FEE_PROVENANCE,
   feeArtifactDigest:digest,effectiveDate:parsed.effectiveDate,formulaVersion:parsed.formulaVersion,
   sourceAuthenticityVerified:false as const,publicationKnownCurrent:false as const,expiresAutomatically:false as const,tradingAuthorized:false as const};
 }catch(error){if(commitSent)discard=Error("platform_upload_commit_unknown");return deny(commitSent?"platform_upload_commit_unknown_refresh_status":error instanceof Error&&error.message==="platform fee change requires safe cutover"?"uploaded_fee_replacement_requires_safe_cutover":"platform_fee_upload_unavailable");}
 finally{if(tx){if(!committed&&!discard)try{await tx.query("ROLLBACK");}catch{discard=Error("platform_upload_rollback_unknown");}tx.release(discard);}}
}
export async function withdrawPlatformUploadedFeeSchedule(admin:string,digest:unknown){
 if(!platformFeeUploadEnabled())return deny("platform_fee_upload_disabled");
 if(typeof digest!=="string"||!HASH.test(digest))return deny("platform_fee_withdrawal_exact_digest_required");
 let tx:PoolClient|undefined,committed=false,commitSent=false,discard:Error|undefined;
 try{
  tx=await pool.connect();await tx.query("BEGIN");
  await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='8000ms'");
  await tx.query("SELECT pg_advisory_xact_lock(1958371201,1)");
  if(!await platformFeeAdministrator(admin,tx,true))return deny("platform_fee_upload_admin_required");
  const latest=(await tx.query(latestSql)).rows[0];
  if(!latest||latest.content_sha256!==digest)return deny("platform_fee_withdrawal_publication_changed");
  if(!latest.withdrawn)await tx.query(`INSERT INTO private.strata_platform_fee_withdrawal(upload_id,administrator_user_id,confirmation)
   VALUES($1,$2,'WITHDRAW_PLATFORM_KALSHI_FEE_PDF_V1')`,[latest.upload_id,admin]);
  commitSent=true;await tx.query("COMMIT");committed=true;
  return {ok:true as const,reason:"platform_fee_publication_withdrawn",feeArtifactDigest:digest,tradingAuthorized:false as const};
 }catch(error){if(commitSent)discard=Error("platform_withdrawal_commit_unknown");return deny(commitSent?"platform_withdrawal_commit_unknown_refresh_status":error instanceof Error&&error.message==="platform fee change requires safe cutover"?"uploaded_fee_replacement_requires_safe_cutover":"platform_fee_withdrawal_unavailable");}
 finally{if(tx){if(!committed&&!discard)try{await tx.query("ROLLBACK");}catch{discard=Error("platform_withdrawal_rollback_unknown");}tx.release(discard);}}
}
