'use strict';
const {verifyScopedReleaseAssurance}=require('./verify-runtime-witness.cjs');
/** Server-only transaction stage. Caller owns BEGIN/COMMIT, current owner-session
 * verification, account barrier and post-commit readback. Never expose deps or
 * config to HTTP bodies. Does not clear a freeze or ARM/START. */
function createScopedAuthorityIssuer(config,{loadQualification,signScoped,transport},clock=Date.now){
 const c=structuredClone(config);
 if(!c.issuerRole||typeof loadQualification!=='function'||typeof signScoped!=='function')throw Error('issuer_server_configuration_required');
 return async function stage(scope,tx,signal){
  const deny=reason=>({staged:false,reason,committed:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false});
  try{
   const s=structuredClone(scope),loaded=await loadQualification(signal);
   if(!Buffer.isBuffer(loaded?.policyBytes)||!Buffer.isBuffer(loaded?.archiveBytes))return deny('issuer_qualification_bytes_missing');
   const policyBytes=Buffer.from(loaded.policyBytes),archiveBytes=Buffer.from(loaded.archiveBytes),p=JSON.parse(policyBytes);
   if(p.completeOwnerRecoveryQualification!==true||p.candidateApplicationPublished!==true||!Array.isArray(p.unqualified)||p.unqualified.length)return deny('issuer_qualification_incomplete');
   // Capture transaction identity before any asynchronous signature/API work.
   const id=await tx.query("SELECT txid_current()::text txid,current_user::text role,session_user::text session_role,current_setting('transaction_read_only') read_only");
   const x=id.rows?.[0];if(id.rows?.length!==1||x.role!==c.issuerRole||x.session_role!==c.issuerSessionRole||x.read_only!=='off'||!/^\d+$/.test(x.txid))return deny('issuer_transaction_identity_invalid');
   const signed=await signScoped(s,tx,signal);if(!signed?.ok)return deny('issuer_runtime_witness_unavailable');
   const cfg={...c,runtimeWitness:{...c.runtimeWitness,scope:s}};
   const v=await verifyScopedReleaseAssurance(cfg,policyBytes,archiveBytes,signed.witnessBytes,signed.signature,transport,clock(),clock,signal);
   if(!v.ok)return deny(v.reason);
   const digest=v.artifactDigest.replace(/^sha256:/,'');
   // All state/consent comparisons and INSERT occur under one SQL snapshot;
   // row locks persist to caller commit. Transaction-id condition rejects an
   // auto-commit client or switched connection instead of silently issuing.
   const q=await tx.query({text:`WITH locked AS (
 SELECT a.id FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease l ON l.execution_account_id=a.id AND l.owner_user_id=a.owner_user_id
 JOIN private.strata_owner_control_heads h ON h.execution_account_id=a.id AND h.owner_user_id=a.owner_user_id
 JOIN private.strata_owner_recovery_consent_receipt r ON r.account_id=a.id AND r.owner_id=a.owner_user_id
 JOIN private.strata_owner_recovery_consent_challenge c ON c.id=r.challenge_id AND c.consumed_request_id=r.request_id
 WHERE txid_current()=$1::bigint AND a.id=$2 AND a.owner_user_id=$3::uuid AND r.request_id=$4::uuid
 AND a.revision=$5::bigint AND h.sequence=$6::bigint AND l.fencing_token=$7::bigint AND l.consent_epoch=$8::bigint
 AND a.execution_enabled=false AND a.kill_switch=true AND l.state='killed' AND l.account_kill=true AND l.arm_requested=false
 AND a.key_fingerprint=$9 AND l.credential_fingerprint=$9 AND c.credential_fingerprint=$9 AND c.policy_hash=$10
 AND c.owner_id=a.owner_user_id AND c.account_id=a.id AND c.action='OWNER_RECOVERY'
 AND c.release_sha=$11 AND c.machine_evidence_digest=$12 AND c.control_sequence=h.sequence AND c.worker_fence=l.fencing_token AND c.lease_consent_epoch=l.consent_epoch
 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND c.consent_digest=r.consent_digest
 AND to_timestamp($17::double precision/1000)>clock_timestamp()
 FOR UPDATE OF a,l,h,c
 ) INSERT INTO private.strata_owner_machine_authority
 (request_id,owner_id,account_id,release_sha,machine_digest,policy_hash,credential_fingerprint,revision,control_sequence,worker_fence,consent_epoch,
 issuer_repository_id,issuer_workflow_id,issuer_run_id,issuer_run_attempt,expires_at)
 SELECT $4::uuid,$3::uuid,$2,$11,$12,$10,$9,$5::bigint,$6::bigint,$7::bigint,$8::bigint,$13::bigint,$14::bigint,$15::bigint,$16::integer,to_timestamp($17::double precision/1000)
 FROM locked ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
    values:[x.txid,s.accountId,s.ownerId,s.requestId,s.revision,s.controlSequence,s.workerFence,s.consentEpoch,s.credentialFingerprint,s.policyHash,v.releaseSha,digest,v.issuerRepositoryId,v.issuerWorkflowId,v.issuerRunId,v.issuerRunAttempt,v.validUntil],query_timeout:3000});
   if(q.rows?.length!==1)return deny('issuer_scope_changed_expired_or_replayed');
   return {staged:true,requestId:s.requestId,witnessDigest:v.witnessDigest,validUntil:v.validUntil,committed:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false};
  }catch{return deny('issuer_stage_unavailable_rollback_required');}
 };
}
module.exports={createScopedAuthorityIssuer};
