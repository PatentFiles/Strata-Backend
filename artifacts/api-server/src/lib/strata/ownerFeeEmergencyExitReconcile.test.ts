import assert from "node:assert/strict";
import test from "node:test";
import {reconcileIocEmergencyExit,type IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
const id="v13p-33333333-3333-4333-8333-333333333333";
const market="KXBTC15M-26OCT161945-45";
function sample(filled="1.00",remaining="1.00"):IocRecoveryObservation{
 return {
  clientOrderId:id,marketTicker:market,requestedCountFp:"2.00",
  initialPositionFp:"3.00",observedPositionFp:filled==="0.00"?"3.00":filled==="2.00"?"1.00":"2.00",
  positionMarketTicker:market,reducingBookSide:"ask",
  completeExchangeHistory:true,exactMarketAndAccountMatched:true,
  orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
  response:{httpStatus:201,order_id:"order-123",client_order_id:id,
    fill_count:filled,remaining_count:remaining,ts_ms:1792179900000},
 };
}
test("zero, partial and full IOC fills only reconcile; no retry or trading authority",()=>{
  for(const [fill,rest,expected] of [
    ["0.00","2.00","0"],["1.00","1.00","100"],["2.00","0.00","200"],
  ]){
    const result=reconcileIocEmergencyExit(sample(fill,rest));
    assert.equal(result.state,"RECONCILED");
    assert.equal(result.filledHundredths,expected);
    assert.equal(result.tradingAuthorized,false);
    assert.equal(result.mayRetry,false);
    assert.equal(result.ok,false);
  }
});
test("NO position requires bid and positive actual quantity drop",()=>{
  const x=sample("1.00","1.00");
  x.initialPositionFp="-3.00";x.observedPositionFp="-2.00";x.reducingBookSide="bid";
  assert.equal(reconcileIocEmergencyExit(x).state,"RECONCILED");
  x.reducingBookSide="ask";
  assert.equal(reconcileIocEmergencyExit(x).state,"REJECTED");
});
test("unknown response or error is not zero fill and cannot retry",()=>{
  const x=sample();
  for(const response of [
    null,
    {...x.response,httpStatus:503},
    {...x.response,client_order_id:"foreign"},
    {...x.response,fill_count:"3.00"},
    {...x.response,remaining_count:"9.00"},
    {...x.response,fill_count:"-1.00"},
    {...x.response,ts_ms:0},
  ]){
    const result=reconcileIocEmergencyExit({...x,response:response as typeof x.response});
    assert.equal(result.state,"UNKNOWN");
    assert.equal(result.mayRetry,false);
    assert.equal(result.tradingAuthorized,false);
  }
});
test("unmatched/partial exchange records leave result UNKNOWN and unretryable",()=>{
  const x=sample();
  for(const changes of [
    {completeExchangeHistory:false},
    {exactMarketAndAccountMatched:false},
    {orderAndFillHistoryMatched:false},
    {isolatedPositionDelta:false},
  ]){
    const result=reconcileIocEmergencyExit({...x,...changes});
    assert.equal(result.state,"UNKNOWN");
    assert.equal(result.mayRetry,false);
  }
});
test("phantom position decreases, side reversal or unrelated market cannot reconcile",()=>{
  const x=sample();
  for(const changes of [
    {observedPositionFp:"3.00"},
    {observedPositionFp:"-1.00"},
    {observedPositionFp:"4.00"},
    {observedPositionFp:"abc"},
  ]) assert.equal(reconcileIocEmergencyExit({...x,...changes}).state,"UNKNOWN");
  assert.equal(reconcileIocEmergencyExit({...x,positionMarketTicker:"OTHER"}).state,"REJECTED");
  assert.equal(reconcileIocEmergencyExit({...x,clientOrderId:"client-foreign"}).state,"REJECTED");
  assert.equal(reconcileIocEmergencyExit({...x,reducingBookSide:"bid"}).state,"REJECTED");
});
