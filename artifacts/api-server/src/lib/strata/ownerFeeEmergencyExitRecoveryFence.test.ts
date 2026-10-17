import assert from "node:assert/strict";
import test from "node:test";
import {inspectExitRecoveryTransition,type EmergencyRecoveryRecord} from "./ownerFeeEmergencyExitRecoveryFence";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

const rec:EmergencyRecoveryRecord={
  reservationId:"11111111-1111-4111-8111-111111111111",
  ownerUserId:"22222222-2222-4222-8222-222222222222",
  accountId:"owner-account-2",
  marketTicker:"KXBTC15M-26OCT161945-45",
  clientOrderId:"v13p-33333333-3333-4333-8333-333333333333",
  orderDigest:"a".repeat(64),
  workerFencingToken:7,
  initialPositionFp:"2.00",
  requestedCountFp:"1.00",
  reducingBookSide:"ask",
  phase:"PREPARED",attemptRecorded:false,
};
const first={kind:"begin_attempt" as const,reservationId:rec.reservationId,
  ownerUserId:rec.ownerUserId,accountId:rec.accountId,
  orderDigest:rec.orderDigest,workerFencingToken:rec.workerFencingToken};
function observation(fill:string,finish:string):IocRecoveryObservation{
  const remaining=(1-Number(fill)).toFixed(2);
  return {
    clientOrderId:rec.clientOrderId,requestedCountFp:rec.requestedCountFp,
    marketTicker:rec.marketTicker,positionMarketTicker:rec.marketTicker,
    initialPositionFp:rec.initialPositionFp,observedPositionFp:finish,
    reducingBookSide:rec.reducingBookSide,completeExchangeHistory:true,
    exactMarketAndAccountMatched:true,orderAndFillHistoryMatched:true,
    isolatedPositionDelta:true,
    response:{httpStatus:201,order_id:"exchange-confirmed",
      client_order_id:rec.clientOrderId,fill_count:fill,
      remaining_count:remaining,ts_ms:1792200000000},
  };
}
function fenced(){
  const v=inspectExitRecoveryTransition(rec,first);
  assert.equal(v.changed,true);
  assert.equal(v.record.phase,"UNKNOWN");
  assert.equal(v.record.attemptRecorded,true);
  assert.equal(v.transportAuthorized,false);
  assert.equal(v.tradingAuthorized,false);
  assert.equal(v.mayRetry,false);
  return v.record;
}
test("before-transport phase is UNKNOWN; duplicate/restart attempt denied",()=>{
  const x=fenced();
  const again=inspectExitRecoveryTransition(x,first);
  assert.equal(again.changed,false);
  assert.equal(again.record.phase,"UNKNOWN");
  assert.equal(again.mayRetry,false);
  for(const mutation of [
    {...first,workerFencingToken:8}, {...first,reservationId:"44444444-4444-4444-8444-444444444444"},
    {...first,ownerUserId:"55555555-5555-4555-8555-555555555555"},
    {...first,orderDigest:"b".repeat(64)},
    {...first,accountId:"different-account"},
  ]){
    const wrong=inspectExitRecoveryTransition(rec,mutation);
    assert.equal(wrong.changed,false);
    assert.equal(wrong.transportAuthorized,false);
  }
});
test("zero, partial and full IOC fills reconcile terminally but NEVER permit another POST",()=>{
  for(const [fill,pos] of [["0.00","2.00"],["0.50","1.50"],["1.00","1.00"]]){
    const state=fenced();
    const observed=inspectExitRecoveryTransition(state,
      {kind:"exchange_observation",observation:observation(fill!,pos!)});
    assert.equal(observed.record.phase,"RECONCILED");
    assert.equal(observed.changed,true);
    assert.equal(observed.mayRetry,false);
    assert.equal(observed.transportAuthorized,false);
    assert.equal(inspectExitRecoveryTransition(observed.record,first).changed,false);
  }
});
test("timeout, 429/5xx, inconsistent fills, incomplete history or foreign receipt remain UNKNOWN",()=>{
  const state=fenced();
  const good=observation("0.50","1.50");
  const bad:IocRecoveryObservation[]=[
    {...good,response:null},{...good,response:{...good.response!,httpStatus:429}},
    {...good,response:{...good.response!,httpStatus:500}},
    {...good,response:{...good.response!,remaining_count:"0.70"}},
    {...good,completeExchangeHistory:false},
    {...good,orderAndFillHistoryMatched:false},
    {...good,isolatedPositionDelta:false},
    {...good,clientOrderId:"v13p-44444444-4444-4444-8444-444444444444"},
    {...good,marketTicker:"KXBTC15M-OTHER"},
    {...good,observedPositionFp:"-0.50"},
  ];
  for(const x of bad){
    const d=inspectExitRecoveryTransition(state,{kind:"exchange_observation",observation:x});
    assert.equal(d.changed,false);
    assert.equal(d.record.phase,"UNKNOWN");
    assert.equal(d.mayRetry,false);
    assert.equal(d.transportAuthorized,false);
  }
});
test("malformed or forged reservation state never advances, even on matching event",()=>{
  for(const invalid of [
    {...rec,workerFencingToken:0},
    {...rec,phase:"UNKNOWN" as const,attemptRecorded:false},
    {...rec,phase:"PREPARED" as const,attemptRecorded:true},
    {...rec,orderDigest:"not-a-sha"},
    {...rec,requestedCountFp:"1e3"},
    {...rec,initialPositionFp:"NaN"},
  ]){
    const d=inspectExitRecoveryTransition(invalid,first);
    assert.equal(d.changed,false);
    assert.equal(d.transportAuthorized,false);
  }
});
test("a prepared reservation cannot be reconciled without any dispatch attempt",()=>{
  const d=inspectExitRecoveryTransition(rec,
    {kind:"exchange_observation",observation:observation("1.00","1.00")});
  assert.equal(d.changed,false);
  assert.equal(d.record.phase,"PREPARED");
});
