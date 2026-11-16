import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuardedOwnerV3FeeFetch,FINAL_OWNER_V3_ACCOUNT_FENCE_SQL} from './guardedOwnerV3FeeWire';
import {parseV3FeeSource,type VerifiedOwnerV3FeeAuthority} from './ownerFeeV3Authority';

const owner='11111111-1111-4111-8111-111111111111';
const uuid='22222222-2222-4222-8222-222222222222';
const sha='a'.repeat(40),digest='b'.repeat(64),fingerprint='c'.repeat(64),policy='d'.repeat(64);
const account='strata-account-test',ticker='KXBTC15M-EXACT-TEST';
const source='strata-owner-fee-v3://kxbtc15m/'+uuid;
const order=(reduceOnly:boolean)=>({
 ticker,subaccount:1,exchange_index:2,reduce_only:reduceOnly,
 time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',
 post_only:false,client_order_id:'v13p-'+uuid,side:'bid',count:'1.00',price:'0.2500',
});
const verify=async (_owner:string,_stage:string,_src:string,_ticker?:string):Promise<VerifiedOwnerV3FeeAuthority>=>({
 ok:true,reason:'v3_current_owner_monetary_authority',
 identity:{authorityId:uuid,sourceUrl:source,sourceDigest:digest,
  feePolicyVersion:'strata_owner_official_monetary_fee_v3',
  formulaVersion:'standard-quadratic-0.07-v1',
  marketTicker:ticker,releaseCommitSha:sha}
});
function harness(params:{lockRows?:number;providerOk?:boolean;standing?:boolean;history?:boolean}={}){
 let sends=0;const statements:{sql:string;params?:unknown[]}[]=[];
 const tx={query:async(sql:string,p?:unknown[])=>{statements.push({sql,params:p});return{rows:params.lockRows===0?[]:[{id:account}]};}};
 const underlying=(async()=>{sends++;return new Response('{"accepted":true}',{status:200});}) as typeof fetch;
 const fee=createGuardedOwnerV3FeeFetch(owner,account,source,underlying,policy,fingerprint,12,'holder',digest,{
  borrowTransaction:()=>tx as never,sha:()=>sha,
  verify:(async(o:string,stage:string,url:string,market?:string)=>params.providerOk===false?{ok:false,reason:'provider_offline'}:verify(o,stage,url,market)) as never,
  hasHistory:async()=>params.history??true,
  currentStanding:async()=>params.standing??true,
 });
 return {fee,tx,statements,get sends(){return sends;}};
}
const send=async(h:ReturnType<typeof harness>,body:unknown)=>{
 return h.fee('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{
  method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}
 });
};
test('official V3 records are scoped to exact account, release SHA, immutable evidence and row-share locks',()=>{
 assert.equal(parseV3FeeSource(source),uuid);
 assert.match(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL,/FOR SHARE OF g,e/);
 assert.match(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL,/g\.revoked_at IS NULL/);
 assert.match(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL,/e\.source_digest=\$8/);
 assert.match(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL,/g\.release_commit_sha=\$12/);
 assert.match(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL,/p\.fee_policy_version=\$9/);
 assert.match(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL,/lease\.fencing_token=\$6/);
});
test('reduce-only exact IOC is passed once only after account and issuer checks',async()=>{
 const h=harness();const response=await send(h,order(true));
 assert.equal(response.status,200);assert.equal(h.sends,1);assert.equal(h.statements.length,1);
 assert.deepEqual(h.statements[0].params?.slice(-2),[uuid,sha]);
});
test('entry requires protected standing grant and refuses absent or revoked lease',async()=>{
 const without=harness({standing:false});await assert.rejects(send(without,order(false)),/standing_entry_authority_not_current/);
 assert.equal(without.sends,0);
 const withoutHistory=harness({history:false});await assert.rejects(send(withoutHistory,order(false)),/standing_entry_authority_not_current/);
 assert.equal(withoutHistory.sends,0);
});
test('missing locked fee authority or missing current provider proof cannot send',async()=>{
 const noRows=harness({lockRows:0});await assert.rejects(send(noRows,order(true)),/final_account_or_source_closed/);
 assert.equal(noRows.sends,0);
 const noProof=harness({providerOk:false});await assert.rejects(send(noProof,order(true)),/current_provider_evidence_unverified/);
 assert.equal(noProof.sends,0);
});
test('wrong ticker, bad order, unsupported order endpoint and no ledger transaction refuse',async()=>{
 const h=harness();
 await assert.rejects(send(h,{...order(true),ticker:'DIFFERENT'}),/wrong_exchange_or_market/);
 await assert.rejects(send(h,{...order(true),count:'-1.00'}),/order_shape_invalid/);
 await assert.rejects(h.fee('https://example.com/orders',{method:'POST',body:JSON.stringify(order(true))}),/order_endpoint_invalid/);
 assert.equal(h.sends,0);
 const noTx=createGuardedOwnerV3FeeFetch(owner,account,source,(async()=>{throw Error('must not send')}) as typeof fetch,policy,fingerprint,12,'holder',digest,{borrowTransaction:()=>null,sha:()=>sha,verify:verify as never});
 await assert.rejects(noTx('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{method:'POST',body:JSON.stringify(order(true))}),/final_executor_transaction_required/);
});
test('transport errors after one POST are not swallowed or retried',async()=>{
 let calls=0;const transport=(async()=>{calls++;throw Error('unknown_provider_outcome');}) as typeof fetch;
 const tx={query:async()=>({rows:[{id:account}]})};
 const fee=createGuardedOwnerV3FeeFetch(owner,account,source,transport,policy,fingerprint,12,'holder',digest,{borrowTransaction:()=>tx as never,sha:()=>sha,verify:verify as never});
 await assert.rejects(fee('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{method:'POST',body:JSON.stringify(order(true))}),/unknown_provider_outcome/);
 assert.equal(calls,1);
});
