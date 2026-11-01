import {logger} from '../logger';
import {ownerRenewalFailureDiagnostics} from './ownerRenewalFailureDiagnostics';
import {randomUUID} from 'node:crypto';
import {readReleaseOwner,loadedMaterial} from './inAppProtectiveRelease';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import {dedicatedSignerFingerprint} from './commissioning';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {digest,type Identity} from '../v13-production/types';
import {V13_MIN_ENTRY_STAKE_CENTS} from '../v13LiveMoneyRisk';
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
async function scope(db:Query,owner:string,lock=false){
 const r=await db.query(SCOPE+(lock?' FOR UPDATE OF a,w FOR SHARE OF p,c,fa,pc':''),[owner]);
 requireProof(r.rows.length===1,'owner_renewal_account_credential_scope_unverified');const a=r.rows[0]!;
 requireProof(a.commissioned===true&&a.execution_enabled===true&&a.cash_precision_verified===true&&a.blocked_reason===null&&
  String(a.reserved_micros)==='0','owner_renewal_commissioned_unfrozen_flat_account_required');
 requireProof(a.worker_state==='released'&&a.arm_requested===false&&a.worker_kill===false,
  'owner_renewal_worker_must_be_released_and_disarmed');return a;
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
/** Narrow owner-consent renewal for a previously authorized commissioned account
 * whose entire retained order history is proven never posted. No account/worker,
 * fee, standing-grant or reviewer authority is changed. Filled histories remain
 * unsupported here, rather than being treated as empty or erased. */
export async function authorizeNeverPostedReleaseRenewal(owner:string,qualification:string,sha:string,
 deps:{db:Db;now:()=>number;sha:()=>string;readFeeds:typeof readOwnedKalshiFeeds}){
 let tx:Client|null=null,committed=false;let phase="preflight_authority";
 try{
  const initial=await readReleaseOwner(deps.db,owner);requireProof(initial.ok,'owner_renewal_activation_unverified');
  if(!initial.ok)return fail(initial.reason);
  const a=await scope(deps.db,owner),account=String(a.id);
  const authority=await priorAuthority(deps.db,owner,a);
  const qualified=await currentQualification(deps.db,qualification,owner,account,sha);
  phase="preflight_history";
  await noFinancialHistory(deps.db,account);
  const history=await readNeverPostedReleaseHistory(deps.db,account);
  requireProof(history.rows.length>0&&history.neverPosted.length===history.rows.length&&history.expectedRequests.length===0,
   'owner_renewal_only_proven_never_posted_history_supported');
  requireProof(history.rows.every(i=>i.policy_hash===a.policy_hash),'owner_renewal_history_policy_changed');
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
   snapshot.orders.length===0&&snapshot.fills.length===0&&snapshot.positions.length===0&&snapshot.settlements.length===0&&
   feeds.cashMicros===String(a.cash_micros),'owner_renewal_signed_history_conflicts_or_cash_changed');
  phase="transaction_begin";
  tx=await deps.db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='12000ms'");
  phase="locked_authority";
  const locked=await scope(tx,owner,true);
  requireProof(digest(locked)===digest(a),'owner_renewal_account_policy_credential_or_worker_changed');
  const current=await readReleaseOwner(tx,owner);
  requireProof(current.ok&&digest(current.account)===digest(initial.account),'owner_renewal_activation_or_policy_changed');
  const lockedAuthority=await priorAuthority(tx,owner,locked,true);
  requireProof(digest(lockedAuthority)===digest(authority),'owner_renewal_prior_authority_changed');
  phase="locked_history";
  await noFinancialHistory(tx,account);
  const finalHistory=await readNeverPostedReleaseHistory(tx,account,true);
  requireProof(finalHistory.historyDigest===history.historyDigest,'owner_renewal_history_changed_during_signed_read');
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
   renewalMode:'COMMISSIONED_PROVEN_NEVER_POSTED_V1',priorAuthority:authority,policyHash:a.policy_hash,
   credentialFingerprint:a.key_fingerprint,historyDigest:history.historyDigest,neverPosted:history.neverPosted,providerReadAtMs:started};
  await tx.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
   VALUES($1,$2,'OWNER_SHA_RELEASE_AUTHORIZATION',$3::jsonb,$4)`,[randomUUID(),account,JSON.stringify(record),digest(record)]);
  requireProof(deps.sha()===sha&&fresh(started,deps.now()),'owner_renewal_final_sha_or_signed_proof_stale');
  phase="commit";
  await tx.query('COMMIT');committed=true;
  return {ok:true as const,reason:'owner_sha_approved_account_enabled_worker_stopped',sha,approvalId,ordersSubmitted:false as const};
 }catch(e){
  const recognized=e instanceof Error&&/^(owner_renewal_|release_|financial_intent_|fresh_authenticated_|global_execution_|approved_stake_|duplicate_owner_)/.test(e.message);
  if(!recognized)try{logger.warn({ownerRenewalFailure:ownerRenewalFailureDiagnostics(e,phase)},'Owner release renewal failed closed');}catch{/* Diagnostics never change admission. */}
  return fail(recognized?(e as Error).message:'owner_renewal_transaction_or_evidence_unavailable');
 }
 finally{if(tx){if(!committed)try{await tx.query('ROLLBACK');}catch{}tx.release();}}
}
