import {dedicatedSignerFingerprint} from './commissioning';
import type {Query,Row} from './capitalCreditProof';
type Binding={credentialId:string;ownerId:string;financialAccountId:string;providerConnectionId:string;fingerprint:string;vaultSecretId:string;role:'restricted_execution'|'account_setup_execution'};
const string=(v:unknown)=>typeof v==='string'?v:'';
/** Exact existing owner/account/provider credentials only. The setup material is
 * consumed exclusively by the fixed transfer-history GET. No fallback, grants,
 * credential creation, account setup, or provider write is performed here. */
export async function loadCapitalTransferSigner(db:Query,account:Row,lock=false){
 const rows=await db.query(`SELECT c.id::text AS credential_id,c.owner_user_id::text AS owner_id,
 c.financial_account_id::text AS financial_account_id,c.provider_connection_id::text AS provider_connection_id,
 c.key_fingerprint,c.vault_secret_id::text AS vault_secret_id,c.role
 FROM public.v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2
 AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 AND (c.role='account_setup_execution' OR (c.role='restricted_execution' AND c.key_fingerprint=a.key_fingerprint))
 LIMIT 3 ${lock?'FOR SHARE OF a,fa,pc,c':''}`,[account.id,account.owner_id]);
 const restricted=rows.rows.filter(r=>r.role==='restricted_execution'),setup=rows.rows.filter(r=>r.role==='account_setup_execution');
 if(restricted.length!==1||setup.length!==1||rows.rows.length!==2||restricted[0].provider_connection_id!==setup[0].provider_connection_id)throw Error('capital_transfer_signer_scope_unverified');
 function binding(r:Row):Binding{
  if(![r.credential_id,r.owner_id,r.financial_account_id,r.provider_connection_id,r.vault_secret_id].every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v))||! /^[a-f0-9]{64}$/.test(string(r.key_fingerprint))||r.owner_id!==account.owner_id||r.financial_account_id!==account.kalshi_connection_id)throw Error('capital_transfer_signer_scope_unverified');
  return {credentialId:string(r.credential_id),ownerId:string(r.owner_id),financialAccountId:string(r.financial_account_id),providerConnectionId:string(r.provider_connection_id),fingerprint:string(r.key_fingerprint),vaultSecretId:string(r.vault_secret_id),role:r.role as Binding['role']};
 }
 const restrictedBinding=binding(restricted[0]),setupBinding=binding(setup[0]);
 const secret=await db.query('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id=$1::uuid',[setupBinding.vaultSecretId]);
 if(secret.rows.length!==1||typeof secret.rows[0].decrypted_secret!=='string')throw Error('capital_transfer_signer_unavailable');
 let material:{keyId:string;privateKey:string};
 try{const parsed=JSON.parse(secret.rows[0].decrypted_secret) as Row;if(typeof parsed.api_key_id!=='string'||typeof parsed.private_key!=='string')throw Error('invalid');material={keyId:parsed.api_key_id,privateKey:parsed.private_key};}catch{throw Error('capital_transfer_signer_unavailable');}
 if(dedicatedSignerFingerprint(material.keyId,material.privateKey)!==setupBinding.fingerprint)throw Error('capital_transfer_signer_fingerprint_mismatch');
 return {material,bindings:{restricted:restrictedBinding,setup:setupBinding}};
}
