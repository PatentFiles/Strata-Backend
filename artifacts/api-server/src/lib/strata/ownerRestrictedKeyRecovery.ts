import { createHash, randomUUID } from "node:crypto";
import { dedicatedSignerFingerprint } from "./commissioning";
import { lockFrozenRestrictedRecovery } from "./frozenRestrictedCredentialRecovery";
import { replaceOwnedCredentialInTransaction, type CredentialDatabase, type CredentialClient } from "./accountCredentialStore";
import type { RestrictedKeyGenerationTransport } from "./accountRestrictedKeyGeneration";

/**
 * Separate lifecycle from initial subaccount provisioning. Never edit the
 * completed initial generation attempt. This is only a replacement for an
 * *uncommissioned, unfunded, killed* owner account whose Kalshi key is absent
 * or has the wrong subaccount scope.
 */
export const RESTRICTED_KEY_RECOVERY_CONFIRMATION = "GENERATE_RESTRICTED_KEY_FOR_MY_FROZEN_ACCOUNT";
export const RECOVERY_PLAN = Object.freeze({
  name: "STRATA_V13_SUBACCOUNT_1",
  key_type: "rsa",
  scopes: ["read", "write::trade"],
  subaccount: 1,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
export interface RecoveryIdentity {
  owner: string;
  financial: string;
  connection: string;
  execution: string;
  previous: string;
  setupId: string;
  setupFingerprint: string;
  verificationId: string;
  verificationFingerprint: string;
}
export type RecoveryResult = {
  ok: boolean;
  reason: string;
  attemptId: string | null;
  state: string | null;
  exchangePostAttempted: boolean;
  executable: false;
  plan?: typeof RECOVERY_PLAN;
};
const outcome = (ok:boolean, reason:string, attemptId:string|null=null, state:string|null=null, exchangePostAttempted=false):RecoveryResult =>
  ({ok,reason,attemptId,state,exchangePostAttempted,executable:false});
const LOCK_CONNECTION = `
  -- owner-key-recovery:connection
  SELECT pc.id FROM private.provider_connections pc
  JOIN public.financial_accounts fa ON fa.id=pc.financial_account_id
    AND fa.user_id=$1::uuid AND fa.provider='kalshi'
  WHERE pc.id=$2::uuid AND fa.id=$3::uuid
  FOR UPDATE OF pc
`;
const LOCK_RESTRICTED = `
  -- owner-key-recovery:credential
  SELECT id::text AS id,key_fingerprint
  FROM private.kalshi_connection_credentials
  WHERE owner_user_id=$1::uuid AND provider_connection_id=$2::uuid
    AND role='restricted_execution' AND revoked_at IS NULL
  FOR UPDATE
`;
const LOCK_AUTHORITY = `
  -- owner-key-recovery:authority
  SELECT id FROM private.kalshi_connection_credentials
  WHERE id=$1::uuid AND owner_user_id=$2::uuid AND provider_connection_id=$3::uuid
    AND role=$4 AND key_fingerprint=$5
    AND verified_at IS NOT NULL AND verification_reason='credential_verified'
    AND revoked_at IS NULL
  FOR SHARE
`;
const READ_UNRESOLVED = `
  -- owner-key-recovery:unresolved
  SELECT id::text AS id,state,previous_fingerprint,setup_fingerprint,verification_fingerprint
  FROM private.kalshi_restricted_key_recovery
  WHERE owner_user_id=$1::uuid AND state IN ('prepared','attempted','response_received','uncertain')
  FOR UPDATE
`;
const INSERT_PREPARED = `
  -- owner-key-recovery:prepare
  INSERT INTO private.kalshi_restricted_key_recovery
  (owner_user_id,financial_account_id,provider_connection_id,execution_account_id,
   previous_fingerprint,setup_credential_id,setup_fingerprint,
   verification_credential_id,verification_fingerprint)
  VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8::uuid,$9)
  RETURNING id::text AS id
`;
const LOCK_PREPARED = `
  -- owner-key-recovery:lock-prepared
  SELECT id::text AS id,state,execution_account_id,previous_fingerprint,
    setup_credential_id::text AS setup_credential_id,setup_fingerprint,
    verification_credential_id::text AS verification_credential_id,verification_fingerprint
  FROM private.kalshi_restricted_key_recovery
  WHERE id=$1::uuid AND owner_user_id=$2::uuid
    AND financial_account_id=$3::uuid AND provider_connection_id=$4::uuid
  FOR UPDATE
`;
const CLAIM = `
  -- owner-key-recovery:claim
  UPDATE private.kalshi_restricted_key_recovery
  SET state='attempted',attempted_at=now()
  WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='prepared'
  RETURNING id
`;
const MARK_UNCERTAIN = `
  -- owner-key-recovery:uncertain
  UPDATE private.kalshi_restricted_key_recovery
  SET state='uncertain',reason=$3
  WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state IN ('attempted','response_received')
  RETURNING id
`;
const CREATE_SECRET = `
  -- owner-key-recovery:vault
  SELECT vault.create_secret($1,$2,'owner-restricted-key-recovery') AS id
`;
const REVOKE_OLD = `
  -- owner-key-recovery:retire-incorrect-key
  UPDATE private.kalshi_connection_credentials
  SET revoked_at=now(),updated_at=now()
  WHERE id=$1::uuid AND owner_user_id=$2::uuid AND provider_connection_id=$3::uuid
    AND key_fingerprint=$4 AND role='restricted_execution' AND revoked_at IS NULL
  RETURNING id
`;
const SAVE_RESPONSE = `
  -- owner-key-recovery:store-response
  UPDATE private.kalshi_restricted_key_recovery
  SET state='response_received',response_received_at=now(),response_digest=$3,
    target_credential_id=$4::uuid,target_fingerprint=$5
  WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='attempted'
  RETURNING id
`;
const MARK_VERIFIED = `
  -- owner-key-recovery:mark-verified
  UPDATE private.kalshi_connection_credentials c
  SET verified_at=now(),verification_reason='credential_verified',updated_at=now()
  FROM private.kalshi_restricted_key_recovery r
  WHERE r.id=$1::uuid AND r.owner_user_id=$2::uuid
    AND r.state='response_received' AND r.target_fingerprint=$3
    AND c.id=r.target_credential_id AND c.owner_user_id=r.owner_user_id
    AND c.provider_connection_id=r.provider_connection_id
    AND c.key_fingerprint=$3 AND c.role='restricted_execution'
    AND c.revoked_at IS NULL AND c.verified_at IS NULL
  RETURNING c.id
`;
const FINISH = `
  -- owner-key-recovery:finish
  UPDATE private.kalshi_restricted_key_recovery
  SET state='completed',completed_at=now(),reason='restricted_key_verified'
  WHERE id=$1::uuid AND owner_user_id=$2::uuid
    AND state='response_received' AND target_fingerprint=$3
  RETURNING id
`;

async function lockOwner(client:CredentialClient, identity:RecoveryIdentity) {
  const c=await client.query(LOCK_CONNECTION,[identity.owner,identity.connection,identity.financial]);
  if(c.rows.length!==1)return null;
  const frozen=await lockFrozenRestrictedRecovery(client,identity.owner,identity.financial);
  if(!frozen||frozen.executionAccountId!==identity.execution||frozen.previousFingerprint!==identity.previous)return null;
  const restricted=await client.query(LOCK_RESTRICTED,[identity.owner,identity.connection]);
  if(restricted.rows.length!==1 || restricted.rows[0]?.key_fingerprint!==identity.previous)return null;
  for(const [id,role,hash] of [
    [identity.setupId,"account_setup_execution",identity.setupFingerprint],
    [identity.verificationId,"verification",identity.verificationFingerprint],
  ]) {
    const verified=await client.query(LOCK_AUTHORITY,[id,identity.owner,identity.connection,role,hash]);
    if(verified.rows.length!==1)return null;
  }
  return {oldId:String(restricted.rows[0]?.id)};
}

/** Preparation makes NO Kalshi write. Signed no-exposure preflight is required by caller. */
export async function prepareFrozenKeyRecovery(db:CredentialDatabase,identity:RecoveryIdentity):Promise<RecoveryResult> {
  if(!UUID.test(identity.owner)||!UUID.test(identity.financial)||!UUID.test(identity.connection)||
     !UUID.test(identity.setupId)||!UUID.test(identity.verificationId)||
     !SHA.test(identity.previous)||!SHA.test(identity.setupFingerprint)||!SHA.test(identity.verificationFingerprint))
    return outcome(false,"recovery_identity_invalid");
  try {
    return await db.transaction(async client=>{
      if(!await lockOwner(client,identity))return outcome(false,"recovery_account_not_frozen_or_verified");
      const existing=await client.query(READ_UNRESOLVED,[identity.owner]);
      if(existing.rows.length>1)return outcome(false,"recovery_attempt_conflict");
      if(existing.rows.length===1){
        const row=existing.rows[0]!;
        if(row.state==="prepared" && row.previous_fingerprint===identity.previous &&
           row.setup_fingerprint===identity.setupFingerprint &&
           row.verification_fingerprint===identity.verificationFingerprint){
          return {...outcome(true,"recovery_prepared",String(row.id),"prepared"),plan:RECOVERY_PLAN};
        }
        return outcome(false,"recovery_prior_attempt_requires_reconciliation",String(row.id),String(row.state));
      }
      const inserted=await client.query(INSERT_PREPARED,[
        identity.owner,identity.financial,identity.connection,identity.execution,identity.previous,
        identity.setupId,identity.setupFingerprint,identity.verificationId,identity.verificationFingerprint
      ]);
      const id=inserted.rows[0]?.id;
      return typeof id==="string"
        ? {...outcome(true,"recovery_prepared",id,"prepared"),plan:RECOVERY_PLAN}
        : outcome(false,"recovery_preparation_failed");
    });
  }catch{return outcome(false,"recovery_preparation_failed");}
}

/**
 * Claim is committed before the single POST. Any timeout or unknown outcome
 * requires manual reconciliation; automated retries could create two keys.
 */
export async function executeFrozenKeyRecovery(db:CredentialDatabase,input:{
  identity:RecoveryIdentity;
  attemptId:string;
  confirmation:unknown;
  transport:RestrictedKeyGenerationTransport;
  setupMaterial:{keyId:string;privateKey:string};
  verify:(key:{keyId:string;privateKey:string},fingerprint:string)=>Promise<{ok:boolean;reason:string}>;
}):Promise<RecoveryResult> {
  const {identity:i,attemptId:id}=input;
  if(input.confirmation!==RESTRICTED_KEY_RECOVERY_CONFIRMATION)return outcome(false,"explicit_owner_confirmation_required");
  if(!UUID.test(id))return outcome(false,"recovery_attempt_invalid");
  let claimed=false;
  try{
    claimed=await db.transaction(async client=>{
      const lock=await lockOwner(client,i);
      if(!lock)return false;
      const rows=await client.query(LOCK_PREPARED,[id,i.owner,i.financial,i.connection]);
      if(rows.rows.length!==1)return false;
      const a=rows.rows[0]!;
      if(a.state!=="prepared" || a.execution_account_id!==i.execution ||
         a.previous_fingerprint!==i.previous || a.setup_credential_id!==i.setupId ||
         a.setup_fingerprint!==i.setupFingerprint ||
         a.verification_credential_id!==i.verificationId ||
         a.verification_fingerprint!==i.verificationFingerprint)return false;
      const result=await client.query(CLAIM,[id,i.owner]);
      return result.rows.length===1;
    });
  }catch{return outcome(false,"recovery_claim_failed",id);}
  if(!claimed)return outcome(false,"recovery_preconditions_changed_or_already_attempted",id);
  let response:Awaited<ReturnType<RestrictedKeyGenerationTransport>>;
  try { response=await input.transport(input.setupMaterial); }
  catch {response="uncertain";}
  // Transport credential is supplied by trusted caller via the closure, never
  // exposed to the HTTP request or logs.
  if(response==="uncertain"||response.unreadable||response.status!==201){
    await uncertain(db,i.owner,id,"exchange_generation_outcome_unresolved");
    return outcome(false,"recovery_post_uncertain_or_rejected_no_retry",id,"uncertain",true);
  }
  const raw=response.body;
  const b=(raw&&typeof raw==="object"&&!Array.isArray(raw))?raw as Record<string,unknown>:{};
  const keyId=typeof b.api_key_id==="string"?b.api_key_id.trim():"";
  const privateKey=typeof b.private_key==="string"?b.private_key.trim():"";
  const fingerprint=dedicatedSignerFingerprint(keyId,privateKey);
  if(b.key_type!=="rsa" || !keyId || !privateKey || !fingerprint || !SHA.test(fingerprint)){
    await uncertain(db,i.owner,id,"generation_response_invalid");
    return outcome(false,"recovery_generation_response_invalid_no_retry",id,"uncertain",true);
  }
  let saved=false;
  try{
    saved=await db.transaction(async client=>{
      const lock=await lockOwner(client,i);
      if(!lock)return false;
      const attempt=await client.query(LOCK_PREPARED,[id,i.owner,i.financial,i.connection]);
      if(attempt.rows.length!==1 || attempt.rows[0]?.state!=="attempted")return false;
      // Store the one-time private key before replacing any binding.
      const secret=await client.query(CREATE_SECRET,[
        JSON.stringify({api_key_id:keyId,private_key:privateKey}),
        `kalshi:${i.owner}:restricted_execution:${randomUUID()}`
      ]);
      const secretId=secret.rows[0]?.id;
      if(typeof secretId!=="string" || !UUID.test(secretId))throw Error("vault_write_failed");
      const retired=await client.query(REVOKE_OLD,[lock.oldId,i.owner,i.connection,i.previous]);
      if(retired.rows.length!==1)throw Error("old_key_changed");
      const result=await replaceOwnedCredentialInTransaction(client,{
        authenticatedUserId:i.owner,providerConnectionId:i.connection,
        role:"restricted_execution",vaultSecretId:secretId,
        keyFingerprint:fingerprint,frozenRestrictedRecovery:true
      });
      if(!result.ok)throw Error("atomic_rebind_failed");
      const digest=createHash("sha256").update(keyId+"|"+fingerprint).digest("hex");
      const stored=await client.query(SAVE_RESPONSE,[id,i.owner,digest,result.credentialId,fingerprint]);
      if(stored.rows.length!==1)throw Error("attempt_record_failed");
      return true;
    });
  }catch{saved=false;}
  if(!saved){
    await uncertain(db,i.owner,id,"vault_or_binding_unconfirmed");
    return outcome(false,"recovery_storage_uncertain_no_retry",id,"uncertain",true);
  }
  // A bound key is never automatically approved without real Kalshi proof.
  let verified:{ok:boolean;reason:string};
  try{verified=await input.verify({keyId,privateKey},fingerprint);}
  catch{verified={ok:false,reason:"signed_verification_unavailable"};}
  if(!verified.ok){
    await uncertain(db,i.owner,id,"signed_verification_failed");
    return outcome(false,"recovery_key_saved_verification_pending",id,"uncertain",true);
  }
  try{
    const complete=await db.transaction(async client=>{
      const row=await client.query(MARK_VERIFIED,[id,i.owner,fingerprint]);
      if(row.rows.length!==1)return false;
      const finished=await client.query(FINISH,[id,i.owner,fingerprint]);
      if(finished.rows.length!==1)throw Error("recovery_completion_not_recorded");
      return true;
    });
    return complete?outcome(true,"restricted_key_recovered_verified",id,"completed",true):
      outcome(false,"recovery_completion_unconfirmed",id,"response_received",true);
  }catch{return outcome(false,"recovery_completion_unconfirmed",id,"response_received",true);}
}

async function uncertain(db:CredentialDatabase,owner:string,id:string,reason:string){
  try{await db.query(MARK_UNCERTAIN,[id,owner,reason]);}catch{/* no retries */}
}
