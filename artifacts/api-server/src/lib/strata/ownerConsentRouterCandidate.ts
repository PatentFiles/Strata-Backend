import {Router,json} from 'express';
import type {JWTVerifyGetKey} from 'jose';
import {deployedGitSha} from './deployedGitSha';
import {verifySupabaseAccessToken} from './supabaseAuth';
import {createOwnerConsentChallenge} from './ownerConsentChallengeCandidate';
import {recordOwnerRecoveryConsent} from './ownerConsentCandidate';
import {createCurrentOwnerSessionVerifier} from './ownerCurrentSessionCandidate';
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;release:(error?:Error)=>void};
/** UNMOUNTED opt-in candidate. Only consent endpoints; no recovery/ARM/START.
 * db and sessionDb must be separately bounded pools. sessionDb needs audited
 * read-only auth-session visibility; do not grant service-role tokens to browser.
 */
export function createOwnerConsentRouter(deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey;machineEvidenceDigest:string;machineValidUntil:number;db:{connect:()=>Promise<Client>};sessionDb:{connect:()=>Promise<Client>}}){
 const router=Router();
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');if(deps.enabled!==true){res.status(503).json({status:'owner_consent_feature_disabled',recoveryAuthorized:false,tradingAuthorized:false});return;}next();});
 router.use(json({limit:'8kb',strict:true}));
 const verifyCurrentSession=createCurrentOwnerSessionVerifier({...deps,db:deps.sessionDb});
 const common={...deps,verifyCurrentSession};
 const bearer=(authorization:unknown)=>typeof authorization==='string'?/^Bearer (\S+)$/i.exec(authorization)?.[1]:undefined;
 router.post('/consent-challenge',async(req,res)=>{
  const token=bearer(req.headers.authorization);if(!token){res.status(401).json({status:'authenticated_owner_required'});return;}
  if(typeof req.body?.accountId!=='string'||Object.keys(req.body).some(k=>k!=='accountId')){res.status(400).json({status:'account_id_only_required'});return;}
  try{const result=await createOwnerConsentChallenge({token,accountId:req.body.accountId},common);res.status(result.status==='owner_consent_challenge_ready'?201:result.readbackRequired?409:403).json(result);}catch{res.status(503).json({status:'consent_service_unavailable',recoveryAuthorized:false,tradingAuthorized:false});}
 });
 router.post('/consent',async(req,res)=>{
  const token=bearer(req.headers.authorization);if(!token){res.status(401).json({status:'authenticated_owner_required'});return;}
  const {challengeId,requestId,confirmation}=req.body??{};
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(typeof challengeId!=='string'||!uuid.test(challengeId)||typeof requestId!=='string'||!uuid.test(requestId)||typeof confirmation!=='string'||Object.keys(req.body).some(k=>!['challengeId','requestId','confirmation'].includes(k))){res.status(400).json({status:'exact_consent_request_required'});return;}
  let tx:Client|undefined;
  try{
   const actor=await verifySupabaseAccessToken(token,deps);
   if(!await verifyCurrentSession(token,actor.subject)){res.status(401).json({status:'current_owner_session_required'});return;}
   // Immutable challenge scope loaded by authenticated owner. No HTTP-supplied
   // release/credential/policy/machine digest is forwarded to the recorder.
   tx=await deps.db.connect();await tx.query('BEGIN READ ONLY');await tx.query("SET LOCAL statement_timeout='1000ms'");
   const r=await tx.query(`SELECT account_id,release_sha,control_sequence::text,worker_fence::text,lease_consent_epoch::text,credential_fingerprint,policy_hash,machine_evidence_digest
    FROM private.strata_owner_recovery_consent_challenge WHERE id=$1::uuid AND owner_id=$2::uuid LIMIT 2`,[challengeId,actor.subject]);
   await tx.query('ROLLBACK');tx.release();tx=undefined;
   if(r.rows.length!==1){res.status(403).json({status:'owner_challenge_unavailable'});return;}
   const row=r.rows[0];
   if(row.machine_evidence_digest!==deps.machineEvidenceDigest||row.release_sha!==deployedGitSha()||!Number.isSafeInteger(deps.machineValidUntil)||deps.machineValidUntil<=Date.now()){res.status(409).json({status:'machine_consent_binding_changed',recoveryAuthorized:false,tradingAuthorized:false});return;}
   const result=await recordOwnerRecoveryConsent({token,challengeId,requestId,confirmation},{...common,scope:{accountId:row.account_id,releaseSha:row.release_sha,controlSequence:row.control_sequence,expectedFence:row.worker_fence,expectedLeaseEpoch:row.lease_consent_epoch,credentialFingerprint:row.credential_fingerprint,policyHash:row.policy_hash,machineEvidenceDigest:row.machine_evidence_digest}});
   res.status(['owner_consent_recorded','historical_consent_readback'].includes(result.status)?200:result.readbackRequired?409:403).json(result);
  }catch{res.status(503).json({status:'consent_service_unavailable',recoveryAuthorized:false,tradingAuthorized:false});}
  finally{if(tx){try{await tx.query('ROLLBACK');tx.release();}catch{tx.release(Error('consent_read_cleanup_failed'));}}}
 });
 return router;
}
