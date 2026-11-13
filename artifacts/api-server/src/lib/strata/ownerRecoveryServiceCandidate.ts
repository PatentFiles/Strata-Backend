import type {Pool,PoolClient} from '@workspace/db';
import {verifySupabaseAccessToken} from './supabaseAuth';
import {createCurrentOwnerSessionVerifier} from './ownerCurrentSessionCandidate';
import {createHeldOwnerConsentGuard} from './ownerHeldConsentGuardCandidate';
import {deployedGitSha} from './deployedGitSha';
import {recoverOwnerAtomicallyCandidate,type ProductionRecoveryDependencies,type OwnerRecoveryScope} from './ownerAtomicRecoveryCandidate';
export type IssuerScope={accountId:string;ownerId:string;requestId:string;revision:string;controlSequence:string;workerFence:string;consentEpoch:string;credentialFingerprint:string;policyHash:string};
export type ProtectedIssuerStage=(scope:IssuerScope,tx:PoolClient,signal:AbortSignal)=>Promise<{staged:boolean;committed:false;validUntil?:number;reason?:string}>;
export type OwnerRecoveryServiceDependencies={release:ProductionRecoveryDependencies;issuerDb:Pool;sessionDb:Pool;stageScopedAuthority:ProtectedIssuerStage};
/** One owner request, separate real issuer and consumer roles. The issuer callback
 * must be the protected verifier-backed implementation, not a consent signer.
 * No automatic retry after either transaction's uncertain COMMIT. */
export async function issueAndRecoverOwner(input:unknown,deps?:OwnerRecoveryServiceDependencies){
 const deny=(status:string)=>({status,released:false as boolean|null,tradingAuthorized:false,armed:false,retryAuthorized:false});
 if(!deps||deps.issuerDb===deps.release.db||deps.issuerDb===deps.sessionDb||typeof deps.stageScopedAuthority!=='function')return deny('protected_recovery_issuer_unconfigured');
 const i=input as Record<string,unknown>;
 if(!i||typeof i!=='object'||Array.isArray(i)||Object.keys(i).length!==3||Object.keys(i).some(k=>!['token','accountId','requestId'].includes(k))||typeof i.token!=='string'||typeof i.accountId!=='string'||!i.accountId||i.accountId.length>200||typeof i.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(i.requestId))return deny('exact_owner_request_required');
 const current=createCurrentOwnerSessionVerifier({...deps.release,enabled:true,db:deps.sessionDb});
 let ownerId:string;try{ownerId=(await verifySupabaseAccessToken(i.token,deps.release)).subject;if(!await current(i.token,ownerId))throw Error('session');}catch{return deny('current_owner_session_required');}
 let tx:PoolClient|undefined,commitAttempted=false,discard:Error|undefined;
 try{
  tx=await deps.issuerDb.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='500ms'");await tx.query("SET LOCAL statement_timeout='1500ms'");
  const r=await tx.query(`SELECT a.id,a.owner_user_id::text,a.revision::text,a.execution_enabled,a.kill_switch,
   c.release_sha,c.control_sequence::text,c.worker_fence::text,c.lease_consent_epoch::text,c.credential_fingerprint,c.policy_hash,c.machine_evidence_digest
   FROM public.v13_production_account a JOIN private.strata_owner_recovery_consent_receipt r ON r.account_id=a.id AND r.owner_id=a.owner_user_id
   JOIN private.strata_owner_recovery_consent_challenge c ON c.id=r.challenge_id
   WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND r.request_id=$3::uuid FOR UPDATE OF a`,[i.accountId,ownerId,i.requestId]);
  if(r.rows.length!==1)throw Error('owner_scope_missing');const c=r.rows[0];
  if(c.execution_enabled!==false||c.kill_switch!==true||c.release_sha!==deployedGitSha())throw Error('stopped_current_release_required');
  const scope:OwnerRecoveryScope={accountId:i.accountId,ownerId,requestId:i.requestId,revision:c.revision,releaseSha:c.release_sha,controlSequence:c.control_sequence,fence:c.worker_fence,epoch:c.lease_consent_epoch,credentialFingerprint:c.credential_fingerprint,policyHash:c.policy_hash,machineEvidenceDigest:c.machine_evidence_digest,expectedBlockedReason:'personal_exchange_history_unreconciled'};
  const guard=await createHeldOwnerConsentGuard(i.token,scope,{...deps.release,enabled:true});await guard.lock(tx,{id:c.id,owner_user_id:c.owner_user_id});
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const work=deps.stageScopedAuthority({accountId:scope.accountId,ownerId,requestId:scope.requestId,revision:scope.revision,controlSequence:scope.controlSequence,workerFence:scope.fence,consentEpoch:scope.epoch,credentialFingerprint:scope.credentialFingerprint,policyHash:scope.policyHash},tx,controller.signal);
  let staged:Awaited<ReturnType<ProtectedIssuerStage>>;
  try{staged=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('issuer_deadline'));},4500);})]);}
  catch(e){discard=Error('issuer_stage_unavailable');throw e;}finally{if(timer)clearTimeout(timer);}
  if(staged.staged!==true||staged.committed!==false||!Number.isSafeInteger(staged.validUntil)||(staged.validUntil??0)<=Date.now())throw Error('protected_issuance_not_staged');
  await guard.beforeCommit(tx);
  if((staged.validUntil??0)<=Date.now())throw Error('protected_issuance_expired');
  commitAttempted=true;await tx.query('COMMIT');
 }catch{
  if(commitAttempted)discard=Error('issuer_commit_outcome_unknown');
  if(tx&&!discard)try{await tx.query('ROLLBACK');}catch{discard=Error('issuer_rollback_unknown');}
  if(commitAttempted)return {...deny('issuer_outcome_unknown'),released:null,readbackRequired:true};
  return deny('protected_issuance_not_committed');
 }finally{tx?.release(discard);}
 // Only acknowledged issuance proceeds. Consumer rechecks owner/session/scope,
 // real provider evidence, actual writer qualification and unexpired authority.
 return recoverOwnerAtomicallyCandidate(input,deps.release);
}
