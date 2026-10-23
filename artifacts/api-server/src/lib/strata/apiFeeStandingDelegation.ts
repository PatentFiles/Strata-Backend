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
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const OFFICIAL=/^https:\/\/(?:help\.)?kalshi\.com\/(?:docs\/|en\/articles\/|regulatory\/)[A-Za-z0-9.\/_-]+$/;
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
 if(!UUID.test(reviewerId)||!SHA.test(release)||b.confirmation!==STANDING_MODEL_CONFIRM||
    b.rateDecisionDigest!==PDF_FREE_API_RATE_REVIEW_DECISION_SHA256||
    !OFFICIAL.test(text(b.evidenceUrl))||!DIGEST.test(text(b.evidenceSha256))||
    typeof b.note!=="string"||b.note.trim().length<120||b.note.trim().length>1800)
   return deny("independent_official_model_review_evidence_required");
 let proof;
 try{proof=preparePdfFreeApiFeePolicyReview(await (deps.probe??probeCurrentKalshiFeeApi)());}
 catch{return deny("provider_fee_observation_unavailable");}
 if(!proof.ok)return deny("provider_model_observation_unverified");
 try{
 return await tx(deps.db??pool,async c=>{
  if(!await admin(c,reviewerId))return deny("technical_admin_required");
  const conflicts=await c.query("SELECT model_id FROM private.strata_api_fee_standing_models WHERE release_commit_sha=$1 AND rate_decision_digest=$2 AND revoked_at IS NULL AND valid_until>now() LIMIT 1",[release,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256]);
  if(conflicts.rows.length)return deny("active_signed_standing_fee_model_already_exists");
  const id=randomUUID();
  const r=await c.query([
   "INSERT INTO private.strata_api_fee_standing_models",
   "(model_id,reviewer_admin_id,rate_decision_digest,fee_model_version,scope,",
   "release_commit_sha,evidence_url,evidence_sha256,evidence_note,signed_at,valid_until)",
   "VALUES($1::uuid,$2::uuid,$3,$4,'KXBTC15M:INDEX2',$5,$6,$7,$8,now(),now()+interval '30 days')",
   "RETURNING model_id::text,valid_until"
  ].join(" "),[id,reviewerId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
    PDF_FREE_RATE_REVIEW_VECTOR_VERSION,release,b.evidenceUrl,b.evidenceSha256,b.note.trim()]);
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
    b.confirmation!==STANDING_OWNER_CONFIRM)
  return deny("explicit_owner_standing_fee_consent_required");
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
    "AND g.expires_at>now()+interval '60 seconds' AND g.policy_version=$3",
    "AND g.rate_decision_digest=$4 AND g.scope='KXBTC15M:INDEX2'",
    "LIMIT 2 FOR UPDATE OF a"
  ].join(" "),[ownerId,b.grantId,API_POLICY_SIGNED_REVIEW_V1,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256]);
  if(locked.rows.length!==1||!DIGEST.test(text(locked.rows[0]?.policy_hash)))
   return deny("approved_owned_policy_or_fresh_grant_required");
  const model=await c.query([
    "SELECT m.model_id,m.reviewer_admin_id,m.valid_until",
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
  const fresh=await c.query([
   "INSERT INTO private.strata_api_fee_standing_delegations",
   "(delegation_id,owner_user_id,model_id,grant_id,policy_hash,release_commit_sha,",
   "confirmation,granted_at,valid_until,lease_expires_at)",
   "VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,now(),",
   "LEAST($8::timestamptz,now()+interval '30 days'),",
   "LEAST($8::timestamptz,now()+interval '15 minutes'))",
   "ON CONFLICT DO NOTHING RETURNING delegation_id::text,valid_until"
  ].join(" "),[randomUUID(),ownerId,b.modelId,b.grantId,text(locked.rows[0]?.policy_hash),
     release,STANDING_OWNER_CONFIRM,model.rows[0]?.valid_until]);
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
const CONTINUE_SQL = [
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
 "AND g.policy_version=$5 AND g.fee_model_version=$6",
 "AND g.rate_decision_digest=$7 AND g.scope='KXBTC15M:INDEX2'",
 "AND m.rate_decision_digest=g.rate_decision_digest AND m.fee_model_version=g.fee_model_version",
 "AND m.scope=g.scope AND m.revoked_at IS NULL AND m.valid_until>now()+interval '12 seconds'",
 "AND m.reviewer_admin_id<>d.owner_user_id",
 "AND m.release_commit_sha=$3 AND d.release_commit_sha=$3",
 "AND d.revoked_at IS NULL AND d.valid_until>now()+interval '12 seconds'",
 "AND d.owner_user_id=$1::uuid AND d.grant_id=$2::uuid",
 "AND d.confirmation='I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1'",
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
