import {randomUUID,createHash} from 'node:crypto';
import type {JWTVerifyGetKey} from 'jose';
import {verifySupabaseAccessToken} from './supabaseAuth';
import {deployedGitSha} from './deployedGitSha';
import {OWNER_RECOVERY_CONSENT} from './ownerConsentCandidate';
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;release:(error?:Error)=>void};
/** Server-only disabled candidate. Creates a consent REQUEST, not trusted build
 * evidence. machineEvidenceDigest is a server-selected binding and NOT validation
 * of that evidence. No recovery, ARM, START, issuer or reviewer authority exists.
 */
export async function createOwnerConsentChallenge(input:{token:string;accountId:string},deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey;machineEvidenceDigest:string;machineValidUntil:number;verifyCurrentSession:(token:string,ownerId:string)=>Promise<boolean>;db:{connect:()=>Promise<Client>}}){
 const out=(status:string,extra:Record<string,unknown>={}):Record<string,unknown>&{status:string}=>({status,challengeCreated:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false,independentHumanReview:false,...extra});
 if(deps.enabled!==true)return out('owner_consent_feature_disabled');
 if(!Number.isSafeInteger(deps.machineValidUntil)||deps.machineValidUntil<=Date.now())return out('machine_evidence_expired');
 if(typeof input.accountId!=='string'||!input.accountId||input.accountId.length>200||!/^[a-f0-9]{64}$/.test(deps.machineEvidenceDigest))return out('consent_challenge_scope_invalid');
 const releaseSha=deployedGitSha();if(!/^[a-f0-9]{40}$/.test(releaseSha))return out('runtime_release_unavailable');
 let actor;try{actor=await verifySupabaseAccessToken(input.token,{supabaseUrl:deps.supabaseUrl,keys:deps.keys});if(!await deps.verifyCurrentSession(input.token,actor.subject))return out('current_owner_session_required');}catch{return out('current_owner_session_required');}
 let tx:Client;try{tx=await deps.db.connect();}catch{return out('consent_store_unavailable');}
 const challengeId=randomUUID(),digest=createHash('sha256').update(OWNER_RECOVERY_CONSENT).digest('hex');
 let commitAttempted=false,discard:Error|undefined;
 try{
  await tx.query('BEGIN');await tx.query("SET LOCAL statement_timeout='3000ms'");await tx.query("SET LOCAL lock_timeout='1000ms'");
  const accounts=await tx.query('SELECT id,key_fingerprint,policy_id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[input.accountId,actor.subject]);
  if(accounts.rows.length!==1)throw Error('owner_account_scope_refused');
  const a=accounts.rows[0];if(typeof a.key_fingerprint!=='string'||!a.key_fingerprint)throw Error('credential_scope_unavailable');
  const heads=await tx.query('SELECT sequence::text FROM private.strata_owner_control_heads WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[input.accountId,actor.subject]);
  if(heads.rows.length!==1||!/^\d+$/.test(heads.rows[0].sequence))throw Error('control_scope_unavailable');
  const leases=await tx.query('SELECT fencing_token::text,consent_epoch::text FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR SHARE',[input.accountId,actor.subject]);
  if(leases.rows.length!==1||!/^\d+$/.test(leases.rows[0].fencing_token)||!/^\d+$/.test(leases.rows[0].consent_epoch))throw Error('worker_fence_unavailable');
  const expectedFence=leases.rows[0].fencing_token,expectedLeaseEpoch=leases.rows[0].consent_epoch;
  const policies=await tx.query("SELECT policy_hash FROM public.v13_live_money_policy WHERE id=$1 AND execution_account_id=$2 AND created_by=$3 AND state='APPROVED' FOR SHARE",[a.policy_id,input.accountId,actor.subject]);
  if(policies.rows.length!==1||!/^[a-f0-9]{64}$/.test(policies.rows[0].policy_hash))throw Error('approved_policy_scope_unavailable');
  // Repeated page loads reuse the exact active scope, not unlimited challenges.
  const prior=await tx.query(`SELECT id::text,expires_at FROM private.strata_owner_recovery_consent_challenge
   WHERE owner_id=$1::uuid AND account_id=$2 AND release_sha=$3 AND control_sequence=$4::bigint
   AND credential_fingerprint=$5 AND policy_hash=$6 AND machine_evidence_digest=$7 AND consent_digest=$8
   AND worker_fence=$9::bigint AND lease_consent_epoch=$10::bigint AND action='OWNER_RECOVERY' AND consumed_request_id IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()
   ORDER BY issued_at DESC LIMIT 2`,[actor.subject,input.accountId,releaseSha,heads.rows[0].sequence,a.key_fingerprint,policies.rows[0].policy_hash,deps.machineEvidenceDigest,digest,expectedFence,expectedLeaseEpoch]);
  if(prior.rows.length>1)throw Error('ambiguous_consent_challenges');
  let selected=prior.rows[0];if(selected&&new Date(selected.expires_at).getTime()>deps.machineValidUntil)throw Error('machine_evidence_validity_changed');
  if(!selected){const inserted=await tx.query(`INSERT INTO private.strata_owner_recovery_consent_challenge
   (id,owner_id,account_id,action,release_sha,control_sequence,credential_fingerprint,policy_hash,machine_evidence_digest,consent_digest,expires_at,worker_fence,lease_consent_epoch)
   VALUES($1::uuid,$2::uuid,$3,'OWNER_RECOVERY',$4,$5::bigint,$6,$7,$8,$9,LEAST(clock_timestamp()+interval '4 minutes',to_timestamp($10::double precision/1000)),$11::bigint,$12::bigint) RETURNING id::text,expires_at`,[challengeId,actor.subject,input.accountId,releaseSha,heads.rows[0].sequence,a.key_fingerprint,policies.rows[0].policy_hash,deps.machineEvidenceDigest,digest,deps.machineValidUntil,expectedFence,expectedLeaseEpoch]);if(inserted.rows.length!==1)throw Error('consent_challenge_insert_failed');selected=inserted.rows[0];}
  if(!await deps.verifyCurrentSession(input.token,actor.subject))throw Error('current_owner_session_required');
  if(deps.machineValidUntil<=Date.now())throw Error('machine_evidence_expired');
  if(deployedGitSha()!==releaseSha)throw Error('runtime_release_changed');
  const fresh=await tx.query('SELECT id FROM private.strata_owner_recovery_consent_challenge WHERE id=$1::uuid AND expires_at>clock_timestamp() AND revoked_at IS NULL AND consumed_request_id IS NULL',[selected.id]);if(fresh.rows.length!==1)throw Error('consent_challenge_expired');
  commitAttempted=true;await tx.query('COMMIT');
  return out('owner_consent_challenge_ready',{challengeCreated:true,challengeId:selected.id,expiresAt:selected.expires_at,confirmation:OWNER_RECOVERY_CONSENT,scope:{accountId:input.accountId,releaseSha,controlSequence:heads.rows[0].sequence,expectedFence,expectedLeaseEpoch,credentialFingerprint:a.key_fingerprint,policyHash:policies.rows[0].policy_hash,machineEvidenceDigest:deps.machineEvidenceDigest}});
 }catch(e){
  if(commitAttempted)discard=Error('owner_challenge_commit_unknown');try{await tx.query('ROLLBACK');}catch{discard=Error('owner_challenge_rollback_failed');}
  if(commitAttempted)return out('owner_challenge_outcome_unknown',{challengeCreated:null,readbackRequired:true,retryAuthorized:false});
  const allowed=['owner_account_scope_refused','credential_scope_unavailable','control_scope_unavailable','worker_fence_unavailable','approved_policy_scope_unavailable','ambiguous_consent_challenges','consent_challenge_insert_failed','current_owner_session_required','runtime_release_changed','consent_challenge_expired','machine_evidence_expired','machine_evidence_validity_changed'];
  return out(e instanceof Error&&allowed.includes(e.message)?e.message:'consent_challenge_not_created');
 }finally{tx.release(discard);}
}
