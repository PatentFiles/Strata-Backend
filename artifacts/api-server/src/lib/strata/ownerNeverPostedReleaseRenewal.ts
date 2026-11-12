import {readConsentGeneration,requireKilledConsentBinding,type KilledConsentPin} from './ownerConsentGeneration';
import {logger} from '../logger';
import {ownerRenewalFailureDiagnostics} from './ownerRenewalFailureDiagnostics';
import {randomUUID,createHash} from 'node:crypto';
import {readReleaseOwner,loadedMaterial} from './inAppProtectiveRelease';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import {dedicatedSignerFingerprint} from './commissioning';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {digest,type Identity} from '../v13-production/types';
import {V13_MIN_ENTRY_STAKE_CENTS,computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {approvedFromRow} from './ownerStakePolicyAmendment';
import {STANDING_REVIEW_CONFIRM} from './standingExecutionReview';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import type {Pool,PoolClient} from '@workspace/db';
import {readReconciledReleaseRenewalHistory,verifyReconciledReleaseRenewalSnapshot,type ReconciledReleaseHistory} from './reconciledReleaseRenewalHistory';
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Client=Query&{release():void};type Db=Query&{connect():Promise<Client>};
const fail=(reason:string)=>({ok:false as const,reason,ordersSubmitted:false as const});
const requireProof=(v:unknown,reason:string)=>{if(!v)throw Error(reason);};
const fresh=(start:number,now:number)=>Number.isSafeInteger(start)&&Number.isSafeInteger(now)&&now>=start&&now-start<=15000;
const SCOPE=`SELECT a.*,a.owner_user_id::text AS owner_id,p.policy_hash,
 w.state AS worker_state,w.arm_requested,w.account_kill AS worker_kill,
 jsonb_build_object('account',a.xmin::text,'policy',p.xmin::text,'lease',w.xmin::text,
  'credential',c.xmin::text,'financial',fa.xmin::text,'provider',pc.xmin::text,
  'fence',w.fencing_token::text,'holder',w.holder_id,'vault',c.vault_secret_id::text) AS hold_revision
 FROM public.v13_production_account a
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text AND p.state='APPROVED'
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=fa.id
  AND c.provider_connection_id=pc.id AND c.key_fingerprint=a.key_fingerprint AND c.role='restricted_execution'
  AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
 AND w.financial_account_id=fa.id AND w.provider_connection_id=pc.id
 AND w.credential_fingerprint=a.key_fingerprint AND w.vault_secret_id=c.vault_secret_id LIMIT 2`;
export type DisabledStoppedApprovalScope={
 mode:"DISABLED_STOPPED_APPROVAL_ONLY"|"DISABLED_KILLED_APPROVAL_ONLY";accountId:string;policyId:string;policyHash:string;consentPin?:KilledConsentPin;
};
async function scope(db:Query,owner:string,lock=false,approvalOnly?:DisabledStoppedApprovalScope){
 const r=await db.query(SCOPE+(lock?' FOR UPDATE OF a,w FOR SHARE OF p,c,fa,pc':''),[owner]);
 requireProof(r.rows.length===1,'owner_renewal_account_credential_scope_unverified');const a=r.rows[0]!;
 requireProof(approvalOnly
  ? (approvalOnly.mode==="DISABLED_STOPPED_APPROVAL_ONLY"||approvalOnly.mode==="DISABLED_KILLED_APPROVAL_ONLY")&&a.execution_enabled===false&&a.kill_switch===true&&
    a.id===approvalOnly.accountId&&a.policy_id===approvalOnly.policyId&&a.policy_hash===approvalOnly.policyHash
  : a.execution_enabled===true,approvalOnly?'owner_renewal_account_mode_or_scope_changed':'owner_renewal_commissioned_unfrozen_flat_account_required');
 requireProof(a.commissioned===true&&a.cash_precision_verified===true&&a.blocked_reason===null&&
  String(a.reserved_micros)==='0','owner_renewal_commissioned_unfrozen_flat_account_required');
 requireProof(approvalOnly?.mode==='DISABLED_KILLED_APPROVAL_ONLY'
  ? a.worker_state==='killed'&&a.arm_requested===false&&a.worker_kill===true
  : a.worker_state==='released'&&a.arm_requested===false&&a.worker_kill===false,
  'owner_renewal_worker_must_be_released_and_disarmed');return a;
}
/** Read-only routing hint, never approval or live readiness. The POST repeats
 * every proof under locks and obtains fresh complete signed exchange history. */
export async function disabledStoppedApprovalStatus(db:Query,owner:string,sha:string){
 const no=(reason:string)=>({available:false,reason});
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(owner)||
    !/^[a-f0-9]{40}$/.test(sha))return no("owner_approval_only_identity_invalid");
 try{
  const initial=await readReleaseOwner(db,owner);
  if(!initial.ok)return no(initial.reason);
  const a=initial.account;
  const expected:DisabledStoppedApprovalScope={mode:"DISABLED_STOPPED_APPROVAL_ONLY",
   accountId:String(a.id),policyId:String(a.policy_id),policyHash:String(a.policy_hash)};
  const current=await scope(db,owner,false,expected);
  await priorAuthority(db,owner,current);
  return {available:true,reason:"owner_approval_only_explicit_consent_and_fresh_proof_required",
   sha,...expected};
 }catch{return no("owner_approval_only_historical_scope_unavailable");}
}
export async function disabledKilledApprovalStatus(db:Query,owner:string,sha:string){
 try {
  const v=await readReleaseOwner(db,owner);if(!v.ok)return {available:false,reason:v.reason};
  const a=v.account;
  const expected:DisabledStoppedApprovalScope={mode:'DISABLED_KILLED_APPROVAL_ONLY',accountId:String(a.id),policyId:String(a.policy_id),policyHash:String(a.policy_hash)};
  const current=await scope(db,owner,false,expected);await priorAuthority(db,owner,current);
  const consentGeneration=await readConsentGeneration(db,owner,String(a.id));
  const rows=await db.query(`SELECT oa.approval_id::text,b.qualification_id::text FROM private.strata_owner_sha_approvals oa
   JOIN private.strata_owner_consent_bindings b ON b.qualification_id=oa.qualification_id
   WHERE oa.owner_user_id=$1::uuid AND oa.execution_account_id=$2 AND oa.release_commit_sha=$3 AND oa.revoked_at IS NULL
   AND b.owner_user_id=oa.owner_user_id AND b.execution_account_id=oa.execution_account_id AND b.release_commit_sha=oa.release_commit_sha
   AND b.mode='DISABLED_KILLED_APPROVAL_ONLY' AND b.generation=$4::bigint AND b.account_xmin=$5 AND b.policy_id=$6 AND b.policy_hash=$7 AND b.credential_fingerprint=$8 LIMIT 2`,
   [owner,a.id,sha,consentGeneration,(current.hold_revision as Record<string,unknown>).account,a.policy_id,a.policy_hash,a.key_fingerprint]);
  const allActive=await db.query('SELECT approval_id FROM private.strata_owner_sha_approvals WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3 AND revoked_at IS NULL LIMIT 2',[owner,a.id,sha]);
  const pin={sha,...expected,signerFingerprint:String(a.key_fingerprint),consentGeneration};
  return {...pin,available:allActive.rows.length===0,reason:allActive.rows.length>0?'owner_killed_code_approval_already_active_readback_required':'owner_killed_code_approval_fresh_consent_required',
   accountExecutionEnabled:false,accountKillOn:true,workerState:'killed',workerKill:true,armRequested:false,
   receipt:rows.rows.length===1?{...pin,qualificationId:rows.rows[0]!.qualification_id,approvalId:rows.rows[0]!.approval_id,ordersSubmitted:false}:null};
 }catch{return {available:false,reason:'owner_killed_code_approval_scope_unavailable'};}
}
async function priorAuthority(db:Query,owner:string,a:Row,lock=false){
 // Inspect the latest grant INCLUDING revocations. Never fall back to an older
 // active grant to erase a newer revocation. Consent is historical eligibility,
 // not standing permission for this new SHA; that remains a separate action.
 const grants=await db.query(`SELECT * FROM private.strata_continuous_execution_grants
  WHERE owner_user_id=$1::uuid AND execution_account_id=$2 ORDER BY consented_at DESC,grant_id DESC LIMIT 1 ${lock?'FOR SHARE':''}`,[owner,a.id]);
 requireProof(grants.rows.length===1,'owner_renewal_prior_grant_required');const g=grants.rows[0]!;
 const rs=await db.query(`SELECT r.release_id,oa.approval_id,g.grant_id,
  (g.revoked_at IS NULL AND g.policy_hash=$3 AND g.consented_at<=now()
   AND g.owner_confirmation='I_AUTHORIZE_REVOCABLE_CONTINUOUS_EXECUTION_FOR_MY_REVIEWED_EXACT_SHA_V1'
   AND r.state='approved' AND r.revoked_at IS NULL AND r.policy_hash=g.policy_hash
   AND r.created_at<=g.consented_at AND r.independent_reviewer_id=g.independent_reviewer_id
   AND r.independent_reviewer_id<>g.owner_user_id AND oa.confirmed_at<=g.consented_at
   AND oa.confirmed_at>=q.observed_at AND oa.confirmed_at<q.expires_at
   AND oa.qualification_digest=q.evidence_digest) AS valid_prior
  FROM private.strata_continuous_execution_grants g
  JOIN private.strata_standing_execution_reviews r ON r.release_id=g.reviewed_release_id
   AND r.owner_user_id=g.owner_user_id AND r.execution_account_id=g.execution_account_id AND r.release_commit_sha=g.release_commit_sha
  JOIN private.strata_owner_sha_approvals oa ON oa.owner_user_id=g.owner_user_id AND oa.execution_account_id=g.execution_account_id
   AND oa.release_commit_sha=g.release_commit_sha AND oa.revoked_at IS NULL
  JOIN private.strata_protective_release_qualification q ON q.qualification_id=oa.qualification_id
   AND q.owner_user_id=oa.owner_user_id AND q.execution_account_id=oa.execution_account_id AND q.release_commit_sha=oa.release_commit_sha
  WHERE g.grant_id=$1::uuid AND g.owner_user_id=$2::uuid ${lock?'FOR SHARE OF g,r,oa,q':''}`,[g.grant_id,owner,a.policy_hash]);
 requireProof(rs.rows.length===1&&rs.rows[0]!.valid_prior===true,'owner_renewal_prior_authority_revoked_or_scope_changed');
 return {grantId:String(g.grant_id),approvalId:String(rs.rows[0]!.approval_id),releaseId:String(rs.rows[0]!.release_id),sha:String(g.release_commit_sha)};
}
async function currentQualification(db:Query,qualification:string,owner:string,account:string,sha:string,lock=false){
 const proof=await db.query(`SELECT qualification_id::text,evidence_digest FROM private.strata_protective_release_qualification
  WHERE qualification_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3 AND release_commit_sha=$4
  AND observed_at<=clock_timestamp() AND expires_at>clock_timestamp()+interval '60 seconds' ${lock?'FOR SHARE':''}`,[qualification,owner,account,sha]);
 requireProof(proof.rows.length===1,'fresh_authenticated_production_qualification_required');return proof;
}
async function noFinancialHistory(db:Query,account:string){
 const r=await db.query(`SELECT
 (SELECT count(*)::text FROM public.v13_production_event WHERE account_id=$1) events,
 (SELECT count(*)::text FROM public.v13_production_position WHERE account_id=$1 AND (quantity_hundredths<>0 OR basis_micros<>0 OR realized_pnl_micros<>0)) positions,
 (SELECT count(*)::text FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1) exits`,[account]);
 requireProof(r.rows.length===1&&['events','positions','exits'].every(k=>r.rows[0]![k]==='0'),
  'owner_renewal_actual_financial_or_exit_history_unsupported');
}
async function reconciledAuthorityProof(db:Query,owner:string,a:Row,authority:{releaseId:string;sha:string},lock=false){
 const policy=await db.query(`SELECT p.*,p.xmin::text AS row_revision FROM public.v13_live_money_policy p
  WHERE id=$1 AND execution_account_id=$2 AND created_by=$3 AND state='APPROVED' ${lock?'FOR SHARE':''}`,[a.policy_id,a.id,owner]);
 requireProof(policy.rows.length===1,'owner_renewal_policy_unverified');
 const decoded=approvedFromRow(policy.rows[0]!);
 requireProof(decoded&&decoded.policyHash===a.policy_hash&&computeV13LiveMoneyPolicyHash(decoded)===a.policy_hash,'owner_renewal_policy_unverified');
 const reviews=await db.query(`SELECT r.*,r.xmin::text AS review_revision,q.xmin::text AS qualification_revision,
  q.evidence_digest AS qualification_digest,q.observed_at AS qualification_observed_at,q.expires_at AS qualification_expires_at
  FROM private.strata_standing_execution_reviews r JOIN private.strata_protective_release_qualification q
  ON q.qualification_id=r.qualification_id AND q.owner_user_id=r.owner_user_id AND q.execution_account_id=r.execution_account_id
   AND q.release_commit_sha=r.release_commit_sha WHERE r.release_id=$1::uuid AND r.owner_user_id=$2::uuid
  AND r.execution_account_id=$3 AND r.release_commit_sha=$4 ${lock?'FOR SHARE OF r,q':''}`,[authority.releaseId,owner,a.id,authority.sha]);
 requireProof(reviews.rows.length===1,'owner_renewal_prior_review_proof_unverified');const r=reviews.rows[0]!;
 const when=(x:unknown)=>x instanceof Date?x.getTime():Date.parse(String(x));
 const at=when(r.created_at),start=when(r.qualification_observed_at),end=when(r.qualification_expires_at);
 const expected=createHash('sha256').update(JSON.stringify({actor:r.independent_reviewer_id,owner,sha:authority.sha,qid:r.qualification_id,
  account:a.id,policy:r.policy_hash,qualification:r.qualification_digest,note:r.review_note,url:r.review_url,scope:STANDING_REVIEW_CONFIRM})).digest('hex');
 requireProof(r.state==='approved'&&r.revoked_at===null&&r.policy_hash===a.policy_hash&&r.independent_reviewer_id!==owner&&
  r.confirmation===STANDING_REVIEW_CONFIRM&&Number.isFinite(at)&&Number.isFinite(start)&&Number.isFinite(end)&&start<=at&&at<end&&
  typeof r.review_note==='string'&&r.review_note.length>=120&&r.review_note.length<=2500&&
  /^https:\/\/github\.com\/PatentFiles\/Strata-Backend\/pull\/\d+$/.test(String(r.review_url))&&r.evidence_digest===expected,
  'owner_renewal_prior_review_proof_unverified');
 return digest({policy:policy.rows[0],review:r});
}
/** Narrow owner-consent renewal for a previously authorized commissioned account
 * whose entire retained order history is proven never posted. No account/worker,
 * fee, standing-grant or reviewer authority is changed. Filled histories remain
 * unsupported here, rather than being treated as empty or erased. */
export async function authorizeNeverPostedReleaseRenewal(owner:string,qualification:string,sha:string,
 deps:{db:Db;now:()=>number;sha:()=>string;readFeeds:typeof readOwnedKalshiFeeds}){
 return authorizeRetainedReleaseRenewal(owner,qualification,sha,deps,false);
}
/** Explicit new-SHA owner consent with retained, reconciled history. Shares
 * all prior-authority, stopped scope, freshness and atomic approval fences;
 * never changes controls, historical evidence, grants or reviewer authority. */
export async function authorizeReconciledHistoryReleaseRenewal(owner:string,qualification:string,sha:string,
 deps:{db:Db;now:()=>number;sha:()=>string;readFeeds:typeof readOwnedKalshiFeeds},approvalOnly?:DisabledStoppedApprovalScope){
 try{
  const initial=await readReleaseOwner(deps.db,owner);
  if(!initial.ok)return fail(initial.reason);
  const retained=await deps.db.query("SELECT id FROM public.v13_production_intent WHERE account_id=$1 AND (kind='EXIT' OR state='TERMINAL') LIMIT 1",[initial.account.id]);
  // Existing ENTRY-only never-posted renewals keep their original contract.
  // This classification grants nothing; either core path revalidates history.
  return authorizeRetainedReleaseRenewal(owner,qualification,sha,deps,retained.rows.length>0,approvalOnly);
 }catch{return fail('owner_renewal_history_classification_unavailable');}
}
async function authorizeRetainedReleaseRenewal(owner:string,qualification:string,sha:string,
 deps:{db:Db;now:()=>number;sha:()=>string;readFeeds:typeof readOwnedKalshiFeeds},reconciled:boolean,approvalOnly?:DisabledStoppedApprovalScope){
 let tx:Client|null=null,committed=false;let phase="preflight_authority";
 try{
  const initial=await readReleaseOwner(deps.db,owner);requireProof(initial.ok,'owner_renewal_activation_unverified');
  if(!initial.ok)return fail(initial.reason);
  const a=await scope(deps.db,owner,false,approvalOnly),account=String(a.id);
  const authority=await priorAuthority(deps.db,owner,a);
  const authorityProof=reconciled?await reconciledAuthorityProof(deps.db,owner,a,authority):null;
  if(approvalOnly?.mode==='DISABLED_KILLED_APPROVAL_ONLY'){
   requireProof(approvalOnly.consentPin,'owner_renewal_consent_pin_invalid');
   // Preliminary generation only; actual binding verified under locks below.
   requireProof(await readConsentGeneration(deps.db,owner,account)===approvalOnly.consentPin!.consentGeneration,'owner_renewal_consent_generation_changed');
  }
  const qualified=await currentQualification(deps.db,qualification,owner,account,sha);
  phase="preflight_history";
  if(!reconciled)await noFinancialHistory(deps.db,account);
  const history=reconciled?await readReconciledReleaseRenewalHistory(deps.db,account,owner):await readNeverPostedReleaseHistory(deps.db,account);
  if(!reconciled){
   requireProof(history.rows.length>0&&history.neverPosted.length===history.rows.length&&history.expectedRequests.length===0,
    'owner_renewal_only_proven_never_posted_history_supported');
   requireProof(history.rows.every(i=>i.policy_hash===a.policy_hash),'owner_renewal_history_policy_changed');
  }
  phase="signed_history";
  const material=await loadedMaterial(deps.db,a);
  requireProof(material&&dedicatedSignerFingerprint(material.keyId,material.privateKey)===a.key_fingerprint,
   'owner_renewal_restricted_signer_unverified');
  const started=deps.now();const feeds=await deps.readFeeds(material!,started);
  requireProof(feeds.ok&&feeds.historicalCoverageComplete===true&&feeds.observedAtMs===started&&fresh(started,deps.now()),
   'owner_renewal_fresh_complete_signed_history_required');
  if(!feeds.ok)return fail('owner_renewal_fresh_complete_signed_history_required');
  const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:String(a.key_fingerprint)};
  const snapshot=personalAccountSnapshot(identity,feeds,history.requests);
  requireProof('identity' in snapshot&&snapshot.authenticated&&snapshot.complete&&snapshot.cashExact&&!snapshot.unexplainedCashActivity&&
   feeds.cashMicros===String(a.cash_micros),'owner_renewal_signed_history_conflicts_or_cash_changed');
  if(!('identity' in snapshot))return fail('owner_renewal_signed_history_conflicts_or_cash_changed');
  if(reconciled)verifyReconciledReleaseRenewalSnapshot(history as ReconciledReleaseHistory,snapshot);
  else requireProof(snapshot.orders.length===0&&snapshot.fills.length===0&&snapshot.positions.length===0&&snapshot.settlements.length===0,
   'owner_renewal_signed_history_conflicts_or_cash_changed');
  phase="transaction_begin";
  tx=await deps.db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='12000ms'");
  phase="locked_authority";
  const locked=await scope(tx,owner,true,approvalOnly);
  requireProof(digest(locked)===digest(a),'owner_renewal_account_policy_credential_or_worker_changed');
  if(approvalOnly?.mode==='DISABLED_KILLED_APPROVAL_ONLY')await requireKilledConsentBinding(tx,owner,sha,qualification,approvalOnly.consentPin!);
  const current=await readReleaseOwner(tx,owner);
  requireProof(current.ok&&digest(current.account)===digest(initial.account),'owner_renewal_activation_or_policy_changed');
  const lockedAuthority=await priorAuthority(tx,owner,locked,true);
  requireProof(digest(lockedAuthority)===digest(authority),'owner_renewal_prior_authority_changed');
  if(reconciled)requireProof(await reconciledAuthorityProof(tx,owner,locked,lockedAuthority,true)===authorityProof,'owner_renewal_prior_review_or_policy_changed');
  phase="locked_history";
  if(!reconciled)await noFinancialHistory(tx,account);
  const finalHistory=reconciled?await readReconciledReleaseRenewalHistory(tx,account,owner,true):await readNeverPostedReleaseHistory(tx,account,true);
  requireProof(reconciled?(finalHistory as ReconciledReleaseHistory).reconciliationDigest===(history as ReconciledReleaseHistory).reconciliationDigest:
   finalHistory.historyDigest===history.historyDigest,'owner_renewal_history_changed_during_signed_read');
  if(reconciled){
   verifyReconciledReleaseRenewalSnapshot(finalHistory as ReconciledReleaseHistory,snapshot);
   const ledger=new ProductionLedger(deps.db as unknown as Pool,account);
   await ledger.finalAccountProof(tx as unknown as PoolClient,locked as unknown as Account,snapshot,deps.now());
   await ledger.assertConservation(tx as unknown as PoolClient,locked as unknown as Account);
  }
  phase="locked_evidence";
  const currentMaterial=await loadedMaterial(tx,locked);
  requireProof(currentMaterial&&dedicatedSignerFingerprint(currentMaterial.keyId,currentMaterial.privateKey)===locked.key_fingerprint,
   'owner_renewal_restricted_signer_changed');
  const global=await tx.query("SELECT live_execution_enabled,manual_kill_switch,mode FROM public.live_execution_config WHERE id='singleton' FOR SHARE");
  requireProof(global.rows.length===1&&global.rows[0]!.mode==='V13_PRODUCTION'&&
   typeof global.rows[0]!.live_execution_enabled==='boolean'&&typeof global.rows[0]!.manual_kill_switch==='boolean'&&
   global.rows[0]!.live_execution_enabled!==global.rows[0]!.manual_kill_switch,'global_execution_kill_state_inconsistent');
  const stake=Number(initial.account.configured_stake_cents);
  requireProof(Number.isSafeInteger(stake)&&stake>=V13_MIN_ENTRY_STAKE_CENTS&&stake<=2500000&&
   Number.isSafeInteger(Number(initial.account.max_entry_stake_cents))&&stake<=Number(initial.account.max_entry_stake_cents)&&stake<=Number(initial.account.max_entry_all_in_cents)&&
   /^\d+$/.test(String(a.cash_micros))&&BigInt(stake)*10000n<=BigInt(String(a.cash_micros)),
   'approved_stake_or_available_cash_unverified');
  const proof=await currentQualification(tx,qualification,owner,account,sha,true);
  requireProof(digest(proof.rows)===digest(qualified.rows),'owner_renewal_qualification_changed');
  phase="authorization_write";
  const approvals=await tx.query(`SELECT approval_id::text FROM private.strata_owner_sha_approvals WHERE owner_user_id=$1::uuid
   AND execution_account_id=$2 AND release_commit_sha=$3 AND revoked_at IS NULL FOR UPDATE`,[owner,account,sha]);
  requireProof(approvals.rows.length<=1,'duplicate_owner_sha_approval');
  if(approvalOnly?.mode==='DISABLED_KILLED_APPROVAL_ONLY')requireProof(approvals.rows.length===0,'owner_renewal_killed_receipt_already_exists_readback_required');
  requireProof(deps.sha()===sha&&fresh(started,deps.now()),'owner_renewal_final_sha_or_signed_proof_stale');
  let approvalId=String(approvals.rows[0]?.approval_id??'');
  if(!approvalId){const saved=await tx.query(`INSERT INTO private.strata_owner_sha_approvals
   (owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest)
   SELECT $1::uuid,$2,$3,$4::uuid,$5 WHERE clock_timestamp() BETWEEN to_timestamp($6::double precision/1000)
    AND to_timestamp($6::double precision/1000)+interval '15 seconds' RETURNING approval_id::text`,
   [owner,account,sha,qualification,proof.rows[0]!.evidence_digest,started]);
   requireProof(saved.rows.length===1,'owner_renewal_final_signed_proof_stale');approvalId=String(saved.rows[0]!.approval_id);}
  phase="audit_write";
  const record={ownerId:owner,accountId:account,sha,approvalId,qualificationId:qualification,
   approvalMode:approvalOnly?.mode??'ENABLED_STOPPED_RENEWAL',
   ...(approvalOnly?.consentPin?{consentGeneration:approvalOnly.consentPin.consentGeneration}:{}),
   renewalMode:reconciled?'COMMISSIONED_RECONCILED_SETTLED_HISTORY_V1':'COMMISSIONED_PROVEN_NEVER_POSTED_V1',priorAuthority:authority,policyHash:a.policy_hash,
   credentialFingerprint:a.key_fingerprint,historyDigest:history.historyDigest,
   ...(reconciled?{reconciliationDigest:(history as ReconciledReleaseHistory).reconciliationDigest}:{}),neverPosted:history.neverPosted,providerReadAtMs:started};
  await tx.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
   VALUES($1,$2,'OWNER_SHA_RELEASE_AUTHORIZATION',$3::jsonb,$4)`,[randomUUID(),account,JSON.stringify(record),digest(record)]);
  requireProof(deps.sha()===sha&&fresh(started,deps.now()),'owner_renewal_final_sha_or_signed_proof_stale');
  phase="commit";
  await tx.query('COMMIT');committed=true;
  return {ok:true as const,reason:approvalOnly?'owner_sha_approved_account_disabled_worker_stopped':'owner_sha_approved_account_enabled_worker_stopped',sha,approvalId,ordersSubmitted:false as const,...(approvalOnly?.mode==='DISABLED_KILLED_APPROVAL_ONLY'?{
    qualificationId:qualification,consentGeneration:approvalOnly.consentPin!.consentGeneration,
    accountId:account,policyId:a.policy_id,policyHash:a.policy_hash,signerFingerprint:a.key_fingerprint,
    accountExecutionEnabled:false,accountKillOn:true,workerState:'killed',workerKill:true,armRequested:false,
    statusScope:'TRANSACTION_COMMIT',readbackRequired:true}:{} )};
 }catch(e){
  const recognized=e instanceof Error&&/^(owner_renewal_|release_|financial_intent_|fresh_authenticated_|global_execution_|approved_stake_|duplicate_owner_)/.test(e.message);
  if(!recognized)try{logger.warn({ownerRenewalFailure:ownerRenewalFailureDiagnostics(e,phase)},'Owner release renewal failed closed');}catch{/* Diagnostics never change admission. */}
  return {...fail(recognized?(e as Error).message:'owner_renewal_transaction_or_evidence_unavailable'),
   ...(phase==='commit'?{uncertain:true as const}:{})};
 }
 finally{if(tx){if(!committed)try{await tx.query('ROLLBACK');}catch{}tx.release();}}
}

