import {jwtVerify,type JWTVerifyGetKey} from 'jose';
import {supabaseIssuer} from './supabaseAuth';
import {createHash} from 'node:crypto';
import {OWNER_RECOVERY_CONSENT} from './ownerConsentCandidate';
type Tx={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>};
type Scope={accountId:string;ownerId:string;requestId:string;releaseSha:string;controlSequence:string;fence:string;epoch:string;credentialFingerprint:string;policyHash:string;machineEvidenceDigest:string};
/** Unmounted transaction-bound consent guard, NOT an issuer or release authority.
 * Intended inside the existing account-locked reconciliation transaction.
 * Production privileges/lifecycle and complete writer protocol remain unqualified.
 */
export async function createHeldOwnerConsentGuard(token:string,scope:Scope,deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey}){
 if(!deps.enabled)throw Error('held_owner_consent_disabled');
 const s=Object.freeze({...scope});
 let timer:ReturnType<typeof setTimeout>|undefined;
 let verified;
 try{verified=await Promise.race([jwtVerify(token,deps.keys,{issuer:supabaseIssuer(deps.supabaseUrl),audience:'authenticated',requiredClaims:['exp','sub','session_id']}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('held_owner_jwt_timeout')),1000);})]);}finally{if(timer)clearTimeout(timer);}
 const {payload}=verified;
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 if(payload.sub!==s.ownerId||!uuid.test(s.ownerId)||payload.aal!=='aal2'||typeof payload.session_id!=='string'||!uuid.test(payload.session_id)||!Number.isSafeInteger(payload.exp))throw Error('held_current_owner_required');
 const sessionId=payload.session_id,expires=payload.exp!;
 const consentDigest=createHash('sha256').update(OWNER_RECOVERY_CONSENT).digest('hex');
 let lockedTx:Tx|undefined;
 const check=async(tx:Tx)=>{
  const r=await tx.query(`SELECT c.id FROM private.strata_owner_recovery_consent_receipt r
   JOIN private.strata_owner_recovery_consent_challenge c ON c.id=r.challenge_id
   JOIN auth.sessions se ON se.id=$12::uuid AND se.user_id=$2::uuid
   JOIN auth.users u ON u.id=se.user_id
   WHERE r.request_id=$1::uuid AND r.owner_id=$2::uuid AND r.account_id=$3
    AND r.consent_digest=$4 AND c.consent_digest=$4 AND c.owner_id=r.owner_id AND c.account_id=r.account_id
    AND c.consumed_request_id=r.request_id AND c.consumed_at IS NOT NULL AND c.action='OWNER_RECOVERY'
    AND c.release_sha=$5 AND c.control_sequence=$6::bigint AND c.worker_fence=$7::bigint
    AND c.lease_consent_epoch=$8::bigint AND c.credential_fingerprint=$9 AND c.policy_hash=$10 AND c.machine_evidence_digest=$11
    AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
    AND (se.not_after IS NULL OR se.not_after>clock_timestamp()) AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) AND to_timestamp($13)>clock_timestamp()
   FOR SHARE OF r,c,se,u`,[s.requestId,s.ownerId,s.accountId,consentDigest,s.releaseSha,s.controlSequence,s.fence,s.epoch,s.credentialFingerprint,s.policyHash,s.machineEvidenceDigest,sessionId,expires]);
  if(r.rows.length!==1)throw Error('held_owner_consent_invalid');
 };
 return {
  async lock(tx:Tx,a:{id:string;owner_user_id:string}){
   if(lockedTx||a.id!==s.accountId||a.owner_user_id!==s.ownerId)throw Error('held_owner_scope_invalid');
   const h=await tx.query('SELECT sequence::text FROM private.strata_owner_control_heads WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR SHARE',[s.accountId,s.ownerId]);
   const l=await tx.query('SELECT fencing_token::text,consent_epoch::text,state,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR SHARE',[s.accountId,s.ownerId]);
   if(h.rows.length!==1||h.rows[0].sequence!==s.controlSequence||l.rows.length!==1||l.rows[0].fencing_token!==s.fence||l.rows[0].consent_epoch!==s.epoch||!['released','killed'].includes(l.rows[0].state)||l.rows[0].arm_requested!==false)throw Error('held_owner_control_changed');
   await check(tx);lockedTx=tx;
  },
  async beforeCommit(tx:Tx){if(tx!==lockedTx)throw Error('held_owner_transaction_changed');await check(tx);},
  recoveryAuthorized:false as const,tradingAuthorized:false as const
 };
}
