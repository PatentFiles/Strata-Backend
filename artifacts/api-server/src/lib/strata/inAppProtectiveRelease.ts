import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { deployedGitSha, DEPLOYED_SHA_RUNTIME_UNAVAILABLE } from "./deployedGitSha";
import { readOwnedKalshiFeeds, personalAccountSnapshot } from "./personalExchangeRead";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";
import { verifyProtectiveReleaseFeePreflight } from "./protectiveReleaseFeePreflight";
import { digest as v13Digest, type Identity, type Request } from "../v13-production/types";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const REVIEW_URL=/^https:\/\/github\.com\/PatentFiles\/Strata-Backend\/pull\/\d+$/;
export const REVIEW_CONFIRM="I_INDEPENDENTLY_REVIEWED_THE_EXACT_PRODUCTION_PROTECTIVE_EXIT_RELEASE";
export const OWNER_CONFIRM="I_AUTHORIZE_MY_OWN_ACCOUNT_AND_SHARED_LIVE_EXECUTION_AFTER_INDEPENDENT_REVIEW";
export const PROVISIONAL_REPAIR_CONFIRM="I_AUTHORIZE_AN_AUDITED_REPAIR_OF_MY_STALE_COMMISSIONING_BLOCKER";
type DbRow=Record<string,unknown>;
type Query={query(sql:string,params?:unknown[]):Promise<{rows:DbRow[];rowCount?:number}>};
type Db=Query & {connect():Promise<Query&{release():void}>};
type Deps={db?:Db;sha?:()=>string;readFeeds?:typeof readOwnedKalshiFeeds;verifyFee?:typeof verifyProtectiveReleaseFeePreflight;now?:()=>number};
const deny=(reason:string)=>({ok:false,reason,ordersSubmitted:false as const});
const valid=(s:unknown):s is string=>typeof s==="string"&&UUID.test(s);
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const truth=(v:unknown)=>v===true||v==="t";
const time=(n:number)=>new Date(n).toISOString();
const accountSQL=`
 SELECT a.id,a.owner_user_id::text AS owner_id,a.commissioned,a.execution_enabled,
 a.kill_switch,a.cash_precision_verified,a.minimum_exit_micros,a.cash_micros::text AS cash_micros,
 a.blocked_reason,
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
 SELECT o.digest FROM public.v13_production_observation o
 WHERE o.account_id=$1 AND o.kind='OWNER_ACTIVATION_REQUEST'
 ORDER BY o.observed_at DESC LIMIT 1`,[account.id]);
 const expected=v13Digest({
  accountId:String(account.id),policyId:String(account.policy_id??""),
  feeDigest:String(account.fee_artifact_digest??""),
  stakeCents:Number(account.configured_stake_cents),
  commissioningDigest:String(account.commissioning_digest??""),
  minimumExitMicros:Number(account.minimum_exit_micros),
 });
 if(request.rows.length!==1||request.rows[0]?.digest!==expected)
   return {ok:false,reason:"owner_activation_request_stale_or_missing"};
 return {ok:true,account};
}
export async function loadedMaterial(db:Query,account:DbRow):Promise<{keyId:string;privateKey:string}|null>{
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
 AND q.expires_at>now() ORDER BY v.approved_at DESC LIMIT 1`,[ownerId,sha]);
  const active=await db.query(`
 SELECT release_id::text,expires_at FROM private.strata_protective_exit_release
 WHERE release_commit_sha=$1 AND state='approved' AND revoked_at IS NULL AND expires_at>now()
 LIMIT 2`,[sha]);
  // New owner SHA releases are account-specific and durable until revoked.
  // Missing staged schema retains the legacy status without granting authority.
  let ownerMode=false,ownerApproved=false,ownerApprovalId:null|string=null;
  try{
    const own=await db.query(`SELECT approval_id::text FROM private.strata_owner_sha_approvals
      WHERE owner_user_id=$1::uuid AND release_commit_sha=$2 AND revoked_at IS NULL LIMIT 2`,[ownerId,sha]);
    ownerMode=true;ownerApproved=own.rows.length===1;
    ownerApprovalId=ownerApproved?String(own.rows[0]?.approval_id):null;
  }catch{ownerMode=false;}
  const global=await db.query("SELECT live_execution_enabled,manual_kill_switch FROM public.live_execution_config WHERE id='singleton'");
  const account=owner.ok?owner.account:null;
  return {ok:true,reason:owner.ok?"status_verified":owner.reason,sha,ownerId,
   qualificationId:qualification.rows[0]?.qualification_id??null,
   qualificationExpiresAt:qualification.rows[0]?.expires_at??null,
   reviewerId:review.rows.length===1?review.rows[0]?.reviewer_user_id:null,
   reviewId:review.rows.length===1?review.rows[0]?.review_id:null,
   reviewed:review.rows.length===1,
   releaseMode:ownerMode?'OWNER_SHA_V1':'LEGACY_TWO_HOUR',
   codeApprovalActive:ownerApproved,codeApprovalId:ownerApprovalId,
   releaseActive:ownerApproved||active.rows.length===1,
   releaseExpiresAt:active.rows[0]?.expires_at??null,
   accountReady:owner.ok,
   provisionalFreezeDetected:owner.ok&&owner.account.blocked_reason==="awaiting_account_commissioning",
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
  if(account.blocked_reason!==null&&account.blocked_reason!==undefined&&
     account.blocked_reason!=="awaiting_account_commissioning")
    return deny("account_risk_freeze_requires_independent_remediation");
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
  if(account.blocked_reason==="awaiting_account_commissioning" &&
     (mapped.orders.length>0||mapped.fills.length>0||mapped.positions.length>0||
      mapped.settlements.length>0||requests.length>0))
    return deny("commissioning_repair_requires_empty_exchange_and_ledger_history");
  // Standing fee policy is already approved; verify the actual official
  // fee source and current series/event schedule again before attestation.
  const fee=await(deps.verifyFee??verifyProtectiveReleaseFeePreflight)();
  // These are fixed, low-cardinality evidence reason codes only. Never send
  // provider response bodies, HTTP headers, keys, URLs with query parameters
  // or signer details to the frontend. Source-verification failures are distinct
  // from persisted account-policy identity failures, so a 429 can be diagnosed.
  if(!fee.ok){
    const reason=typeof fee.reason==="string"&&
      /^[a-z][a-z0-9_]{2,95}$/.test(fee.reason)
      ? fee.reason:"fee_preflight_unavailable";
    return deny("release_fee_"+reason);
  }
  if(account.fee_source_url!=="https://kalshi.com/docs/kalshi-fee-schedule.pdf")
    return deny("approved_fee_source_url_mismatch");
  if(!/^[a-f0-9]{64}$/.test(String(fee.sourceDigest??"")))
    return deny("current_official_fee_digest_missing");
  if(fee.sourceDigest!==account.fee_artifact_digest)
    return deny("approved_fee_artifact_digest_changed");
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
 const repairing=b.provisionalRepairConfirmation===PROVISIONAL_REPAIR_CONFIRM;
 if(b.provisionalRepairConfirmation!==undefined&&!repairing)
   return deny("explicit_commissioning_repair_confirmation_invalid");
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
 SELECT id,execution_enabled,kill_switch,cash_micros::text,
   blocked_reason,reserved_micros::text,reconciled_at,
   commissioned,cash_precision_verified FROM public.v13_production_account
 WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[accountId,ownerId]);
  const current=locked.rows[0];
  if(locked.rows.length!==1||!current||
     truth(current.execution_enabled)===truth(current.kill_switch))
    return deny("account_inconsistent_execution_kill_state");
  const frozen=current.blocked_reason;
  if(frozen!==null&&frozen!==undefined&&frozen!=="awaiting_account_commissioning")
    return deny("account_risk_freeze_requires_independent_remediation");
  if(frozen==="awaiting_account_commissioning"&&!repairing)
    return deny("explicit_commissioning_repair_confirmation_required");
  if(frozen!=="awaiting_account_commissioning"&&repairing)
    return deny("commissioning_repair_not_applicable");
  const accountNeedsEnable=!truth(current.execution_enabled);
  const global=await client.query(`
 SELECT mode,live_execution_enabled,manual_kill_switch FROM public.live_execution_config
 WHERE id='singleton' FOR UPDATE`);
  if(global.rows.length!==1||global.rows[0]?.mode!=="V13_PRODUCTION"||
     truth(global.rows[0]?.live_execution_enabled)===truth(global.rows[0]?.manual_kill_switch))
   return deny("global_execution_kill_state_inconsistent");
  const globalNeedsEnable=!truth(global.rows[0]?.live_execution_enabled);
  if(accountNeedsEnable!==globalNeedsEnable)
    return deny("account_global_release_state_mismatch");
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
  let repairEvidence:{observedAtMs:number;exchangeDigest:string}|null=null;
  if(repairing){
    const rec=await client.query(`
 SELECT (SELECT count(*)::text FROM public.v13_production_intent WHERE account_id=$1) intents,
        (SELECT count(*)::text FROM public.v13_production_event WHERE account_id=$1) events,
        (SELECT count(*)::text FROM public.v13_production_position
           WHERE account_id=$1 AND quantity_hundredths>0) positions,
        (SELECT count(*)::text FROM private.strata_emergency_exit_reservations
           WHERE execution_account_id=$1) exit_reservations`,[accountId]);
    const counts=rec.rows[0];
    if(rec.rows.length!==1||!counts||
       ["intents","events","positions","exit_reservations"].some(k=>String(counts[k])!=="0")||
       !truth(current.commissioned)||!truth(current.cash_precision_verified)||
       String(current.reserved_micros)!=="0"||
       !current.reconciled_at||
       !Number.isFinite(Date.parse(String(current.reconciled_at))))
      return deny("commissioning_repair_fresh_zero_exposure_unverified");

    // The reconciliation previously required a worker-maintained DB timestamp
    // younger than 15s. That timestamp cannot stay fresh during a genuinely
    // independent human review, especially when the trading worker is STOPPED.
    // Instead obtain the *authoritative* signed, complete, account-scoped
    // Kalshi balance/order/fill/position/settlement history NOW, while the
    // financial row is locked and before making the owner-approved transition.
    const material=await loadedMaterial(client,a);
    if(!material)return deny("commissioning_repair_restricted_signer_unavailable");
    const observedAtMs=(deps.now??Date.now)();
    const feeds=await(deps.readFeeds??readOwnedKalshiFeeds)(material,observedAtMs);
    if(!feeds.ok)return deny("commissioning_repair_live_exchange_read_unavailable");
    if(!Number.isSafeInteger(feeds.observedAtMs)||
       feeds.observedAtMs!==observedAtMs||
       Date.now()-observedAtMs>15_000||
       observedAtMs-Date.now()>2000||
       String(feeds.cashMicros)!==String(current.cash_micros))
      return deny("commissioning_repair_live_cash_or_freshness_unverified");
    const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:String(a.key_fingerprint)};
    const snapshot=personalAccountSnapshot(identity,feeds,[]);
    if(!("identity" in snapshot)||
       snapshot.orders.length!==0||snapshot.fills.length!==0||
       snapshot.positions.length!==0||snapshot.settlements.length!==0||
       feeds.orders.length!==0||feeds.fills.length!==0||
       feeds.settlements.length!==0)
      return deny("commissioning_repair_live_exposure_unverified");
    repairEvidence={observedAtMs,exchangeDigest:hash({
      accountId,sha,observedAtMs,cashMicros:feeds.cashMicros,
      orders:feeds.orders,fills:feeds.fills,
      positions:feeds.positions,settlements:feeds.settlements,
    })};
  }
  const prior=await client.query(`
 SELECT release_id::text FROM private.strata_protective_exit_release
 WHERE release_commit_sha=$1 AND revoked_at IS NULL AND expires_at>now()
 FOR UPDATE`,[sha]);
  if(prior.rows.length>1)return deny("active_release_duplicate_or_unverified");
  if(prior.rows.length===1){
    // Renewal is atomic: revoke the old release only inside the transaction
    // that commits a fresh independent review and replacement release.
    const revoked=await client.query(`
      UPDATE private.strata_protective_exit_release SET revoked_at=now()
      WHERE release_id=$1::uuid AND revoked_at IS NULL RETURNING release_id`,
      [prior.rows[0]?.release_id]);
    if(revoked.rows.length!==1)return deny("prior_release_revocation_failed");
  }
  const inserted=await client.query(`
 INSERT INTO private.strata_protective_exit_release
 (release_commit_sha,independent_reviewer_id,operator_approver_id,
 review_url,release_evidence_digest,state,expires_at)
 VALUES($1,$2::uuid,$3::uuid,$4,$5,'approved',now()+interval '2 hours')
 RETURNING release_id::text AS id,expires_at`,
 [sha,reviewer,ownerId,review.rows[0]?.review_url,review.rows[0]?.evidence_digest]);
  if(inserted.rows.length!==1)return deny("release_not_recorded");
  if(repairing){
    const clear=await client.query(`
 UPDATE public.v13_production_account SET blocked_reason=NULL,revision=revision+1
 WHERE id=$1 AND owner_user_id=$2::uuid
   AND blocked_reason='awaiting_account_commissioning'
   AND commissioned=true AND cash_precision_verified=true
   AND reserved_micros=0
   -- DB-server freshness check on the independent signed provider read.
   -- Do not rely on a stale cached worker reconciliation timestamp.
   AND $3::timestamptz > statement_timestamp()-interval '15 seconds'
   AND $3::timestamptz <= statement_timestamp()+interval '2 seconds'
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent WHERE account_id=$1)
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_event WHERE account_id=$1)
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths>0)
   AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1)
 RETURNING id`,[accountId,ownerId,
     repairEvidence?new Date(repairEvidence.observedAtMs).toISOString():null]);
    if(clear.rows.length!==1)return deny("commissioning_repair_transactional_guard_failed");
    if(!repairEvidence)return deny("commissioning_repair_fresh_exchange_evidence_missing");
    const audit={accountId,ownerId,releaseSha:sha,reviewId:String(b.reviewId),
      reviewerId:reviewer,priorReason:"awaiting_account_commissioning",
      newReason:null,confirmation:PROVISIONAL_REPAIR_CONFIRM,
      liveExchangeObservedAtMs:repairEvidence.observedAtMs,
      liveExchangeEvidenceDigest:repairEvidence.exchangeDigest};
    await client.query(`
 INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
 VALUES($1,$2,'OWNER_COMMISSIONING_FREEZE_REPAIR',$3::jsonb,$4)`,
    [randomUUID(),accountId,JSON.stringify(audit),v13Digest(audit)]);
  }
  if(accountNeedsEnable){
    const updated=await client.query(`
 UPDATE public.v13_production_account SET execution_enabled=true,kill_switch=false
 WHERE id=$1 AND owner_user_id=$2::uuid AND commissioned=true
 AND execution_enabled=false AND kill_switch=true RETURNING id`,[accountId,ownerId]);
    if(updated.rows.length!==1)return deny("account_enable_failed");
  }
  if(globalNeedsEnable){
    const master=await client.query(`
 UPDATE public.live_execution_config SET live_execution_enabled=true,manual_kill_switch=false,updated_at=now()
 WHERE id='singleton' AND mode='V13_PRODUCTION'
 AND live_execution_enabled=false AND manual_kill_switch=true RETURNING id`);
    if(master.rows.length!==1)return deny("shared_live_enable_failed");
  }
  await client.query("COMMIT");committed=true;
  return {ok:true,reason:"owner_approved_release_account_and_shared_live_enabled",
   releaseId:inserted.rows[0]?.id,expiresAt:inserted.rows[0]?.expires_at,
   provisionalFreezeRepaired:repairing,
   ordersSubmitted:false as const,workerStarted:false as const};
 }catch{return deny("owner_release_transaction_refused")}
 finally{if(client){if(!committed)try{await client.query("ROLLBACK")}catch{};client.release()}}
}
