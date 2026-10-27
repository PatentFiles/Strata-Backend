import {randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
import {preparePdfFreeApiFeePolicyReview} from "./apiFeePolicyReviewCandidate";
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from "./apiFeeRateReference";
import {API_POLICY_SIGNED_REVIEW_V1} from "./apiFeeGrantEligibility";

/**
 * Issue #154: approved human model is not a per-order quote and is NEVER
 * silently re-signed. Every ENTRY independently observes real Kalshi fee
 * metadata; only a revocable, bounded OWNER delegation's 15m technical
 * observation lease can renew without a person.
 */
export const STANDING_MODEL_CONFIRM="I_INDEPENDENTLY_ATTEST_VERSIONED_KXBTC15M_STANDING_FEE_MODEL_V1";
export const STANDING_OWNER_CONFIRM="I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1";
export const STANDING_MODEL_FOREVER_CONFIRM="I_INDEPENDENTLY_ATTEST_REVIEWED_KXBTC15M_FEE_MODEL_UNTIL_REVOKED_V2";
export const STANDING_OWNER_FOREVER_CONFIRM="I_AUTHORIZE_MY_ACCOUNT_FOR_CURRENT_REVIEWED_KXBTC15M_FEE_MODEL_UNTIL_REVOKED_V2";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const OFFICIAL=/^https:\/\/(?:help\.)?kalshi\.com\/(?:docs\/|en\/articles\/|regulatory\/)[A-Za-z0-9.\/_-]+$|^https:\/\/kalshi\.com\/fee-schedule\?product=predictions$/;
type Row=Record<string,unknown>;
type Client={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>;release():void};
type Db={query:Client["query"];connect():Promise<Client>};
type Deps={db?:Db;sha?:()=>string;now?:()=>number;probe?:typeof probeCurrentKalshiFeeApi};
const deny=(reason:string)=>({ok:false as const,reason,
 policyApproved:false as const,tradingAuthorized:false as const,workerStarted:false as const});
const text=(v:unknown)=>typeof v==="string"?v:"";
async function admin(db:Client|Db,id:string) {
 const r=await db.query("SELECT 1 FROM auth.users u JOIN private.role_assignments role ON lower(btrim(u.email))=lower(btrim(role.email)) AND role.role='ADMIN' WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL LIMIT 1",[id]);
 return r.rows.length===1;
}
async function tx<T>(db:Db,run:(c:Client)=>Promise<T>):Promise<T>{
 const c=await db.connect();let ok=false;
 try{await c.query("BEGIN");await c.query("SET LOCAL lock_timeout='1000ms'");
 await c.query("SET LOCAL statement_timeout='9000ms'");
 const out=await run(c);
 if(out && typeof out==="object" && "ok" in out && out.ok===true){
  await c.query("COMMIT");ok=true;
 }
 return out;}finally{if(!ok)try{await c.query("ROLLBACK");}catch{}c.release();}
}
/** Only an authenticated, confirmed technical ADMIN can sign a real model.
 * Evidence URL, digest and explanatory note are an independent assertion;
 * if there is no genuine current official/support evidence, refuse signing.
 */
export async function signStandingFeeModel(
 reviewerId:string,raw:unknown,deps:Deps={}
){
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 const release=(deps.sha??deployedGitSha)();
 if(!UUID.test(reviewerId)||!SHA.test(release)||![STANDING_MODEL_CONFIRM,STANDING_MODEL_FOREVER_CONFIRM].includes(String(b.confirmation))||
    b.rateDecisionDigest!==PDF_FREE_API_RATE_REVIEW_DECISION_SHA256||
    !OFFICIAL.test(text(b.evidenceUrl))||!DIGEST.test(text(b.evidenceSha256))||
    typeof b.note!=="string"||String(b.note).trim().length<120||String(b.note).trim().length>1800)
   return deny("independent_official_model_review_evidence_required");
 let proof;
 try{proof=preparePdfFreeApiFeePolicyReview(await (deps.probe??probeCurrentKalshiFeeApi)());}
 catch{return deny("provider_fee_observation_unavailable");}
 if(!proof.ok)return deny("provider_model_observation_unverified");
 try{
 return await tx(deps.db??pool,async c=>{
  if(!await admin(c,reviewerId))return deny("technical_admin_required");
  // Serialize concurrent real human attestations for this deployment/model.
  // A stale model is not automatically extended by this transaction.
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",
   [release+":"+PDF_FREE_API_RATE_REVIEW_DECISION_SHA256]);
  const conflicts=await c.query("SELECT model_id FROM private.strata_api_fee_standing_models WHERE release_commit_sha=$1 AND rate_decision_digest=$2 AND revoked_at IS NULL AND valid_until>now() LIMIT 1",[release,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256]);
  if(conflicts.rows.length)return deny("active_signed_standing_fee_model_already_exists");
  const id=randomUUID();
  const r=await c.query([
   "INSERT INTO private.strata_api_fee_standing_models",
   "(model_id,reviewer_admin_id,rate_decision_digest,fee_model_version,scope,",
   "release_commit_sha,evidence_url,evidence_sha256,evidence_note,signed_at,valid_until,standing_until_revoked)",
   "VALUES($1::uuid,$2::uuid,$3,$4,'KXBTC15M:INDEX2',$5,$6,$7,$8,now(),",
   "CASE WHEN $9::boolean THEN 'infinity'::timestamptz ELSE now()+interval '30 days' END,$9::boolean)",
   "RETURNING model_id::text,valid_until"
  ].join(" "),[id,reviewerId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
    PDF_FREE_RATE_REVIEW_VECTOR_VERSION,release,b.evidenceUrl,b.evidenceSha256,String(b.note).trim(),
    b.confirmation===STANDING_MODEL_FOREVER_CONFIRM]);
  return r.rows.length===1?{...deny("standing_model_signed_only"),ok:true as const,
   modelId:id,validUntil:r.rows[0]?.valid_until}:deny("model_review_not_saved");
 });
 }catch{return deny("standing_model_database_unavailable");}
}

/** AAL2 JWT owner explicitly delegates this ONE already-reviewed API grant
 * and already-approved immutable account policy to the independently signed
 * model. Never creates the grant or policy or modifies risk limits.
 */
export async function consentStandingFeeDelegation(
 ownerId:string,raw:unknown,deps:Deps={}
){
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 const release=(deps.sha??deployedGitSha)();
 if(!UUID.test(ownerId)||!SHA.test(release)||
    !UUID.test(text(b.modelId))||!UUID.test(text(b.grantId))||
    ![STANDING_OWNER_CONFIRM,STANDING_OWNER_FOREVER_CONFIRM].includes(String(b.confirmation)))
  return deny("explicit_owner_standing_fee_consent_required");
 // The reviewed migration already bound the owner to the original grant ID.
 // Enrollment into a signed standing model is a NEW explicit owner action,
 // not a recreation of the original expired 15-minute bootstrap grant.
 // Check current issuer metadata before opening a transaction.
 let observed;
 try{observed=preparePdfFreeApiFeePolicyReview(await (deps.probe??probeCurrentKalshiFeeApi)());}
 catch{return deny("standing_owner_live_fee_observation_unavailable");}
 if(!observed.ok)return deny("standing_owner_live_fee_observation_unverified");
 const db=deps.db??pool;
 try{
 return await tx(db,async c=>{
  const locked=await c.query([
    "SELECT a.id,p.policy_hash,g.grant_id",
    "FROM public.v13_production_account a",
    "JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id",
    "JOIN private.strata_api_fee_source_grants g ON g.owner_user_id=a.owner_user_id",
    "JOIN private.strata_api_fee_owner_consents con ON con.grant_id=g.grant_id",
    "AND con.owner_user_id=a.owner_user_id AND con.revoked_at IS NULL",
    "WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2",
    "AND p.state='APPROVED' AND p.fee_source_url='strata-api-reviewed://kxbtc15m/'||lower(g.grant_id::text)",
    "AND g.grant_id=$2::uuid AND g.revoked_at IS NULL",
    "AND p.fee_policy_version=$3",
    "AND EXISTS(SELECT 1 FROM auth.users issuer",
    " JOIN private.role_assignments issuer_role",
    " ON lower(btrim(issuer_role.email))=lower(btrim(issuer.email))",
    " WHERE issuer.id=g.issuer_admin_id AND issuer.email_confirmed_at IS NOT NULL",
    " AND issuer_role.role='ADMIN')",
    "AND g.policy_version=$3 AND g.fee_model_version=$5",
    "AND g.rate_decision_digest=$4 AND g.scope='KXBTC15M:INDEX2'",
    "AND g.issuer_admin_id<>a.owner_user_id",
    "AND g.confirmation='ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1'",
    "AND con.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'",
    "AND con.confirmed_at>=g.issued_at AND con.confirmed_at<=g.expires_at",
    "AND g.authorized_stages @> ARRAY['STEP_11','ORDER_ENTRY']::text[]",
    "AND EXISTS(SELECT 1 FROM private.strata_api_fee_rate_reviews original",
    " WHERE original.owner_user_id=g.owner_user_id",
    " AND original.reviewer_user_id=g.issuer_admin_id",
    " AND original.rate_decision_digest=g.rate_decision_digest",
    " AND original.fee_model_version=g.fee_model_version",
    " AND original.revoked_at IS NULL AND original.signed_at<=g.issued_at)",
    "LIMIT 2 FOR UPDATE OF a"
  ].join(" "),[ownerId,b.grantId,API_POLICY_SIGNED_REVIEW_V1,
    PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION]);
  if(locked.rows.length!==1||!DIGEST.test(text(locked.rows[0]?.policy_hash)))
   return deny("approved_owned_policy_or_original_grant_evidence_required");
  const model=await c.query([
    "SELECT m.model_id,m.reviewer_admin_id,m.valid_until,m.standing_until_revoked",
    "FROM private.strata_api_fee_standing_models m",
    "JOIN auth.users u ON u.id=m.reviewer_admin_id AND u.email_confirmed_at IS NOT NULL",
    "JOIN private.role_assignments role ON lower(btrim(role.email))=lower(btrim(u.email))",
    "AND role.role='ADMIN'",
    "WHERE m.model_id=$1::uuid AND m.reviewer_admin_id<>$2::uuid",
    "AND m.release_commit_sha=$3 AND m.rate_decision_digest=$4",
    "AND m.fee_model_version=$5 AND m.scope='KXBTC15M:INDEX2'",
    "AND m.revoked_at IS NULL AND m.valid_until>now()+interval '1 day'",
    "LIMIT 2 FOR SHARE OF m"
  ].join(" "),[b.modelId,ownerId,release,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION]);
  if(model.rows.length!==1)return deny("independent_standing_fee_model_missing_or_expired");
  const durable=b.confirmation===STANDING_OWNER_FOREVER_CONFIRM;
  if(durable!==(model.rows[0]?.standing_until_revoked===true))
   return deny("standing_fee_consent_scope_must_match_independent_review");
  const fresh=await c.query([
   "INSERT INTO private.strata_api_fee_standing_delegations",
   "(delegation_id,owner_user_id,model_id,grant_id,policy_hash,release_commit_sha,",
   "confirmation,granted_at,valid_until,lease_expires_at,standing_until_revoked)",
   "VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,now(),",
   "CASE WHEN $9::boolean THEN 'infinity'::timestamptz ELSE LEAST($8::timestamptz,now()+interval '30 days') END,",
   "LEAST($8::timestamptz,now()+interval '15 minutes'),$9::boolean)",
   "ON CONFLICT DO NOTHING RETURNING delegation_id::text,valid_until"
  ].join(" "),[randomUUID(),ownerId,b.modelId,b.grantId,text(locked.rows[0]?.policy_hash),
     release,b.confirmation,model.rows[0]?.valid_until,
     b.confirmation===STANDING_OWNER_FOREVER_CONFIRM]);
  return fresh.rows.length===1?{...deny("owner_standing_fee_delegation_recorded_only"),
   ok:true as const,delegationId:fresh.rows[0]?.delegation_id,
   validUntil:fresh.rows[0]?.valid_until}:deny("standing_fee_delegation_already_exists");
 });
 }catch{return deny("standing_delegation_database_unavailable");}
}

/** Never accept a browser's fee observation. Called only AFTER a fresh official
 * provider API fee observation passes the strict existing market/override tests.
 * One SQL UPDATE atomically rechecks owner consent, reviewer role, grant
 * revocations, policy hash and deployed SHA on every snapshot / ORDER ENTRY.
 */
export const CONTINUE_SQL = [
 "UPDATE private.strata_api_fee_standing_delegations d",
 "SET lease_expires_at=LEAST(d.valid_until,now()+interval '15 minutes')",
 "FROM private.strata_api_fee_standing_models m,",
 "private.strata_api_fee_source_grants g,",
 "private.strata_api_fee_owner_consents con,",
 "public.v13_production_account a,public.v13_live_money_policy p,",
 "auth.users reviewed_user, private.role_assignments reviewed_role,",
 "auth.users issuer_user,private.role_assignments issuer_role",
 "WHERE d.model_id=m.model_id AND d.grant_id=g.grant_id",
 "AND d.owner_user_id=g.owner_user_id AND con.grant_id=g.grant_id",
 "AND con.owner_user_id=d.owner_user_id AND con.revoked_at IS NULL",
 "AND con.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'",
 "AND g.revoked_at IS NULL AND g.issuer_admin_id<>d.owner_user_id",
 "AND g.confirmation='ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1'",
 "AND g.authorized_stages @> ARRAY[$4::text]",
 "AND EXISTS(SELECT 1 FROM private.strata_api_fee_rate_reviews original",
 "WHERE original.owner_user_id=d.owner_user_id",
 "AND original.reviewer_user_id=g.issuer_admin_id",
 "AND original.rate_decision_digest=g.rate_decision_digest",
 "AND original.fee_model_version=g.fee_model_version",
 "AND original.revoked_at IS NULL AND original.signed_at<=g.issued_at)",
 "AND g.policy_version=$5 AND g.fee_model_version=$6",
 "AND g.rate_decision_digest=$7 AND g.scope='KXBTC15M:INDEX2'",
 "AND m.rate_decision_digest=g.rate_decision_digest AND m.fee_model_version=g.fee_model_version",
 "AND m.scope=g.scope AND m.revoked_at IS NULL AND m.valid_until>now()+interval '12 seconds'",
 "AND m.reviewer_admin_id<>d.owner_user_id",
 "AND m.release_commit_sha=$3 AND d.release_commit_sha=$3",
 "AND d.revoked_at IS NULL AND d.valid_until>now()+interval '12 seconds'",
 "AND d.owner_user_id=$1::uuid AND d.grant_id=$2::uuid",
 "AND d.confirmation IN ('I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1',",
  "'I_AUTHORIZE_MY_ACCOUNT_FOR_CURRENT_REVIEWED_KXBTC15M_FEE_MODEL_UNTIL_REVOKED_V2')",
  "AND d.standing_until_revoked=m.standing_until_revoked",
 "AND a.owner_user_id=d.owner_user_id AND a.subaccount=1 AND a.exchange_index=2",
 "AND p.id=a.policy_id AND p.execution_account_id=a.id AND p.state='APPROVED'",
 "AND p.policy_hash=d.policy_hash",
 "AND p.fee_source_url='strata-api-reviewed://kxbtc15m/'||lower(g.grant_id::text)",
 "AND reviewed_user.id=m.reviewer_admin_id AND reviewed_user.email_confirmed_at IS NOT NULL",
 "AND lower(btrim(reviewed_role.email))=lower(btrim(reviewed_user.email)) AND reviewed_role.role='ADMIN'",
 "AND issuer_user.id=g.issuer_admin_id AND issuer_user.email_confirmed_at IS NOT NULL",
 "AND lower(btrim(issuer_role.email))=lower(btrim(issuer_user.email)) AND issuer_role.role='ADMIN'",
 "RETURNING d.delegation_id::text,d.valid_until,d.lease_expires_at"
].join(" ");

export async function renewStandingFeeObservationLease(
 ownerId:string,grantId:string,stage:string,deps:Pick<Deps,"db"|"sha"|"now">={}
):Promise<{ok:true;validUntil:unknown}|{ok:false;reason:string}>{
 const release=(deps.sha??deployedGitSha)();
 if(!UUID.test(ownerId)||!UUID.test(grantId)||!SHA.test(release)||
    !["STEP_11","ORDER_ENTRY"].includes(stage))
   return {ok:false,reason:"standing_fee_stage_identity_invalid"};
 try{
  const updated=await (deps.db??pool).query(CONTINUE_SQL,
    [ownerId,grantId,release,stage,API_POLICY_SIGNED_REVIEW_V1,
     PDF_FREE_RATE_REVIEW_VECTOR_VERSION,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256]);
  if(updated.rows.length!==1)return {ok:false,reason:"standing_model_consent_or_live_policy_missing"};
  return {ok:true,validUntil:updated.rows[0]?.valid_until};
 }catch{return {ok:false,reason:"standing_fee_lease_unavailable"};}
}

/** Revocation takes effect on the very next provider observation/ORDER ENTRY. */
export async function revokeStandingFeeDelegation(
 ownerId:string,raw:unknown,deps:Pick<Deps,"db">={}
){
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 if(!UUID.test(ownerId)||!UUID.test(text(b.delegationId))||
    b.confirmation!=="REVOKE_MY_STANDING_FEE_DELEGATION"||
    typeof b.reason!=="string"||String(b.reason).trim().length<8||String(b.reason).trim().length>250)
   return deny("explicit_owner_standing_revocation_required");
 try{
  return await tx(deps.db??pool,async c=>{
   const r=await c.query([
     "UPDATE private.strata_api_fee_standing_delegations",
     "SET revoked_at=now(),revocation_reason=$3",
     "WHERE delegation_id=$1::uuid AND owner_user_id=$2::uuid",
     "AND revoked_at IS NULL RETURNING delegation_id::text"
   ].join(" "),[b.delegationId,ownerId,String(b.reason).trim()]);
   return r.rows.length===1?{...deny("standing_fee_delegation_revoked"),ok:true as const}:
    deny("standing_fee_delegation_not_active");
  });
 }catch{return deny("standing_fee_revocation_unavailable");}
}

export async function revokeStandingFeeModel(
 adminId:string,raw:unknown,deps:Pick<Deps,"db">={}
){
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 if(!UUID.test(adminId)||!UUID.test(text(b.modelId))||
    b.confirmation!=="REVOKE_REVIEWED_STANDING_FEE_MODEL"||
    typeof b.reason!=="string"||String(b.reason).trim().length<8||String(b.reason).trim().length>250)
   return deny("explicit_standing_fee_admin_revocation_required");
 try{
  return await tx(deps.db??pool,async c=>{
   if(!await admin(c,adminId))return deny("technical_admin_required");
   const r=await c.query([
    "UPDATE private.strata_api_fee_standing_models",
    "SET revoked_at=now(),revocation_reason=$3",
    "WHERE model_id=$1::uuid AND reviewer_admin_id=$2::uuid",
    "AND revoked_at IS NULL RETURNING model_id::text"
   ].join(" "),[b.modelId,adminId,String(b.reason).trim()]);
   return r.rows.length===1?{...deny("standing_fee_model_revoked"),ok:true as const}:
    deny("standing_model_not_active");
  });
 }catch{return deny("standing_model_revocation_unavailable");}
}

/** Read-only, AAL2 JWT owner-scoped display. The displayed model identity is
 * NOT an approval; live readiness still requires the official per-order API
 * observation and every execution/risk/release gate.
 */
export async function inspectStandingFeeReadiness(
 ownerId:string,deps:Pick<Deps,"db"|"sha">={}
){
 const release=(deps.sha??deployedGitSha)();
 if(!UUID.test(ownerId)||!SHA.test(release))
  return {...deny("owner_or_backend_sha_unavailable"),modelId:null,modelValidUntil:null,
   delegationId:null,delegationValidUntil:null,leaseExpiresAt:null,grantId:null,bootstrapGrantId:null};
 try{
  const db=deps.db??pool;
  // The original grant is an immutable source identifier on the ALREADY
  // approved migrated policy, not a currently valid grant or live authority.
  // Exposing it to its JWT owner allows explicit standing-model consent even
  // if the original 15-minute bootstrap lease expired. The mutation later
  // enforces original signer, consent, revocations, exact SHA and fresh issuer.
  const policies=await db.query([
   "SELECT p.fee_source_url FROM public.v13_production_account a",
   "JOIN public.v13_live_money_policy p ON p.id=a.policy_id",
   "AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text",
   "WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2",
   "AND p.state='APPROVED' AND p.fee_policy_version=$2 LIMIT 2"
  ].join(" "),[ownerId,API_POLICY_SIGNED_REVIEW_V1]);
  if(policies.rows.length>1)return {...deny("owner_reviewed_policy_ambiguous"),
   modelId:null,modelValidUntil:null,delegationId:null,
   delegationValidUntil:null,leaseExpiresAt:null,grantId:null,bootstrapGrantId:null};
  const m=/^strata-api-reviewed:\/\/kxbtc15m\/([0-9a-f-]{36})$/.exec(
   text(policies.rows[0]?.fee_source_url));
  const bootstrapGrantId=m&&UUID.test(m[1]??"")?m[1]:null;
  const models=await db.query([
    "SELECT m.model_id::text,m.valid_until",
    "FROM private.strata_api_fee_standing_models m",
    "JOIN auth.users u ON u.id=m.reviewer_admin_id AND u.email_confirmed_at IS NOT NULL",
    "JOIN private.role_assignments r ON lower(btrim(r.email))=lower(btrim(u.email))",
    "AND r.role='ADMIN'",
    "WHERE m.release_commit_sha=$1 AND m.rate_decision_digest=$2",
    "AND m.fee_model_version=$3 AND m.scope='KXBTC15M:INDEX2'",
    "AND m.revoked_at IS NULL AND m.valid_until>now()+interval '1 minute'",
    "LIMIT 2"
  ].join(" "),[release,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION]);
  if(models.rows.length>1)return {...deny("standing_fee_models_ambiguous"),
   modelId:null,modelValidUntil:null,delegationId:null,delegationValidUntil:null,leaseExpiresAt:null,grantId:null,bootstrapGrantId:null};
  const model=models.rows[0];
  const delegation=model?await db.query([
    "SELECT d.delegation_id::text,d.grant_id::text,d.valid_until,d.lease_expires_at",
    "FROM private.strata_api_fee_standing_delegations d",
    "JOIN public.v13_production_account a ON a.owner_user_id=d.owner_user_id",
    "AND a.subaccount=1 AND a.exchange_index=2",
    "JOIN public.v13_live_money_policy p ON p.id=a.policy_id",
    "AND p.execution_account_id=a.id AND p.policy_hash=d.policy_hash",
    "WHERE d.owner_user_id=$1::uuid AND d.model_id=$2::uuid",
    "AND d.revoked_at IS NULL AND d.valid_until>now()",
    "AND d.release_commit_sha=$3 LIMIT 2"
  ].join(" "),[ownerId,model.model_id,release]):{rows:[] as Row[]};
  if(delegation.rows.length>1)return {...deny("standing_fee_delegations_ambiguous"),
   modelId:null,modelValidUntil:null,delegationId:null,delegationValidUntil:null,leaseExpiresAt:null,grantId:null,bootstrapGrantId:null};
  const d=delegation.rows[0];
  return {
   ...deny(model?"standing_fee_model_reviewed_read_only":"independent_standing_fee_model_not_recorded"),
   ok:true as const,modelId:model?text(model.model_id):null,
   modelValidUntil:model?.valid_until??null,
   delegationId:d?text(d.delegation_id):null,
   delegationValidUntil:d?.valid_until??null,
   leaseExpiresAt:d?.lease_expires_at??null,
   grantId:d?text(d.grant_id):null,bootstrapGrantId,
  };
 }catch{return {...deny("standing_fee_readiness_unavailable"),
  modelId:null,modelValidUntil:null,delegationId:null,delegationValidUntil:null,leaseExpiresAt:null,grantId:null,bootstrapGrantId:null};}
}
