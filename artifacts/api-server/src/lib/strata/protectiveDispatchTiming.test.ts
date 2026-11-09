// Deterministic control-flow regression coverage. Runtime clocks/thresholds are unchanged.
// SQL doubles model the exact named temporal predicates; this is not native PG evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,Sign} from 'node:crypto';
import {dispatchReviewedProtectiveExitOnce} from './ownerFeeEmergencyExitSignedDispatch';
import {markOwnedEmergencyExitUnknownForReview} from './ownerFeeEmergencyExitUnknownCommit';
import {verifyReviewedProtectiveExitFee,verifyReviewedProtectiveExitFeeAuthority} from './reviewedProtectiveExitFee';
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from '@workspace/v13-strategy';
const base=Date.parse('2026-11-09T00:00:00Z'),owner='11111111-1111-4111-8111-111111111111',account='protective-test';
const reservation='22222222-2222-4222-8222-222222222222',grant='33333333-3333-4333-8333-333333333333';
const client='v13p-44444444-4444-4444-8444-444444444444',market='KXBTC15M-26NOV031945-45',sha='a'.repeat(40);
const material={keyId:'ephemeral-clock-diagnosis-only',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}).toString()};
const order={ticker:market,client_order_id:client,side:'ask',count:'2.00',price:'0.5500',time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2};
const input={ownerId:owner,accountId:account,reservationId:reservation,material,order,lease:{holderId:'worker',fencingToken:8}};
type Case={name:string;authorityDelay?:number;authorityError?:boolean;providerDeliveryDelay?:number;wallRollback?:boolean;advisoryDelay?:number;advisoryFuture?:boolean;reservationAge?:number;poolWait?:number;markerSqlError?:boolean;commitAckLost?:boolean;signDelay?:number;expectedFee:1|2;expectedMarker?:string;expectedFeeReason?:string};
const cases:Case[]=[
 {name:'fresh-control',expectedFee:2},
 ...[4999,5000,5001].map(ms=>({name:'first-authority-latency-'+ms,authorityDelay:ms,expectedFee:(ms<5000?2:1) as 1|2,...(ms>=5000?{expectedMarker:'emergency_exit_unknown_position_or_fence_unavailable'}:{})})),
 ...[3000,3001].map(ms=>({name:'provider-delivery-latency-'+ms,providerDeliveryDelay:ms,expectedFee:(ms<=3000?2:1) as 1|2,...(ms>3000?{expectedFeeReason:'protective_fee_provider_metadata_unverified'}:{})})),
 {name:'initial-wall-clock-rollback',wallRollback:true,expectedFee:1,expectedFeeReason:'protective_fee_clock_invalid'},
 {name:'initial-authority-query-error',authorityError:true,expectedFee:1,expectedFeeReason:'protective_fee_historic_review_unavailable'},
 ...[3000,3001].map(ms=>({name:'advisory-delivery-latency-'+ms,advisoryDelay:ms,expectedFee:(ms<=3000?2:1) as 1|2,...(ms>3000?{expectedMarker:'emergency_exit_unknown_authenticated_baseline_unverified'}:{})})),
 ...[4999,5000,5001].map(ms=>({name:'marker-checkout-latency-'+ms,poolWait:ms,expectedFee:(ms<5000?2:1) as 1|2,...(ms>=5000?{expectedMarker:'emergency_exit_unknown_position_or_fence_unavailable'}:{})})),
 {name:'advisory-future-timestamp',advisoryFuture:true,expectedFee:1,expectedMarker:'emergency_exit_unknown_authenticated_baseline_unverified'},
 ...[29999,30000,30001].map(ms=>({name:'reservation-age-'+ms,reservationAge:ms,expectedFee:(ms<30000?2:1) as 1|2,...(ms>=30000?{expectedMarker:'emergency_exit_unknown_position_or_fence_unavailable'}:{})})),
 {name:'marker-sql-error',markerSqlError:true,expectedFee:1,expectedMarker:'emergency_exit_unknown_persistence_unverified'},
 {name:'marker-commit-acknowledgment-lost',commitAckLost:true,expectedFee:1,expectedMarker:'emergency_exit_unknown_persistence_unverified'},
 {name:'virtual-signing-delay-3001',signDelay:3001,expectedFee:2},
 {name:'virtual-signing-delay-3100',signDelay:3100,expectedFee:2},
];
for(const spec of cases)test(spec.name,async t=>{
 let wall=base,monotonic=100,dbClock=base;
 const advance=(ms:number)=>{wall+=ms;monotonic+=ms;dbClock+=ms;};
 let feeCalls=0,providerCalls=0,markerCalls=0,connections=0,signCalls=0,posts=0,fetchAttempts=0,phase='PREPARED';
 let markerOutcome:any=null,firstProof:any=null;
 const events:string[]=[],sqlErrors:Array<{code:string;message:string}>=[];
 t.mock.method(performance,'now',()=>monotonic);
 t.mock.method(globalThis,'fetch',async()=>{fetchAttempts++;throw Error('clock_regression_fetch_must_not_run');});
 const authorityDb={query:async(sql:string)=>{
  if(sql.includes('AS standing_history'))return {rows:[{standing_history:true}]};
  if(sql.includes('SELECT d.delegation_id'))return {rows:[{delegation_id:grant,model_id:grant,release_id:grant,valid_for_ms:3_000_000}]};
  assert.ok(sql.includes('AS grant_id'));
  if(feeCalls===1){advance(spec.authorityDelay??0);if(spec.authorityError)throw Error('synthetic_authority_query_failed');}
  return {rows:[{grant_id:grant,review_id:grant,consent_id:grant,policy_hash:'b'.repeat(64),valid_for_ms:3_000_000,legacy_valid:false}]};
 }};
 const db={connect:async()=>{
  connections++;
  if(connections===1)advance(spec.poolWait??0);
  let transactionStart=NaN;
  return {release:()=>events.push('release'),query:async(sql:string)=>{
   events.push(sql);
   if(sql==='BEGIN'){transactionStart=dbClock;return {rows:[]};}
   if(sql==='COMMIT'){
    if(connections===1&&spec.commitAckLost){sqlErrors.push({code:'synthetic_ack_lost',message:'committed but acknowledgment lost'});throw Error('synthetic_ack_lost');}
    return {rows:[]};
   }
   if(sql==='ROLLBACK'||sql.startsWith('SET LOCAL'))return {rows:[]};
   if(sql.startsWith('SELECT id FROM public.v13_production_account'))return {rows:[{id:account}]};
   if(sql.includes('FOR UPDATE OF r,a,w,pos,fi')){
    assert.ok(sql.includes("w.heartbeat_at > now()-interval '5 seconds'"));
    assert.ok(sql.includes("r.created_at > now()-interval '30 seconds'"));
    if(spec.markerSqlError){sqlErrors.push({code:'57014',message:'synthetic_marker_statement_timeout'});throw Error('synthetic_marker_statement_timeout');}
    const eligible=base>transactionStart-5000&&base-(spec.reservationAge??0)>transactionStart-30000&&phase==='PREPARED';
    return {rows:eligible?[{reservation_id:reservation,client_order_id:client}]:[]};
   }
   if(sql.startsWith('UPDATE private.strata_emergency_exit_reservations SET state=\'UNKNOWN\'')){
    assert.equal(phase,'PREPARED');phase='UNKNOWN';return {rows:[{reservation_id:reservation,client_order_id:client}]};
   }
   if(sql.startsWith("UPDATE public.v13_production_intent SET state='DISPATCHED'"))return {rows:[{client_order_id:client}]};
   if(sql.startsWith('SELECT release_id FROM private.strata_standing_execution_reviews')||sql.startsWith('SELECT r.release_id'))return {rows:[{release_id:grant}]};
   if(sql.includes('AS reservation_age_ms'))return {rows:spec.signDelay===undefined?[]:[{reservation_id:reservation,reservation_age_ms:0,heartbeat_age_ms:0,source_age_ms:0,max_quote_age_ms:5000,release_remaining_ms:null,owned_evaluation:{sourcePaperEvaluationId:'source',source:{id:'source',market_ticker:market,evaluated_at:new Date(base).toISOString(),feed_freshness:'current',strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0}}}]};
   if(sql.startsWith('SELECT execution_account_id FROM private.kalshi_account_worker_lease'))return {rows:[{execution_account_id:account}]};
   if(sql.includes('AS intent_id'))return {rows:[{reservation_id:reservation,intent_id:'exit'}]};
   if(sql.startsWith('INSERT INTO private.strata_protective_exit_local_no_send'))return {rows:[{reservation_id:reservation}]};
   if(sql.startsWith("UPDATE public.v13_production_intent SET state='BLOCKED'"))return {rows:[{id:'exit'}]};
   if(sql.startsWith("UPDATE private.strata_emergency_exit_reservations SET state='VOID'")){phase='VOID';return {rows:[{reservation_id:reservation}]};}
   throw Error('unmodeled_sql:'+sql);
  }};
 }};
 if(spec.signDelay!==undefined){
  const sign=Sign.prototype.sign;
  t.mock.method(Sign.prototype,'sign',function(this:Sign,...args:any[]){
   assert.equal(feeCalls,2,'signing can only begin after both verifications');
   const signed=(sign as any).apply(this,args);signCalls++;advance(spec.signDelay!);return signed;
  });
 }
 const ports={db,monotonicNow:()=>monotonic,
  verifyFee:async()=>{
   feeCalls++;
   const proof=await verifyReviewedProtectiveExitFee(owner,account,market,{db:authorityDb,sha:()=>sha,now:()=>wall,readFee:async()=>{
    providerCalls++;const observedAtMs=wall;
    if(feeCalls===1){advance(spec.providerDeliveryDelay??0);if(spec.wallRollback)wall-=1;}
    return {ok:true,marketTicker:market,marketOpen:true,observedAtMs,fingerprint:'c'.repeat(64)} as never;
   }});
   if(feeCalls===1)firstProof=proof;return proof;
  },
  verifyFeeAuthority:async()=>verifyReviewedProtectiveExitFeeAuthority(owner,account,sha,authorityDb),
  mark:async()=>{
   markerCalls++;
   markerOutcome=await markOwnedEmergencyExitUnknownForReview(owner,account,reservation,material,order as never,input.lease,{db,now:()=>wall,inspect:async()=>{
    const observed=wall;advance(spec.advisoryDelay??0);
    return {diagnosticEligible:true,tradingAuthorized:false,verifiedPositionFp:'3.00',verifiedPositionObservedAtMs:observed+(spec.advisoryFuture?1:0)} as never;
   }});return markerOutcome;
  },
  ...(spec.signDelay===undefined?{post:async()=>{posts++;throw Error('test_post_must_not_be_reached');}}:{}),
 };
 const result=await dispatchReviewedProtectiveExitOnce(input,ports as never);
 const firstDispatch={feeCalls,providerCalls,markerCalls,connections,signCalls,markerOutcome,result};
 let repeatDispatch:unknown=null;
 assert.equal(feeCalls,spec.expectedFee);
 assert.equal(posts,0);assert.equal(fetchAttempts,0);assert.equal(result.postAttempted,false);assert.equal(result.mayRetry,false);assert.equal(result.tradingAuthorized,false);
 if(spec.expectedFeeReason){
  assert.equal(firstProof.reason,spec.expectedFeeReason);assert.equal(markerCalls,0);
  assert.equal(result.reason,'protective_exit_monetary_fees_unverified');
 }else{
  assert.equal(firstProof.ok,true);assert.equal(markerCalls,1);
  assert.equal(markerOutcome.reason,spec.expectedMarker??'emergency_exit_unknown_committed_no_transport_authority');
  assert.equal(markerOutcome.unknownRecorded,spec.expectedFee===2);
 }
 if(spec.expectedMarker)assert.equal(result.reason,'protective_exit_unknown_marker_unverified');
 if(spec.signDelay!==undefined){
  assert.equal(signCalls,1);assert.equal(phase,'VOID');assert.equal(result.state,'BLOCKED');
  assert.equal(result.reason,'protective_exit_proven_not_posted_refresh_required');
 }else if(spec.expectedFee===2){
  assert.equal(signCalls,0);assert.equal(phase,'UNKNOWN');assert.equal(result.reason,'protective_exit_final_fence_closed');
 }
 if(spec.signDelay!==undefined){
  const beforeAudits=events.filter(s=>s.startsWith('INSERT INTO private.strata_protective_exit_local_no_send')).length;
  assert.equal(beforeAudits,1);
  const repeated=await dispatchReviewedProtectiveExitOnce(input,ports as never);
  repeatDispatch={feeCalls,providerCalls,markerCalls,connections,signCalls,markerOutcome,result:repeated};
  assert.equal(feeCalls,spec.expectedFee+1);assert.equal(signCalls,1);assert.equal(posts,0);assert.equal(fetchAttempts,0);assert.equal(phase,'VOID');
  assert.equal(repeated.postAttempted,false);assert.equal(repeated.mayRetry,false);assert.equal(repeated.tradingAuthorized,false);
  assert.equal(events.filter(s=>s.startsWith('INSERT INTO private.strata_protective_exit_local_no_send')).length,beforeAudits);
 }
 console.info('PROTECTIVE_CLOCK_CASE '+JSON.stringify({name:spec.name,firstDispatch,repeatDispatch,posts,fetchAttempts,firstProofReason:firstProof.reason,phase,sqlErrors,virtualElapsedMs:monotonic-100}));
});
