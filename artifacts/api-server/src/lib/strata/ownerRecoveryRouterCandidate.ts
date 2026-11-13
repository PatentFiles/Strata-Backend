import {Router,json} from 'express';
import type {JWTVerifyGetKey} from 'jose';
import {verifySupabaseAccessToken} from './supabaseAuth';
import {createCurrentOwnerSessionVerifier} from './ownerCurrentSessionCandidate';
import {createHeldOwnerConsentGuard} from './ownerHeldConsentGuardCandidate';
import {readOwnerRecoveryOutcome} from './ownerRecoveryReadbackCandidate';
import {deployedGitSha} from './deployedGitSha';
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;release:(error?:Error)=>void};
/** UNMOUNTED. Inspection/readback only: no recovery release, issuer, ARM or START.
 * POST inspect validates confirmed owner consent under actual account/control/
 * session locks and always rolls back. It cannot clear a live-account blocker.
 */
export function createOwnerRecoveryRouter(deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey;db:{connect:()=>Promise<Client>};sessionDb:{connect:()=>Promise<Client>}}){
 const router=Router(),verifyCurrentSession=createCurrentOwnerSessionVerifier({...deps,db:deps.sessionDb});
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');if(!deps.enabled){res.status(503).json({status:'owner_recovery_disabled',recoveryAuthorized:false,tradingAuthorized:false});return;}next();});
 router.use(json({limit:'8kb',strict:true}));
 const input=(req:any)=>{const token=/^Bearer (\S+)$/i.exec(req.headers.authorization??'')?.[1],{accountId,requestId}=req.body??{};const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;return token&&typeof accountId==='string'&&accountId.length>0&&accountId.length<200&&typeof requestId==='string'&&uuid.test(requestId)&&Object.keys(req.body).every(k=>['accountId','requestId'].includes(k))?{token,accountId,requestId}:null;};
 router.post('/outcome',async(req,res)=>{const i=input(req);if(!i){res.status(400).json({status:'exact_owner_request_required'});return;}try{const r=await readOwnerRecoveryOutcome(i,{...deps,verifyCurrentSession});res.status(r.historicalReleaseRecorded?200:409).json(r);}catch{res.status(503).json({status:'readback_unavailable',tradingAuthorized:false});}});
 router.post('/inspect-consent-lock',async(req,res)=>{
  const i=input(req);if(!i){res.status(400).json({status:'exact_owner_request_required'});return;}
  let actor;try{actor=await verifySupabaseAccessToken(i.token,deps);if(!await verifyCurrentSession(i.token,actor.subject))throw Error('session');}catch{res.status(401).json({status:'current_owner_session_required'});return;}
  let tx:Client|undefined,discard:Error|undefined;
  try{
   tx=await deps.db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='500ms'");await tx.query("SET LOCAL statement_timeout='1500ms'");
   const a=await tx.query('SELECT id,owner_user_id,execution_enabled FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[i.accountId,actor.subject]);
   if(a.rows.length!==1||a.rows[0].execution_enabled!==false)throw Error('owner_stopped_account_required');
   const c=await tx.query(`SELECT c.release_sha,c.control_sequence::text,c.worker_fence::text,c.lease_consent_epoch::text,c.credential_fingerprint,c.policy_hash,c.machine_evidence_digest
    FROM private.strata_owner_recovery_consent_receipt r JOIN private.strata_owner_recovery_consent_challenge c ON c.id=r.challenge_id
    WHERE r.request_id=$1::uuid AND r.owner_id=$2::uuid AND r.account_id=$3 LIMIT 2`,[i.requestId,actor.subject,i.accountId]);
   if(c.rows.length!==1||c.rows[0].release_sha!==deployedGitSha())throw Error('confirmed_current_release_consent_required');
   const s=c.rows[0],g=await createHeldOwnerConsentGuard(i.token,{accountId:i.accountId,ownerId:actor.subject,requestId:i.requestId,releaseSha:s.release_sha,controlSequence:s.control_sequence,fence:s.worker_fence,epoch:s.lease_consent_epoch,credentialFingerprint:s.credential_fingerprint,policyHash:s.policy_hash,machineEvidenceDigest:s.machine_evidence_digest},deps);
   await g.lock(tx,a.rows[0]);await g.beforeCommit(tx);await tx.query('ROLLBACK');
   res.status(409).json({status:'owner_consent_lock_verified_release_unavailable',consentLockVerified:true,recoveryAuthorized:false,tradingAuthorized:false,stateChanged:false,blockers:['protected_release_assurance_issuer_not_configured','actual_writer_barrier_unqualified','current_production_evidence_unverified']});
  }catch{discard=Error('owner_recovery_inspection_failed');if(tx)try{await tx.query('ROLLBACK');}catch{}res.status(409).json({status:'owner_recovery_inspection_refused',consentLockVerified:false,recoveryAuthorized:false,tradingAuthorized:false,stateChanged:false});}
  finally{tx?.release(discard);}
 });
 return router;
}
