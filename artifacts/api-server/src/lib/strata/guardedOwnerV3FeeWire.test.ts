import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuardedOwnerV3FeeFetch,FINAL_OWNER_V3_ACCOUNT_FENCE_SQL} from './guardedOwnerV3FeeWire';
import {parseV3FeeSource} from './ownerFeeV3Authority';

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
const verifyStanding=async()=>({
 ok:true as const,reason:'owner_standing_monetary_fee_current' as const,
 monetaryFeeAuthorized:true as const,tradingAuthorized:false as const,
 ordersSubmitted:false as const,workerStarted:false as const,
 identity:{consentId:uuid,ownerId:owner,accountId:account,sourceAuthorityId:uuid,
  sourceUrl:source,sourceDigest:digest,sha,policyHash:policy,marketTicker:ticker,
  verifiedAtMs:Date.now(),validUntil:new Date(Date.now()+60000).toISOString()},
});
const verifyExit=async()=>({
 ok:true as const,reason:'owner_protective_issuer_fee_verified' as const,
 sourceDigest:digest,verifiedAtMs:Date.now(),monetaryFeeAuthorized:true as const,
 tradingAuthorized:false as const,ordersSubmitted:false as const,workerStarted:false as const,
});
function harness(params:{lockRows?:number;providerOk?:boolean;standing?:boolean;
 history?:boolean;exitReview?:boolean;expiredEntryConsent?:boolean}={}){
 let sends=0;const statements:{sql:string;params?:unknown[]}[]=[];
 const tx={query:async(sql:string,p?:unknown[])=>{
   statements.push({sql,params:p});return{rows:params.lockRows===0?[]:[{id:account}]};
 }};
 const underlying=(async()=>{sends++;return new Response('{"accepted":true}',{status:200});}) as typeof fetch;
 const fee=createGuardedOwnerV3FeeFetch(owner,account,source,underlying,policy,fingerprint,12,'holder',digest,{
  borrowTransaction:()=>tx as never,sha:()=>sha,
  verifyStanding:(async()=>params.providerOk===false||params.expiredEntryConsent===true
   ?{ok:false,reason:'owner_standing_fee_expired'}:verifyStanding()) as never,
  verifyProtective:(async()=>params.providerOk===false
   ?{ok:false,reason:'issuer_unavailable'}:verifyExit()) as never,
  exitReview:async()=>params.exitReview??true,
  hasHistory:async()=>params.history??true,
  currentStanding:async()=>params.standing??true,
 });
 return {fee,tx,statements,get sends(){return sends;}};
}
const send=async(h:ReturnType<typeof harness>,body:unknown)=>
 h.fee('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{
  method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'},
 });
test('immutable short V3 source provenance and separately consented standing model are distinct',()=>{
 assert.equal(parseV3FeeSource(source),uuid);
 for(const fragment of ['FOR SHARE OF g,e','FOR SHARE OF s','g.release_commit_sha=$12',
  's.expires_at>clock_timestamp()','s.revoked_at IS NULL',
  's.approved_policy_hash=p.policy_hash','p.fee_policy_version=$9',
  'lease.fencing_token=$6','NOT $13::boolean'])
  assert.ok(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL.includes(fragment),fragment);
});
test('genuine reduce-only exact-market IOC passes once even after entry consent expires',async()=>{
 const h=harness({expiredEntryConsent:true});
 const response=await send(h,order(true));
 assert.equal(response.status,200);assert.equal(h.sends,1);
 assert.equal(h.statements.length,1);
 assert.deepEqual(h.statements[0].params?.slice(-3),[uuid,sha,false]);
});
test('expired fee standing consent and revoked technical lease forbid new entry',async()=>{
 const prior=process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
 process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';
 try{
  const expired=harness({expiredEntryConsent:true});
  await assert.rejects(send(expired,order(false)),/current_provider_evidence_unverified/);
  assert.equal(expired.sends,0);
  const revoked=harness({standing:false});
  await assert.rejects(send(revoked,order(false)),/standing_entry_authority_not_current/);
  assert.equal(revoked.sends,0);
  const missingHistory=harness({history:false});
  await assert.rejects(send(missingHistory,order(false)),/standing_entry_authority_not_current/);
  assert.equal(missingHistory.sends,0);
  const allowed=harness();const r=await send(allowed,order(false));
  assert.equal(r.status,200);assert.equal(allowed.sends,1);
  assert.deepEqual(allowed.statements[0].params?.slice(-3),[uuid,sha,true]);
 }finally{
  if(prior===undefined)delete process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
  else process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=prior;
 }
});
test('protective exit requires current technical review and genuine issuer evidence',async()=>{
 const noCode=harness({exitReview:false});
 await assert.rejects(send(noCode,order(true)),/protective_exit_technical_review_missing/);
 assert.equal(noCode.sends,0);
 const noIssuer=harness({providerOk:false});
 await assert.rejects(send(noIssuer,order(true)),/protective_exit_current_fee_unverified/);
 assert.equal(noIssuer.sends,0);
 const noLockedSource=harness({lockRows:0});
 await assert.rejects(send(noLockedSource,order(true)),/final_account_or_source_closed/);
 assert.equal(noLockedSource.sends,0);
});
test('wrong ticker, order format, foreign signed origin and no transaction refuse',async()=>{
 const h=harness();
 await assert.rejects(send(h,{...order(true),ticker:'WRONG'}),/wrong_exchange_or_market/);
 await assert.rejects(send(h,{...order(true),count:'-1.00'}),/order_shape_invalid/);
 await assert.rejects(h.fee('https://example.com/orders',{method:'POST',body:JSON.stringify(order(true))}),/order_endpoint_invalid/);
 await assert.rejects(h.fee('https://malicious.invalid/trade-api/v2/markets/T',{method:'GET'}),/unexpected_read_endpoint/);
 assert.equal(h.sends,0);
 const noTx=createGuardedOwnerV3FeeFetch(owner,account,source,
  (async()=>{throw Error('must never dispatch')}) as typeof fetch,
  policy,fingerprint,12,'holder',digest,
  {borrowTransaction:()=>null,sha:()=>sha});
 await assert.rejects(noTx('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{
  method:'POST',body:JSON.stringify(order(true))}),/final_executor_transaction_required/);
});
test('a provider failure after one signed IOC is UNKNOWN: never retry internally',async()=>{
 let sends=0;
 const transport=(async()=>{sends++;throw Error('unknown_provider_outcome')}) as typeof fetch;
 const tx={query:async()=>({rows:[{id:account}]})};
 const fee=createGuardedOwnerV3FeeFetch(owner,account,source,transport,policy,fingerprint,12,'holder',digest,{
  borrowTransaction:()=>tx as never,sha:()=>sha,verifyProtective:verifyExit as never,exitReview:async()=>true,
 });
 await assert.rejects(fee('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{
  method:'POST',body:JSON.stringify(order(true))}),/unknown_provider_outcome/);
 assert.equal(sends,1);
});
