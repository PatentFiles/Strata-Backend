import test from 'node:test';
import assert from 'node:assert/strict';
import {readBracketedSettledCash} from './settledCashBracket';
import {KalshiApiError} from '../kalshiAccountClient';
import type {getOwnedProductionKalshiJson} from './personalExchangeRead';
const CREDS={keyId:'fixture-only',privateKey:'fixture-only'};
const NOW=100000;
const balance={balance:2648,balance_dollars:'26.4845',updated_ts:55};
const BALANCE='/trade-api/v2/portfolio/balance';
function fixture(options:{initial?:object;trailing?:object;clock?:()=>number;error?:Error}={}){
 const calls:{path:string;query:string|undefined}[]=[];let count=0;
 const get:typeof getOwnedProductionKalshiJson=async(creds,path,query,_fetch,_host,_owner,signal)=>{
  assert.equal(creds,CREDS);assert.equal(signal?.aborted,false);
  calls.push({path,query});
  if(path===BALANCE){
   assert.equal(query,'?subaccount=1&exchange_index=2');
   if(++count===1)return options.initial??balance;
   if(options.error)throw options.error;
   return options.trailing??balance;
  }
  if(path.endsWith('/orders'))return {orders:[]};
  if(path.endsWith('/fills'))return {fills:[]};
  if(path.endsWith('/positions'))return {market_positions:[]};
  if(path.endsWith('/settlements'))return {settlements:[]};
  throw Error('unexpected provider path');
 };
 return {calls,result:()=>readBracketedSettledCash(CREDS,NOW,{get,now:options.clock??(()=>NOW)})};
}
test('accepts documented blank-scope body only from exact scoped request; two reads bracket one whole scan',async()=>{
 const f=fixture(),r=await f.result();assert.ok(r.ok);assert.equal(r.cashMicros,'26484500');assert.equal(r.observedAtMs,NOW);
 assert.equal(f.calls.length,8);assert.equal(f.calls[0]?.path,BALANCE);assert.equal(f.calls.at(-1)?.path,BALANCE);
});
test('same cash with changed provider cash version is not coherent',async()=>{
 const f=fixture({trailing:{...balance,updated_ts:56}});
 assert.deepEqual(await f.result(),{ok:false,reason:'recovery_signed_bracket_changed'});assert.equal(f.calls.length,8);
});
test('changed cash, contradictory scope, and missing version fail closed',async()=>{
 for(const [trailing,reason] of [
  [{...balance,balance_dollars:'26.4945',balance:2649},'recovery_signed_bracket_changed'],
  [{...balance,subaccount:1,subaccount_number:0},'recovery_signed_bracket_balance_invalid'],
  [{...balance,exchange_index:0},'recovery_signed_bracket_balance_invalid'],
  [{...balance,updated_ts:null},'recovery_signed_bracket_balance_invalid'],
 ] as const){
  const f=fixture({trailing});
  assert.deepEqual(await f.result(),{ok:false,reason});assert.equal(f.calls.length,8);
 }
});
test('rejects bad opening before gathering history or retrying',async()=>{
 const f=fixture({initial:{...balance,updated_ts:0}});
 assert.deepEqual(await f.result(),{ok:false,reason:'recovery_signed_bracket_balance_invalid'});assert.equal(f.calls.length,1);
});
test('provider rate limit is not retried',async()=>{
 const f=fixture({error:new KalshiApiError('HTTP_ERROR',429)});
 assert.deepEqual(await f.result(),{ok:false,reason:'kalshi_read_rate_limited'});assert.equal(f.calls.length,8);
});
test('cannot restart an expired clock or accept a regressed clock',async()=>{
 for(const clock of [()=>NOW+5001,()=>NOW-1]){
  const f=fixture({clock});assert.deepEqual(await f.result(),{ok:false,reason:'recovery_signed_bracket_clock_invalid'});assert.equal(f.calls.length,0);
 }
});
