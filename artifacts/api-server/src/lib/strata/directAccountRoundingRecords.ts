import {createHash} from 'node:crypto';
/** Pure structural/key restriction checks on ALREADY authenticated, production
 * transport responses. This does not authenticate inputs, mint authority, grant
 * policy approval, fetch data, or classify arbitrary user-provided JSON. */
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fcm=(v:Record<string,unknown>)=>['fcm_subtrader_id','subtrader_id','fcm_id'].some(k=>Object.hasOwn(v,k)&&v[k]!==null&&v[k]!==undefined);
const terminalCursor=(v:Record<string,unknown>)=>!Object.hasOwn(v,'cursor')||v.cursor===null||v.cursor==='';
const scopes=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&Array.from(v).every(s=>typeof s==='string'&&s.length>0)&&new Set(v).size===v.length;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validateDirectNumberedCapabilityRecords(input:{executionKeyId:string;verificationKeyId:string;keyMetadata:unknown;restrictedBalances:unknown}):
 {ok:true;balanceResponseDigest:string;keyMetadataDigest:string}|{ok:false;reason:string}{
 if(!input||typeof input.executionKeyId!=='string'||!input.executionKeyId.trim()||typeof input.verificationKeyId!=='string'||!input.verificationKeyId.trim()||input.executionKeyId===input.verificationKeyId)return {ok:false,reason:'credential_identity_unproven'};
 const metadata=input.keyMetadata,balance=input.restrictedBalances;
 if(!object(metadata)||!Array.isArray(metadata.api_keys)||metadata.api_keys.length<2||metadata.api_keys.length>1000||!Array.from(metadata.api_keys).every(object))return {ok:false,reason:'credential_metadata_unproven'};
 if(fcm(metadata)||!terminalCursor(metadata))return {ok:false,reason:'credential_metadata_incomplete_or_fcm'};
 const keys=metadata.api_keys as Record<string,unknown>[];
 const execution=keys.filter(k=>k.api_key_id===input.executionKeyId),verification=keys.filter(k=>k.api_key_id===input.verificationKeyId);
 if(execution.length!==1||verification.length!==1)return {ok:false,reason:'credential_identity_unproven'};
 const e=execution[0]!,v=verification[0]!;
 if(fcm(e)||fcm(v))return {ok:false,reason:'fcm_context_not_direct'};
 if(e.subaccount!==1||!Array.isArray(e.scopes)||e.scopes.length!==2||new Set(e.scopes).size!==2||!e.scopes.includes('read')||!e.scopes.includes('write::trade'))return {ok:false,reason:'execution_key_restriction_unproven'};
 if((Object.hasOwn(v,'subaccount')&&v.subaccount!==null)||!scopes(v.scopes)||!v.scopes.includes('read'))return {ok:false,reason:'verification_key_scope_unproven'};
 if(!object(balance)||fcm(balance)||!terminalCursor(balance)||!Array.isArray(balance.subaccount_balances)||balance.subaccount_balances.length<1||balance.subaccount_balances.length>64)return {ok:false,reason:'numbered_balance_inventory_unproven'};
 const seen=new Set<number>();let target=false;
 for(const row of balance.subaccount_balances){
  if(!object(row)||fcm(row)||row.subaccount_number!==1||typeof row.exchange_index!=='number'||!Number.isSafeInteger(row.exchange_index)||row.exchange_index<0||seen.has(row.exchange_index)||typeof row.balance!=='string'||!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,4})?$/.test(row.balance)||typeof row.updated_ts!=='number'||!Number.isSafeInteger(row.updated_ts)||row.updated_ts<0)return {ok:false,reason:'numbered_balance_inventory_unproven'};
  seen.add(row.exchange_index);if(row.exchange_index===2)target=true;
 }
 if(!target)return {ok:false,reason:'numbered_target_pair_missing'};
 // Digest exact relevant receipt values; no API key identifier is exposed in
 // the result. Stable model identity is separately bound to registered signer
 // fingerprints and reviewed documentation policy, never these fresh digests.
 try{return {ok:true,balanceResponseDigest:hash(balance),keyMetadataDigest:hash({execution:e,verification:v})};}
 catch{return {ok:false,reason:'non_json_receipt'};}
}
