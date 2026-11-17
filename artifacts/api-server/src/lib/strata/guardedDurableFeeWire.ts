/** Local candidate adapter, NOT wired to production supervisor. Preserves
 * existing account/lease/credential/technical/order-shape fences. This is
 * additional fee protection, not a replacement for actual position ownership,
 * ledger reservation, reduce-only and UNKNOWN outcome reconciliation. */
import type {PoolClient} from '@workspace/db';
import {checkContinuousEligibility,hasContinuousGrantHistory} from './continuousExecutionAuthorization';
import {checkStandingExitReview} from './standingExecutionReview';
import {deployedGitSha} from './deployedGitSha';
import {FINAL_MONETARY_ACCOUNT_FENCE_SQL} from './guardedMonetaryFeeWire';
import {verifyDurableOwnerFee,DURABLE_FEE_VERSION} from './durableOwnerFeePolicy';
type Tx=Pick<PoolClient,'query'>;
const HEX=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const ORDER_URL='https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders';
export function createGuardedDurableFeeFetch(
 ownerId:string,accountId:string,sourceUrl:string,transport:typeof fetch,
 policyHash:string,keyFingerprint:string,fencingToken:number,holderId:string,feeDigest:string,
 deps:{
  borrowTransaction:()=>Tx|null;
  verifyDurable?:typeof verifyDurableOwnerFee;
  exitReview?:typeof checkStandingExitReview;
  sha?:()=>string;
  currentStanding?:(tx:Tx,owner:string,sha:string)=>Promise<boolean>;
  hasHistory?:(tx:Tx,owner:string,sha:string)=>Promise<boolean>;
 } ,
):typeof fetch{
 const authorityId=/^strata-durable-owner-fee:\/\/([a-f0-9-]{36})$/.exec(sourceUrl)?.[1];
 if(!authorityId||!accountId||!HEX.test(policyHash)||!HEX.test(keyFingerprint)||
  !HEX.test(feeDigest)||!Number.isSafeInteger(fencingToken)||fencingToken<=0||
  !holderId||holderId.length>200||!deps?.borrowTransaction)
  throw Error('owner_v3_fee_account_or_authority_identity_invalid');
 if(process.env.NODE_ENV!=='test'&&
   (deps.verifyDurable||deps.exitReview||deps.sha||
    deps.currentStanding||deps.hasHistory))
  throw Error('owner_v3_fee_production_override_forbidden');
 return async(request,init)=>{
  const method=(init?.method??(request instanceof Request?request.method:'GET')).toUpperCase();
  if(method!=='POST'){
   // Signed Kalshi credentials must never be forwarded to caller-chosen
   // origins or following a cross-host redirect.
   let url:URL;
   try{url=new URL(request instanceof Request?request.url:typeof request==='string'?request:request.toString());}
   catch{throw Error('owner_v3_fee_unexpected_read_endpoint');}
   if(!['GET','HEAD','DELETE'].includes(method)||url.origin!=='https://external-api.kalshi.com'||
     url.username!==''||url.password!==''||
     !/^\/trade-api\/v2\/(?:portfolio|historical|markets|events|series|exchange)(?:\/|$)/.test(url.pathname)||
     /%2f|%5c|%2e|\\\\|\/\//i.test(url.pathname))
     throw Error('owner_v3_fee_unexpected_read_endpoint');
   if(method==='DELETE'&&
     !/^\/trade-api\/v2\/portfolio\/(?:orders|events\/orders)\/[A-Za-z0-9_-]+$/.test(url.pathname))
     throw Error('owner_v3_fee_unexpected_cancel_endpoint');
   return transport(request,{...init,redirect:'error'});
  }
  if(init?.method!=='POST'||typeof request!=='string'||request!==ORDER_URL||
   typeof init.body!=='string')throw Error('owner_v3_fee_order_endpoint_invalid');
  let order:Record<string,unknown>;
  try{
   const parsed:unknown=JSON.parse(init.body);
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('invalid');
   order=parsed as Record<string,unknown>;
  }catch{throw Error('owner_v3_fee_order_body_invalid');}
  const ticker=order.ticker;
  if(typeof ticker!=='string'||!MARKET.test(ticker)||order.subaccount!==1||
   order.exchange_index!==2)throw Error('owner_v3_fee_wrong_exchange_or_market');
  if(order.reduce_only!==true&&order.reduce_only!==false)
   throw Error('owner_v3_fee_reduce_only_unverified');
  if(order.time_in_force!=='immediate_or_cancel'||
   order.self_trade_prevention_type!=='taker_at_cross'||order.post_only!==false||
   order.expiration_time!==undefined||
   typeof order.client_order_id!=='string'||
   !/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(order.client_order_id)||
   (order.side!=='bid'&&order.side!=='ask')||
   typeof order.count!=='string'||!/^\d{1,9}\.\d{2}$/.test(order.count)||
   !Number.isFinite(Number(order.count))||Number(order.count)<=0||
   typeof order.price!=='string'||!/^0\.\d{4}$/.test(order.price)||
   Number(order.price)<=0)
   throw Error('owner_v3_fee_order_shape_invalid');
  const sha=(deps.sha??deployedGitSha)();
  if(!SHA.test(sha))throw Error('owner_v3_fee_current_release_sha_unavailable');
  const tx=deps.borrowTransaction();
  if(!tx)throw Error('owner_v3_fee_final_executor_transaction_required');
  const isEntry=order.reduce_only===false;
  // A revoked or expired standing ENTRY grant can never acquire new
  // inventory. Risk-reducing exits retain a separate genuinely verified
  // fee-source path; neither mode is approved by the caller's boolean alone.
  if(isEntry){
   if(process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=='true')
    throw Error('owner_v3_protective_exit_release_disabled');
   const history=await (deps.hasHistory??hasContinuousGrantHistory)(tx,ownerId,sha);
   const authorized=history&&await (deps.currentStanding??checkContinuousEligibility)(tx,ownerId,sha);
   if(!authorized)throw Error('owner_v3_standing_entry_authority_not_current');
  }else{
   // An exit still requires a genuine, unrevoked current owner technical
   // review of the exact code. It does NOT require a standing ENTRY lease.
   const approved=await (deps.exitReview??checkStandingExitReview)(tx,ownerId,accountId,sha);
   if(!approved)throw Error('owner_v3_protective_exit_technical_review_missing');
  }
  const locked=await tx.query(FINAL_MONETARY_ACCOUNT_FENCE_SQL,[
   ownerId,accountId,keyFingerprint,policyHash,sourceUrl,fencingToken,holderId,
   feeDigest,DURABLE_FEE_VERSION,'standard-quadratic-0.07-v1'
  ]);
  if(locked.rows.length!==1)throw Error('owner_v3_fee_final_account_or_source_closed');
  const proof=await (deps.verifyDurable??verifyDurableOwnerFee)(tx as never,
    {owner:ownerId,account:accountId,sha,policyHash},ticker,isEntry?'ENTRY':'PROTECTIVE_EXIT');
  if(!proof.ok||!proof.sourceFresh()||proof.sourceDigest!==feeDigest||proof.marketTicker!==ticker||
     Date.now()<proof.verifiedAtMs||Date.now()-proof.verifiedAtMs>5000)
    throw Error('durable_fee_final_fresh_model_unverified');
  // Transport is called exactly once. Any error after invocation is UNKNOWN;
  // the caller's ledger must reconcile it, never blindly resubmit.
  return transport(request,{...init,redirect:'error'});
 };
}
