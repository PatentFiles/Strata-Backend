import {DIRECT_ROUNDING_EVIDENCE_VERSION,currentDirectAccountRoundingEvidence,type DirectAccountRoundingIdentity} from './directAccountRoundingEvidence';
/** Requires reviewed candidate schema; read-only, no approval writes. Missing
 * schema, pending/revoked review, duplicates, stale credentials all fail closed.
 * A production administrator must separately qualify grants and actual review
 * provenance. A row claiming approval is not a review performed by this code. */
export const DIRECT_ROUNDING_AUTHORITY_SQL=`
SELECT r.account_id::text, r.scope_generation::text, r.documentation_policy_digest,
 r.execution_fingerprint, r.verification_fingerprint,
 floor(extract(epoch FROM r.issued_at)*1000)::text AS issued_ms,
 floor(extract(epoch FROM r.expires_at)*1000)::text AS expires_ms
FROM private.strata_direct_rounding_authority r
JOIN v13_production_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
JOIN private.kalshi_connection_credentials execution_credential
 ON execution_credential.owner_user_id=a.owner_user_id AND execution_credential.financial_account_id=a.kalshi_connection_id
 AND execution_credential.key_fingerprint=r.execution_fingerprint AND execution_credential.role='restricted_execution'
 AND execution_credential.revoked_at IS NULL AND execution_credential.verified_at IS NOT NULL AND execution_credential.verification_reason='credential_verified'
JOIN private.kalshi_connection_credentials verification_credential
 ON verification_credential.owner_user_id=a.owner_user_id AND verification_credential.financial_account_id=a.kalshi_connection_id
 AND verification_credential.key_fingerprint=r.verification_fingerprint AND verification_credential.role='verification'
 AND verification_credential.revoked_at IS NULL AND verification_credential.verified_at IS NOT NULL AND verification_credential.verification_reason='credential_verified'

WHERE r.account_id=$1::text AND r.owner_user_id=$2::uuid
AND current_setting('transaction_isolation')='read committed'
AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
AND a.key_fingerprint=r.execution_fingerprint
AND r.state='APPROVED' AND r.revoked_at IS NULL
AND r.review_record_digest ~ '^[a-f0-9]{64}$' AND r.reviewed_by_user_id IS NOT NULL
AND r.issued_at<=clock_timestamp() AND r.expires_at>clock_timestamp()
AND NOT EXISTS(SELECT 1 FROM private.strata_direct_rounding_authority later WHERE later.account_id=r.account_id AND later.scope_generation>r.scope_generation)
LIMIT 2 FOR SHARE OF execution_credential, verification_credential`;
type Query={query:(sql:string,values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>};
export function createDirectRoundingRegistry(db:Query,ownerUserId:string,now:()=>number=Date.now){return async(accountId:string):Promise<DirectAccountRoundingIdentity|null>=>{try{
 const result=await db.query(DIRECT_ROUNDING_AUTHORITY_SQL,[accountId,ownerUserId]);if(result.rows.length!==1)return null;const r=result.rows[0]!;
 const integer=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)?Number(v):NaN;
 const scope:DirectAccountRoundingIdentity={version:DIRECT_ROUNDING_EVIDENCE_VERSION,accountId:r.account_id as string,subaccount:1,exchangeIndex:2,executionCredentialFingerprint:r.execution_fingerprint as string,verificationCredentialFingerprint:r.verification_fingerprint as string,documentationPolicyDigest:r.documentation_policy_digest as string,scopeGeneration:integer(r.scope_generation),authorityIssuedAtMs:integer(r.issued_ms),authorityExpiresAtMs:integer(r.expires_ms)};
 const time=now();if(scope.accountId!==accountId||!currentDirectAccountRoundingEvidence({...scope,observedAtMs:time,expiresAtMs:Math.min(time+15000,scope.authorityExpiresAtMs),balanceResponseDigest:'a'.repeat(64),keyMetadataDigest:'b'.repeat(64)},scope,time))return null;
 return Object.freeze(scope);
}catch{return null;}};}
/** Account/owner/role/fingerprint scoped vault read, never bulk credentials. */
export function createDirectRoundingCredentialResolver(db:Query,ownerUserId:string){return async(accountId:string,role:'restricted_execution'|'verification',fingerprint:string)=>{try{
 if(!['restricted_execution','verification'].includes(role)||!/^[a-f0-9]{64}$/.test(fingerprint))return null;
 const result=await db.query(`SELECT s.decrypted_secret FROM v13_production_account a
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=a.kalshi_connection_id
 JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 WHERE a.id=$1::text AND a.owner_user_id=$2::uuid AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
 AND c.role=$3 AND c.key_fingerprint=$4 AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 AND ($3<>'restricted_execution' OR a.key_fingerprint=c.key_fingerprint) LIMIT 2`,[accountId,ownerUserId,role,fingerprint]);
 if(result.rows.length!==1||typeof result.rows[0]!.decrypted_secret!=='string')return null;
 const parsed=JSON.parse(result.rows[0]!.decrypted_secret);if(!parsed||typeof parsed.api_key_id!=='string'||!parsed.api_key_id.trim()||typeof parsed.private_key!=='string'||!parsed.private_key.trim())return null;
 return Object.freeze({keyId:parsed.api_key_id,privateKey:parsed.private_key});
}catch{return null;}};}
