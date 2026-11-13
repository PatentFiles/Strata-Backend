import {createHash} from 'node:crypto';
import type {JWTVerifyGetKey} from 'jose';
import {verifySupabaseAccessToken} from './supabaseAuth';

export const OWNER_RECOVERY_CONSENT='I request owner-only recovery readiness for this account and release. This does not ARM or START trading.';
type Query={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>};
type Client=Query&{release:(error?:Error)=>void};
type Scope={accountId:string;releaseSha:string;controlSequence:string;expectedFence:string;expectedLeaseEpoch:string;credentialFingerprint:string;policyHash:string;machineEvidenceDigest:string};
/** Disabled/unmounted candidate. Records consent only; cannot recover, ARM or START.
 * Config, challenge creation and live-session verifier MUST be server controlled.
 * proposed tables are not deployed. Never invoke against today's production schema.
 */
export async function recordOwnerRecoveryConsent(input:{token:string;challengeId:string;requestId:string;confirmation:string},deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey;scope:Scope;verifyCurrentSession:(token:string,ownerId:string)=>Promise<boolean>;db:{connect:()=>Promise<Client>}}){
 const result=(status:string,extra:Record<string,unknown>={}):Record<string,unknown>&{status:string}=>({status,consentRecorded:false,recoveryAuthorized:false,tradingAuthorized:false,evidenceIssued:false,independentHumanReview:false,...extra});
 if(deps.enabled!==true)return result('owner_consent_feature_disabled');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if(!uuid.test(input.challengeId)||!uuid.test(input.requestId)||input.confirmation!==OWNER_RECOVERY_CONSENT)return result('explicit_scoped_owner_consent_required');
 const s=deps.scope;
 if(!s||!s.accountId||!/^[a-f0-9]{40}$/.test(s.releaseSha)||!/^\d+$/.test(s.controlSequence)||!/^\d+$/.test(s.expectedFence)||!/^\d+$/.test(s.expectedLeaseEpoch)||!s.credentialFingerprint||!/^[a-f0-9]{64}$/.test(s.policyHash)||!/^[a-f0-9]{64}$/.test(s.machineEvidenceDigest))return result('trusted_scope_configuration_invalid');
 let actor;try{actor=await verifySupabaseAccessToken(input.token,{supabaseUrl:deps.supabaseUrl,keys:deps.keys});if(!await deps.verifyCurrentSession(input.token,actor.subject))return result('current_owner_session_required');}catch{return result('current_owner_session_required');}
 const consentDigest=createHash('sha256').update(OWNER_RECOVERY_CONSENT).digest('hex');
 let tx:Client;try{tx=await deps.db.connect();}catch{return result('consent_store_unavailable');}
 let commitAttempted=false,discard:Error|undefined;
 try{
  await tx.query('BEGIN');
  await tx.query("SET LOCAL statement_timeout='3000ms'");
  await tx.query("SET LOCAL lock_timeout='1000ms'");
  // Account-first lock matches proposed admission/revocation serialization.
  const account=await tx.query('SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[s.accountId,actor.subject]);
  if(account.rows.length!==1)throw Error('owner_account_scope_refused');
  const head=await tx.query('SELECT sequence::text FROM private.strata_owner_control_heads WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[s.accountId,actor.subject]);
  if(head.rows.length!==1||head.rows[0].sequence!==s.controlSequence)throw Error('owner_consent_superseded');
  const lease=await tx.query('SELECT fencing_token::text,consent_epoch::text FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR SHARE',[s.accountId,actor.subject]);
  if(lease.rows.length!==1||lease.rows[0].fencing_token!==s.expectedFence||lease.rows[0].consent_epoch!==s.expectedLeaseEpoch)throw Error('owner_consent_worker_fence_changed');
  const existing=await tx.query('SELECT challenge_id::text,consent_digest FROM private.strata_owner_recovery_consent_receipt WHERE owner_id=$1::uuid AND account_id=$2 AND request_id=$3::uuid',[actor.subject,s.accountId,input.requestId]);
  if(existing.rows.length){
   if(existing.rows.length!==1||existing.rows[0].challenge_id!==input.challengeId||existing.rows[0].consent_digest!==consentDigest)throw Error('owner_request_reused');
   await tx.query('ROLLBACK');
   return result('historical_consent_readback',{historicalConsentRecorded:true,retryAuthorized:false});
  }
  const consumed=await tx.query(`UPDATE private.strata_owner_recovery_consent_challenge
   SET consumed_request_id=$3::uuid,consumed_at=clock_timestamp()
   WHERE id=$1::uuid AND owner_id=$2::uuid AND account_id=$4 AND release_sha=$5
    AND control_sequence=$6::bigint AND credential_fingerprint=$7 AND policy_hash=$8
    AND machine_evidence_digest=$9 AND consent_digest=$10 AND worker_fence=$11::bigint AND lease_consent_epoch=$12::bigint AND action='OWNER_RECOVERY'
    AND consumed_request_id IS NULL AND revoked_at IS NULL
    AND issued_at<=clock_timestamp() AND expires_at>clock_timestamp()
   RETURNING id::text`,[input.challengeId,actor.subject,input.requestId,s.accountId,s.releaseSha,s.controlSequence,s.credentialFingerprint,s.policyHash,s.machineEvidenceDigest,consentDigest,s.expectedFence,s.expectedLeaseEpoch]);
  if(consumed.rows.length!==1)throw Error('owner_challenge_not_consumable');
  await tx.query(`INSERT INTO private.strata_owner_recovery_consent_receipt
   (request_id,challenge_id,owner_id,account_id,consent_digest) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)`,[input.requestId,input.challengeId,actor.subject,s.accountId,consentDigest]);
  // Session check again after waiting for locks; no bearer token is persisted.
  if(!await deps.verifyCurrentSession(input.token,actor.subject))throw Error('current_owner_session_required');
  const fresh=await tx.query('SELECT id FROM private.strata_owner_recovery_consent_challenge WHERE id=$1::uuid AND expires_at>clock_timestamp() AND revoked_at IS NULL',[input.challengeId]);
  if(fresh.rows.length!==1)throw Error('owner_challenge_expired_before_commit');
  commitAttempted=true;await tx.query('COMMIT');
  return result('owner_consent_recorded',{consentRecorded:true,requestId:input.requestId});
 }catch(error){
  if(commitAttempted)discard=Error('owner_consent_commit_unknown');
  try{await tx.query('ROLLBACK');}catch{discard=Error('owner_consent_rollback_failed');}
  if(commitAttempted)return result('owner_consent_outcome_unknown',{consentRecorded:null,readbackRequired:true,retryAuthorized:false});
  const reason=error instanceof Error&&['owner_account_scope_refused','owner_consent_superseded','owner_consent_worker_fence_changed','owner_request_reused','owner_challenge_not_consumable','current_owner_session_required','owner_challenge_expired_before_commit'].includes(error.message)?error.message:'owner_consent_not_recorded';
  return result(reason);
 }finally{tx.release(discard);}
}
