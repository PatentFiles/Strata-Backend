import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync} from 'node:crypto';
import {createRecoveryProviderIdentityReader} from './ownerRecoveryProviderIdentityCandidate';import {dedicatedSignerFingerprint} from './commissioning';
const key=(keyId:string)=>{const k=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});return {api_key_id:keyId,private_key:k.privateKey}};
const target=key('synthetic-target'),verifier=key('synthetic-verifier'),fingerprint=(m:typeof target)=>dedicatedSignerFingerprint(m.api_key_id,m.private_key)!;
const scope={accountId:'fixture',ownerId:'11111111-1111-4111-8111-111111111111',credentialFingerprint:fingerprint(target)};
function fixture(mode='ok'){
 let clock=10000;const calls:string[]=[];
 const db:any={query:async(sql:string,args:any[])=>{
  if(sql.includes('decrypted_secret'))return {rows:[{decrypted_secret:JSON.stringify(args[0]==='target'?target:verifier)}]};
  const rows=[{role:'restricted_execution',vault_secret_id:'target',key_fingerprint:scope.credentialFingerprint,financial_account_id:'financial',provider_connection_id:'provider'},{role:'verification',vault_secret_id:'verifier',key_fingerprint:fingerprint(verifier),financial_account_id:'financial',provider_connection_id:'provider'}];
  if(mode==='missing')rows.pop();if(mode==='duplicate')rows.push(rows[0]);if(mode==='fingerprint')rows[0].key_fingerprint='bad';return {rows};
 }};
 const get:any=async(creds:any,path:string,query:string,_fetch:any,host:string,owner:string,signal:AbortSignal)=>{
  calls.push(path);assert.equal(host,'https://external-api.kalshi.com');assert.equal(owner,scope.ownerId);assert(signal instanceof AbortSignal);
  if(mode==='error')throw Error('synthetic provider error');
  if(path.endsWith('api_keys')){assert.equal(creds.keyId,verifier.api_key_id);return {api_keys:[{api_key_id:verifier.api_key_id,subaccount:null,scopes:['read']},{api_key_id:target.api_key_id,revoked:mode==='revoked',subaccount:mode==='wrong_pair'?2:1,scopes:mode==='scope'?['read','write']:['read','write::trade']}]};}
  if(path.endsWith('subaccounts/balances'))return {subaccount_balances:[{subaccount_number:0,exchange_index:2,balance:'0.0000',updated_ts:1},{subaccount_number:1,exchange_index:2,balance:'0.0000',updated_ts:1}]};
  assert.equal(creds.keyId,target.api_key_id);assert.equal(query,'?subaccount=1&exchange_index=2');if(mode==='stale')clock+=5000;return {balance_dollars:'12.3400',subaccount:1,exchange_index:2};
 };
 return {db,calls,read:createRecoveryProviderIdentityReader(scope,{get,now:()=>clock})};
}
test('real probe adapter derives identity with three bounded signed-GET paths; fixtures simulated',async()=>{const f=fixture();const r=await f.read(f.db);assert.equal(r.credentialFingerprint,scope.credentialFingerprint);assert.equal(r.active,true);assert.equal(r.observedAtMs,10000);assert.equal(f.calls.length,3)});
for(const mode of ['missing','duplicate','fingerprint','error','wrong_pair','scope','stale','revoked'])test('provider adapter refuses '+mode,async()=>{const f=fixture(mode);await assert.rejects(f.read(f.db));if(['missing','duplicate','fingerprint'].includes(mode))assert.equal(f.calls.length,0)});
