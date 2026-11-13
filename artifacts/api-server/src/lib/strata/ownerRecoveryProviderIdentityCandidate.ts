import type {PoolClient} from '@workspace/db';
import {getScopedKalshiJson} from '../kalshiAccountClient';
import {probeAccountCredential,type CredentialProbeMaterial} from './accountCredentialProbe';
import {dedicatedSignerFingerprint} from './commissioning';
import type {RecoveryProviderIdentity} from './ownerRecoveryCredentialGuardCandidate';
const HOST='https://external-api.kalshi.com';
export const RECOVERY_IDENTITY_CREDENTIALS_SQL=`SELECT c.role,c.vault_secret_id::text,c.key_fingerprint,
 l.financial_account_id::text,l.provider_connection_id::text
 FROM private.kalshi_account_worker_lease l
 JOIN public.v13_production_account a ON a.id=l.execution_account_id AND a.owner_user_id=l.owner_user_id
 JOIN private.kalshi_connection_credentials c ON c.financial_account_id=l.financial_account_id
 AND c.provider_connection_id=l.provider_connection_id AND c.owner_user_id=l.owner_user_id
 WHERE l.execution_account_id=$1 AND l.owner_user_id=$2::uuid
 AND a.key_fingerprint=$3 AND l.credential_fingerprint=$3
 AND c.role IN ('restricted_execution','verification') AND c.revoked_at IS NULL
 AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 ORDER BY c.role LIMIT 3 FOR SHARE OF c,l,a`;
type Get=typeof getScopedKalshiJson;
/** Real read-only signing/probe adapter, not mounted/enabled. Tests inject fake
 * transport and Vault rows. No issuer or independent human reviewer involved:
 * verification is the owner's separate read/management credential role. */
export function createRecoveryProviderIdentityReader(scope:{accountId:string;ownerId:string;credentialFingerprint:string},deps:{get?:Get;now?:()=>number}={}){
 const get=deps.get??getScopedKalshiJson,now=deps.now??Date.now;
 return async(tx:PoolClient):Promise<RecoveryProviderIdentity>=>{
  const rows=(await tx.query(RECOVERY_IDENTITY_CREDENTIALS_SQL,[scope.accountId,scope.ownerId,scope.credentialFingerprint])).rows;
  if(rows.length!==2||rows.filter(r=>r.role==='restricted_execution').length!==1||rows.filter(r=>r.role==='verification').length!==1)throw Error('owned_verified_credential_pair_missing');
  const target=rows.find(r=>r.role==='restricted_execution')!,verifier=rows.find(r=>r.role==='verification')!;
  if(target.key_fingerprint!==scope.credentialFingerprint||target.financial_account_id!==verifier.financial_account_id||target.provider_connection_id!==verifier.provider_connection_id)throw Error('credential_pair_binding_mismatch');
  const material=async(row:typeof target):Promise<CredentialProbeMaterial>=>{
   const s=await tx.query('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id=$1::uuid',[row.vault_secret_id]);
   if(s.rows.length!==1)throw Error('credential_material_unavailable');
   let parsed:any;try{parsed=JSON.parse(s.rows[0].decrypted_secret);}catch{throw Error('credential_material_invalid');}
   if(typeof parsed.api_key_id!=='string'||typeof parsed.private_key!=='string'||dedicatedSignerFingerprint(parsed.api_key_id,parsed.private_key)!==row.key_fingerprint)throw Error('credential_material_fingerprint_mismatch');
   return {keyId:parsed.api_key_id,privateKey:parsed.private_key};
  };
  const targetMaterial=await material(target),verificationMaterial=await material(verifier);
  const started=now(),signal=AbortSignal.timeout(4500);let calls=0;
  const result=await probeAccountCredential('restricted_execution',scope.credentialFingerprint,targetMaterial,async(creds,path,query)=>{
   if(++calls>3||!['/trade-api/v2/api_keys','/trade-api/v2/portfolio/subaccounts/balances','/trade-api/v2/portfolio/balance'].includes(path))throw Error('credential_probe_path_rejected');
   if(now()<started||now()-started>4500||signal.aborted)throw Error('credential_probe_expired');
   const payload:any=await get(creds,path,query,fetch,HOST,scope.ownerId,signal);
   if(path==='/trade-api/v2/api_keys'){
    if(!Array.isArray(payload?.api_keys)||payload.cursor||payload.next_cursor)throw Error('credential_inventory_incomplete');
    for(const keyId of [targetMaterial.keyId,verificationMaterial.keyId]){
     const found=payload.api_keys.filter((r:any)=>r?.api_key_id===keyId);
     if(found.length!==1)throw Error('credential_inventory_ambiguous');
     const record=found[0];
     if(record.revoked_at!=null||record.deleted_at!=null||record.revoked===true||record.active===false||
      (record.expires_at!=null&&(!Number.isFinite(Date.parse(record.expires_at))||Date.parse(record.expires_at)<=now())))throw Error('credential_inventory_inactive');
    }
   }
   return payload;
  },{expectedFingerprint:verifier.key_fingerprint,material:verificationMaterial});
  if(!result.ok||result.restrictedKeyMetadataVerified!==true||result.subaccount1Exists!==true||result.subaccount1Exchange2Exists!==true)throw Error('provider_credential_identity_unverified');
  if(!Number.isSafeInteger(started)||now()<started||now()-started>4500||signal.aborted)throw Error('provider_credential_identity_stale');
  return {authenticated:true,active:true,restricted:true,observedAtMs:started,ownerId:scope.ownerId,financialAccountId:target.financial_account_id,providerConnectionId:target.provider_connection_id,credentialFingerprint:scope.credentialFingerprint,subaccount:1,exchangeIndex:2};
 };
}
