import assert from 'node:assert/strict';import {generateKeyPairSync} from 'node:crypto';
import type {Pool} from '@workspace/db';import {createRecoveryProviderIdentityReader} from './ownerRecoveryProviderIdentityCandidate';import {dedicatedSignerFingerprint} from './commissioning';
/** Only test fixture preparation; generated keys and fake provider responses.
 * Uses real SQL adapter against minimal Vault/credential table shapes. */
export async function providerCompositionFixture(db:Pool,scope:{accountId:string;ownerId:string;credentialFingerprint:string}){
 const key=(id:string)=>({api_key_id:id,private_key:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey});
 const target=key('simulated-restricted'),verifier=key('simulated-verifier');
 const fp=(x:typeof target)=>dedicatedSignerFingerprint(x.api_key_id,x.private_key)!;
 await db.query(`CREATE SCHEMA vault;CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY,decrypted_secret text);
 CREATE TABLE private.kalshi_connection_credentials(id uuid PRIMARY KEY,owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,role text,vault_secret_id uuid,key_fingerprint text,revoked_at timestamptz,verified_at timestamptz,verification_reason text);`);
 const v='99999999-9999-4999-8999-999999999999';
 for(const [id,material,role] of [[scope.ownerId,target,'restricted_execution'],[v,verifier,'verification']] as const){await db.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[id,JSON.stringify(material)]);await db.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$2,$2,$3,$1,$4,NULL,now(),'credential_verified')",[id,scope.ownerId,role,fp(material)]);}

 let invalid=false;const calls:string[]=[];
 const get:any=async(_creds:any,path:string,_q:string,_f:any,host:string)=>{assert.equal(host,'https://external-api.kalshi.com');calls.push(path);if(path.endsWith('/api_keys'))return {api_keys:[{api_key_id:verifier.api_key_id,subaccount:null,scopes:['read']},{api_key_id:target.api_key_id,subaccount:1,revoked:invalid,scopes:['read','write::trade']}]};if(path.endsWith('/subaccounts/balances'))return {subaccount_balances:[{subaccount_number:0,exchange_index:2,balance:'0.0000',updated_ts:1},{subaccount_number:1,exchange_index:2,balance:'0.0000',updated_ts:1}]};return {balance_dollars:'25.0000',subaccount:1,exchange_index:2};};
 return {get,fingerprint:fp(target),calls,setInvalid:(value=true)=>{invalid=value},reader:createRecoveryProviderIdentityReader({...scope,credentialFingerprint:fp(target)},{get})};
}
