import type {PoolClient} from '@workspace/db';
export type OwnerMachineAuthorityScope={requestId:string;ownerId:string;accountId:string;releaseSha:string;machineEvidenceDigest:string;policyHash:string;credentialFingerprint:string;revision:string;controlSequence:string;fence:string;epoch:string};
/** Inactive issuer: never converts caller claims, owner consent or a fixture
 * into genuine machine authority. Authentic protected issuer is still absent. */
export async function issueOwnerMachineAuthorityCandidate(){return {issued:false,recoveryAuthorized:false,reason:'authentic_protected_issuer_not_configured'} as const;}
/** Transactional consumer ONLY. Not an auth/qualification boundary. The caller
 * must hold owner/account/session/consent guards and use a trusted issuer table
 * whose INSERT/DDL rights the runtime cannot acquire. No production caller. */
export async function consumeOwnerMachineAuthorityCandidate(tx:Pick<PoolClient,'query'>,s:OwnerMachineAuthorityScope){
 const r=await tx.query(`UPDATE private.strata_owner_machine_authority SET consumed_at=clock_timestamp()
 WHERE request_id=$1::uuid AND owner_id=$2::uuid AND account_id=$3 AND release_sha=$4
 AND machine_digest=$5 AND policy_hash=$6 AND credential_fingerprint=$7
 AND revision=$8::bigint AND control_sequence=$9::bigint AND worker_fence=$10::bigint AND consent_epoch=$11::bigint
 AND consumed_at IS NULL AND issued_at<=clock_timestamp() AND expires_at>clock_timestamp()
 RETURNING machine_digest`,[s.requestId,s.ownerId,s.accountId,s.releaseSha,s.machineEvidenceDigest,s.policyHash,s.credentialFingerprint,s.revision,s.controlSequence,s.fence,s.epoch]);
 if(r.rows.length!==1||r.rows[0].machine_digest!==s.machineEvidenceDigest)throw Error('current_scoped_machine_authority_missing');
 return {digest:r.rows[0].machine_digest as string};
}
export async function assertConsumedMachineAuthorityFresh(tx:Pick<PoolClient,'query'>,requestId:string){const r=await tx.query('SELECT consumed_at IS NOT NULL AND expires_at>clock_timestamp() AS fresh FROM private.strata_owner_machine_authority WHERE request_id=$1::uuid',[requestId]);if(r.rows.length!==1||r.rows[0].fresh!==true)throw Error('machine_authority_expired');}
