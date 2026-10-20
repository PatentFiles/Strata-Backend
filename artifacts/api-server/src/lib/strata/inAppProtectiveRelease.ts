import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { deployedGitSha, DEPLOYED_SHA_RUNTIME_UNAVAILABLE } from "./deployedGitSha";
import { readOwnedKalshiFeeds, personalAccountSnapshot } from "./personalExchangeRead";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";
import { verifyMonetaryFeeContract } from "./monetaryFeeContract";
import type { Identity, Request } from "../v13-production/types";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const REVIEW_URL=/^https:\/\/github\.com\/PatentFiles\/Strata-Backend\/pull\/\d+$/;
export const REVIEW_CONFIRM="I_INDEPENDENTLY_REVIEWED_THE_EXACT_PRODUCTION_PROTECTIVE_EXIT_RELEASE";
export const OWNER_CONFIRM="I_AUTHORIZE_MY_OWN_ACCOUNT_AND_SHARED_LIVE_EXECUTION_AFTER_INDEPENDENT_REVIEW";
type DbRow=Record<string,unknown>;
type Query={query(sql:string,params?:unknown[]):Promise<{rows:DbRow[];rowCount?:number}>};
type Db=Query & {connect():Promise<Query&{release():void}>};
type Deps={db?:Db;sha?:()=>string;readFeeds?:typeof readOwnedKalshiFeeds;verifyFee?:typeof verifyMonetaryFeeContract;now?:()=>number};
const deny=(reason:string)=>({ok:false,reason,ordersSubmitted:false as const});
const valid=(s:unknown):s is string=>typeof s==="string"&&UUID.test(s);
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const truth=(v:unknown)=>v===true||v==="t";
const time=(n:number)=>new Date(n).toISOString();
const accountSQL=`
 SELECT a.id,a.owner_user_id::text AS owner_id,a.commissioned,a.execution_enabled,
 a.kill_switch,a.cash_precision_verified,a.minimum_exit_micros,a.cash_micros::text AS cash_micros,
 a.key_fingerprint,a.policy_id,a.commissioning_digest,a.fee_artifact_digest,
 a.kalshi_connection_id, p.state AS policy_state,p.fee_source_url,p.fee_policy_version,
 p.fee_formula_version,p.approved_at,p.max_entry_stake_cents,p.max_entry_all_in_cents,
 stake.configured_stake_cents
 FROM public.v13_production_account a
 LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id
 LEFT JOIN public.strata_configured_stake stake ON stake.execution_account_id=a.id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`;
export async function readReleaseOwner(db:Query,ownerId:string):Promise<{ok:true;account:DbRow}|{ok:false;reason:string}>{
 if(!valid(ownerId))return {ok:false,reason:"owner_identity_invalid"};
 const a=await db.query(accountSQL,[ownerId]);
 if(a.rows.length!==1)return {ok:false,reason:"owned_account_missing_or_ambiguous"};
 const account=a.rows[0]!;
 if(!truth(account.commissioned)||account.policy_state!=="APPROVED"||
    !truth(account.cash_precision_verified)||Number(account.minimum_exit_micros)!==10000)
   return {ok:false,reason:"account_commissioning_policy_or_floor_unverified"};
 if(!/^[a-f0-9]{64}$/.test(String(account.fee_artifact_digest??"")))
   return {ok:false,reason:"account_fee_digest_unverified"};
 const request=await db.query(`
 SELECT 1 FROM public.v13_production_observation o
 WHERE o.account_id=$1 AND o.kind='OWNER_ACTIVATION_REQUEST' LIMIT 1`,[account.id]);
 if(request.rows.length!==1)return {ok:false,reason:"owner_activation_request_missing"};
 return {ok:true,account};
}
async function loadedMaterial(db:Query,account:DbRow):Promise<{keyId:string;privateKey:string}|null>{
 const r=await db.query(`
 SELECT s.decrypted_secret FROM private.kalshi_connection_credentials c
 JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 WHERE c.owner_user_id=$1::uuid AND c.financial_account_id=$2
 AND c.role='restricted_execution' AND c.revoked_at IS NULL
 AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 AND c.key_fingerprint=$3 LIMIT 2`,
 [account.owner_id,account.kalshi_connection_id,account.key_fingerprint]);
 if(r.rows.length!==1)return null;
 try{
  const parsed=JSON.parse(String(r.rows[0]?.decrypted_secret??"")) as DbRow;
  return typeof parsed.api_key_id==="string"&&typeof parsed.private_key==="string"
    ?{keyId:parsed.api_key_id,privateKey:parsed.private_key}:null;
 }catch{return null;}
}
export async function pendingReleaseOwners(deps:Deps={}){
 const db=deps.db??pool;
 const r=await db.query(`
 SELECT a.owner_user_id::text AS owner_user_id
 FROM public.v13_production_account a
 WHERE a.owner_user_id IS NOT NULL AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
 AND EXISTS(SELECT 1 FROM public.v13_production_observation o
            WHERE o.account_id=a.id AND o.kind='OWNER_ACTIVATION_REQUEST')
 ORDER BY a.owner_user_id LIMIT 25`);
 return r.rows.map(x=>String(x.owner_user_id)).filter(x=>UUID.test(x));
}
export async function protectiveReleaseStatus(actorId:string,ownerId:string,deps:Deps={}){
 try{
  const db=deps.db??pool,sha=(deps.sha??deployedGitSha)();
  if(!valid(actorId)||!valid(ownerId))return deny("identity_invalid");
  if(!SHA.test(sha))return deny("deployed_commit_unverified");
  const owner=await readReleaseOwner(db,ownerId);
  const qualification=await db.query(`
 SELECT qualification_id::text,evidence_digest,expires_at FROM private.strata_protective_release_qualification
 WHERE owner_user_id=$1::uuid AND release_commit_sha=$2 AND expires_at>now()
 ORDER BY observed_at DESC LIMIT 1`,[ownerId,sha]);
  const review=await db.query(`
 SELECT v.review_id::text,v.reviewer_user_id::text,v.review_url,v.evidence_digest,v.expires_at
 FROM private.strata_protective_release_reviews v
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=v.qualification_id
 WHERE v.owner_user_id=$1::uuid AND v.release_commit_sha=$2 AND v.expires_at>now()
 AND q.expires_at>now() ORDER BY v.approved_at DESC LIMIT 2`,[ownerId,sha]);
  const active=await db.query(`
 SELECT release_id::text,expires_at FROM private.strata_protective_exit_release
 WHERE release_commit_sha=$1 AND state='approved' AND revoked_at IS NULL AND expires_at>now()
 LIMIT 2`,[sha]);
  const global=await db.query("SELECT live_execution_enabled,manual_kill_switch FROM public.live_execution_config WHERE id='singleton'");
  const account=owner.ok?owner.account:null;
  return {ok:true,reason:owner.ok?"status_verified":owner.reason,sha,ownerId,
   qualificationId:qualification.rows[0]?.qualification_id??null,
   qualificationExpiresAt:qualification.rows[0]?.expires_at??null,
   reviewerId:review.rows.length===1?review.rows[0]?.reviewer_user_id:null,
   reviewId:review.rows.length===1?review.rows[0]?.review_id:null,
   reviewed:review.rows.length===1,
   releaseActive:active.rows.length===1,
   releaseExpiresAt:active.rows[0]?.expires_at??null,
   accountReady:owner.ok,
   accountExecutionEnabled:account?truth(account.execution_enabled):false,
   globalExecutionEnabled:truth(global.rows[0]?.live_execution_enabled),
   accountKillOn:account?!truth(account.execution_enabled)||truth(account.kill_switch):true,
   globalKillOn:!truth(global.rows[0]?.live_execution_enabled)||truth(global.rows[0]?.manual_kill_switch),
   ordersSubmitted:false as const};
 }catch{return deny("release_status_database_unavailable");}
}
/** Authenticated PRODUCTION API GETs only: full cursor history and V13 comparison.
 * This never creates an order and never sends vault secrets to a browser.
 */
export async function qualifyProtectiveRelease(ownerId:string,deps:Deps={}){
 const db=deps.db??pool,sha=(deps.sha??deployedGitSha)(),now=(deps.now??Date.now)();
 if(!valid(ownerId)||!SHA.test(sha))return deny("release_identity_or_deployment_invalid");
 try{
  const v=await readReleaseOwner(db,ownerId);
  if(!v.ok)return deny(v.reason);
  const account=v.account;
  const unresolved=await readUnresolvedIntentMode((sql,p)=>db.query(sql,p),String(account.id));
  if(!unresolved.ok||unresolved.mode!=="entries")
    return deny("unresolved_order_prevents_release");
  const material=await loadedMaterial(db,account);
  if(!material)return deny("restricted_production_signer_unavailable");
  const feeds=await(deps.readFeeds??readOwnedKalshiFeeds)(material,now);
  if(!feeds.ok)return deny(feeds.reason);
  // The exact account-specific order/fill ledger is authoritative.
  const found=await db.query("SELECT request FROM public.v13_production_intent WHERE account_id=$1",[account.id]);
  const requests=found.rows.flatMap(row=>{
   try{
    const r=typeof row.request==="string"?JSON.parse(row.request):row.request;
    return r&&typeof r==="object"?[r as Request]:[];
   }catch{return [];}
  });
  if(requests.length!==found.rows.length)return deny("financial_intent_unreadable");
  const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:String(account.key_fingerprint)};
  const mapped=personalAccountSnapshot(identity,feeds,requests);
  if(!("identity" in mapped))return deny(mapped.reason);
  // Standing fee policy is already approved; verify the actual official
  // fee source and current series/event schedule again before attestation.
  const fee=await(deps.verifyFee??verifyMonetaryFeeContract)("STEP_11");
  if(!fee.ok||!fee.monetaryFeeAuthorized||
    account.fee_source_url!=="https://kalshi.com/docs/kalshi-fee-schedule.pdf"||
    fee.sourceDigest!==account.fee_artifact_digest)
    return deny("approved_standing_fee_source_not_current");
  if(String(feeds.cashMicros)!==String(account.cash_micros))
    return deny("exchange_and_financial_ledger_cash_mismatch");
  const evidence=hash({sha,ownerId,accountId:account.id,observedAtMs:now,
   cash:feeds.cashMicros,orders:feeds.orders,fills:feeds.fills,
   positions:feeds.positions,settlements:feeds.settlements,
   fee:fee.sourceDigest,policy:account.policy_id});
  const recorded=await db.query(`
 INSERT INTO private.strata_protective_release_qualification
 (release_commit_sha,owner_user_id,execution_account_id,evidence_digest)
 VALUES($1,$2::uuid,$3,$4)
 RETURNING qualification_id::text AS id,expires_at`,
 [sha,ownerId,account.id,evidence]);
  if(recorded.rows.length!==1)return deny("production_read_qualification_not_recorded");
  return {ok:true,reason:"authenticated_production_read_only_qualified",
   qualificationId:recorded.rows[0]?.id,expiresAt:recorded.rows[0]?.expires_at,
   sha,ordersSubmitted:false as const};
 }catch{return deny("authenticated_production_qualification_unavailable");}
}
export async function attestProtectiveReleaseReview(
 actorId:string,role:string,raw:unknown,deps:Deps={}
){
 const db=deps.db??pool,sha=(deps.sha??deployedGitSha)();
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as DbRow:{};
 const ownerId=b.ownerUserId, qid=b.qualificationId;
 const note=typeof b.note==="string"?b.note.trim():"";
 const url=b.reviewUrl;
 if(!valid(actorId)||!valid(ownerId)||actorId===ownerId||
    !["ADMIN","DEVELOPER"].includes(role)||!valid(qid)||!REVIEW_URL.test(String(url))||
    b.confirmation!==REVIEW_CONFIRM||note.length<120||note.length>2500||!SHA.test(sha))
   return deny("genuine_independent_review_and_confirmation_required");
 let client:Awaited<ReturnType<Db["connect"]>>|null=null,committed=false;
 try{
  client=await db.connect();
  await client.query("BEGIN");
  const v=await readReleaseOwner(client,ownerId);
  if(!v.ok)return deny(v.reason);
  const q=await client.query(`
 SELECT qualification_id::text,evidence_digest FROM private.strata_protective_release_qualification
 WHERE qualification_id=$1::uuid AND owner_user_id=$2::uuid AND release_commit_sha=$3
 AND expires_at>now()+interval '60 seconds' FOR SHARE`,
 [qid,ownerId,sha]);
  if(q.rows.length!==1)return deny("independent_production_read_only_evidence_expired");
  const already=await client.query(`
 SELECT 1 FROM private.strata_protective_release_reviews
 WHERE qualification_id=$1::uuid AND reviewer_user_id=$2::uuid LIMIT 1`,
 [qid,actorId]);
  if(already.rows.length)return deny("review_already_recorded");
  const digest=hash({sha,ownerId,reviewerId:actorId,
   qualificationId:qid,qualificationDigest:q.rows[0]?.evidence_digest,reviewUrl:url,note});
  const inserted=await client.query(`
 INSERT INTO private.strata_protective_release_reviews
 (qualification_id,release_commit_sha,reviewer_user_id,owner_user_id,review_url,review_note,evidence_digest)
 VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7)
 RETURNING review_id::text AS id,expires_at`,
 [qid,sha,actorId,ownerId,url,note,digest]);
  if(inserted.rows.length!==1)return deny("independent_review_not_recorded");
  await client.query("COMMIT");committed=true;
  return {ok:true,reason:"independent_release_review_recorded",
    reviewId:inserted.rows[0]?.id,expiresAt:inserted.rows[0]?.expires_at,
    ordersSubmitted:false as const};
 }catch{return deny("independent_release_review_database_unavailable")}
 finally{if(client){if(!committed)try{await client.query("ROLLBACK")}catch{};client.release()}}
}
/** One separate AAL2 owner action: insert genuine release and enable this
 * particular commissioned account + shared infrastructure atomically.
 * No worker is started. ARM and START remain deliberate dashboard actions.
 */
export async function authorizeProtectiveRelease(
 ownerId:string,raw:unknown,deps:Deps={}
){
 const db=deps.db??pool,sha=(deps.sha??deployedGitSha)();
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as DbRow:{};
 if(!valid(ownerId)||!valid(b.reviewId)||b.confirmation!==OWNER_CONFIRM||!SHA.test(sha))
   return deny("explicit_authenticated_owner_release_confirmation_required");
 let client:Awaited<ReturnType<Db["connect"]>>|null=null,committed=false;
 try{
  client=await db.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='1500ms'");
  await client.query("SET LOCAL statement_timeout='12000ms'");
  // Serialize against worker admission, account kill and concurrent grants.
  const v=await readReleaseOwner(client,ownerId);
  if(!v.ok)return deny(v.reason);
  const a=v.account,accountId=String(a.id);
  const locked=await client.query(`
 SELECT id,execution_enabled,kill_switch,cash_micros::text FROM public.v13_production_account
 WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[accountId,ownerId]);
  const current=locked.rows[0];
  if(locked.rows.length!==1||!current||
     truth(current.execution_enabled)||!truth(current.kill_switch))
    return deny("account_no_longer_disarmed_for_release");
  const global=await client.query(`
 SELECT mode,live_execution_enabled,manual_kill_switch FROM public.live_execution_config
 WHERE id='singleton' FOR UPDATE`);
  if(global.rows.length!==1||global.rows[0]?.mode!=="V13_PRODUCTION"||
     truth(global.rows[0]?.live_execution_enabled)||!truth(global.rows[0]?.manual_kill_switch))
   return deny("global_release_not_fail_closed");
  const unresolved=await readUnresolvedIntentMode((sql,p)=>client!.query(sql,p),accountId);
  if(!unresolved.ok||unresolved.mode!=="entries")return deny("release_unresolved_order");
  if(!Number.isSafeInteger(Number(a.configured_stake_cents))||
     Number(a.configured_stake_cents)<=0||
     Number(a.configured_stake_cents)>Number(a.max_entry_stake_cents)||
     Number(a.configured_stake_cents)>Number(a.max_entry_all_in_cents)||
     Number(a.configured_stake_cents)*10000>Number(a.cash_micros))
    return deny("approved_stake_or_cash_not_ready");
  const review=await client.query(`
 SELECT r.review_id::text,r.reviewer_user_id::text,r.review_url,r.evidence_digest,
        q.evidence_digest AS qualification_digest
 FROM private.strata_protective_release_reviews r
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=r.qualification_id
 WHERE r.review_id=$1::uuid AND r.owner_user_id=$2::uuid AND r.release_commit_sha=$3
   AND r.reviewer_user_id<>$2::uuid AND r.expires_at>now()+interval '60 seconds'
   AND q.owner_user_id=$2::uuid AND q.release_commit_sha=$3
   AND q.expires_at>now()+interval '60 seconds'
 FOR SHARE OF r,q`,[b.reviewId,ownerId,sha]);
  if(review.rows.length!==1)return deny("independent_review_or_qualification_expired");
  const reviewer=String(review.rows[0]?.reviewer_user_id);
  const role=await client.query(`
 SELECT 1 FROM auth.users u JOIN public.profiles p ON p.id=u.id
 WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL
 AND p.role IN ('ADMIN','DEVELOPER') LIMIT 1`,[reviewer]);
  if(role.rows.length!==1)return deny("reviewer_authority_expired");
  const prior=await client.query(`
 SELECT 1 FROM private.strata_protective_exit_release WHERE release_commit_sha=$1 LIMIT 1
 `,[sha]);
  if(prior.rows.length)return deny("release_for_exact_commit_already_exists");
  const inserted=await client.query(`
 INSERT INTO private.strata_protective_exit_release
 (release_commit_sha,independent_reviewer_id,operator_approver_id,
 review_url,release_evidence_digest,state,expires_at)
 VALUES($1,$2::uuid,$3::uuid,$4,$5,'approved',now()+interval '2 hours')
 RETURNING release_id::text AS id,expires_at`,
 [sha,reviewer,ownerId,review.rows[0]?.review_url,review.rows[0]?.evidence_digest]);
  if(inserted.rows.length!==1)return deny("release_not_recorded");
  const updated=await client.query(`
 UPDATE public.v13_production_account SET execution_enabled=true,kill_switch=false
 WHERE id=$1 AND owner_user_id=$2::uuid AND commissioned=true
 AND execution_enabled=false AND kill_switch=true RETURNING id`,[accountId,ownerId]);
  if(updated.rows.length!==1)return deny("account_enable_failed");
  const master=await client.query(`
 UPDATE public.live_execution_config SET live_execution_enabled=true,manual_kill_switch=false,updated_at=now()
 WHERE id='singleton' AND mode='V13_PRODUCTION'
 AND live_execution_enabled=false AND manual_kill_switch=true RETURNING id`);
  if(master.rows.length!==1)return deny("shared_live_enable_failed");
  await client.query("COMMIT");committed=true;
  return {ok:true,reason:"owner_approved_release_account_and_shared_live_enabled",
   releaseId:inserted.rows[0]?.id,expiresAt:inserted.rows[0]?.expires_at,
   ordersSubmitted:false as const,workerStarted:false as const};
 }catch{return deny("owner_release_transaction_refused")}
 finally{if(client){if(!committed)try{await client.query("ROLLBACK")}catch{};client.release()}}
}
