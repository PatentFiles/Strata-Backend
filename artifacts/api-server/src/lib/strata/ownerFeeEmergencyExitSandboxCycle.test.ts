import assert from "node:assert/strict";
import test from "node:test";
import {exerciseSandboxExitAfterUnknown,type SandboxSignedTransport} from "./ownerFeeEmergencyExitSandboxCycle";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

const ID="v13p-33333333-3333-4333-8333-333333333333";
const TICKER="KXBTC15M-26OCT161945-45";
const order:EmergencyExitOrder={
  ticker:TICKER,side:"ask",count:"2.00",price:"0.5500",client_order_id:ID,
  time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",
  post_only:false,reduce_only:true,subaccount:1,exchange_index:2,
};
const marked=async()=>({unknownRecorded:true as const,mayRetry:false as const,
  transportAuthorized:false as const,clientOrderId:ID});
function observation(fill="2.00",remaining="0.00"):IocRecoveryObservation{
  return {
    clientOrderId:ID,requestedCountFp:"2.00",marketTicker:TICKER,
    positionMarketTicker:TICKER,initialPositionFp:"3.00",
    observedPositionFp:(3-Number(fill)).toFixed(2),reducingBookSide:"ask",
    completeExchangeHistory:true,exactMarketAndAccountMatched:true,
    orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
    response:{httpStatus:201,order_id:"88888888-8888-4888-8888-888888888888",
      client_order_id:ID,fill_count:fill,remaining_count:remaining,ts_ms:1234567890},
  };
}
function sandbox(options:{
  fill?:string;remaining?:string;
  failSubmit?:boolean;failRead?:boolean;badIdentity?:boolean;
  invalidHistory?:boolean;badReceipt?:boolean;
}={}){
  let submitted=0,reads=0;
  const transport:SandboxSignedTransport={
    environment:"KALSHI_SANDBOX",
    submitSignedIocOnce:async()=>{
      submitted++;
      if(options.failSubmit)throw Error("timeout_after_possible_fill");
      return observation(options.fill??"2.00",options.remaining??"0.00").response;
    },
    readVerifiedPostOrder:async()=>{
      reads++;
      if(options.failRead)throw Error("exchange_feed_unavailable");
      const o=observation(options.fill??"2.00",options.remaining??"0.00");
      if(options.badIdentity)o.clientOrderId="wrong-client";
      if(options.invalidHistory)o.orderAndFillHistoryMatched=false;
      if(options.badReceipt && o.response)o.response={...o.response,order_id:"different-order"};
      return o;
    },
  };
  return {transport,stats:()=>({submitted,reads})};
}
test("zero partial and complete sandbox IOC fills reconcile without granting production authority",async()=>{
  for(const [filled,remaining] of [["0.00","2.00"],["0.50","1.50"],["2.00","0.00"]]){
    const x=sandbox({fill:filled,remaining});
    const result=await exerciseSandboxExitAfterUnknown({order,durableMarker:marked,sandbox:x.transport});
    assert.equal(result.state,"RECONCILED");
    assert.equal(result.filledHundredths,String(Math.round(Number(filled)*100)));
    assert.equal(result.tradingAuthorized,false);
    assert.equal(result.productionOrderSubmitted,false);
    assert.equal(result.mayRetry,false);
    assert.deepEqual(x.stats(),{submitted:1,reads:1});
  }
});
test("no durable UNKNOWN marker, wrong scope, or malformed identity means zero POST calls",async()=>{
  for(const bad of [
    {marker:async()=>({...await marked(),unknownRecorded:false})},
    {marker:async()=>({...await marked(),clientOrderId:"different"})},
    {marker:async()=>{throw Error("ambiguous_commit");}},
  ]){
    const x=sandbox();
    const result=await exerciseSandboxExitAfterUnknown({order,durableMarker:bad.marker,sandbox:x.transport});
    assert.equal(result.state,"BLOCKED");assert.equal(x.stats().submitted,0);
  }
  for(const bad of [{...order,reduce_only:false},{...order,exchange_index:1},
    {...order,time_in_force:"good_till_canceled"}]){
    const x=sandbox();
    const result=await exerciseSandboxExitAfterUnknown({
      order:bad,durableMarker:marked,sandbox:x.transport});
    assert.equal(result.state,"BLOCKED");assert.equal(x.stats().submitted,0);
  }
});
test("timeouts, missing history, identity mismatch or malformed fills become UNKNOWN with no retry",async()=>{
  for(const options of [
    {failSubmit:true},{failRead:true},{badIdentity:true},
    {invalidHistory:true},{badReceipt:true},{fill:"1.00",remaining:"0.00"}
  ]){
    const x=sandbox(options);
    const result=await exerciseSandboxExitAfterUnknown({order,durableMarker:marked,sandbox:x.transport});
    assert.equal(result.state,"UNKNOWN");
    assert.equal(result.mayRetry,false);assert.equal(result.productionOrderSubmitted,false);
    assert.equal(x.stats().submitted,1);
  }
});
test("NO position requires bid; wrong side never counts as reconciled",async()=>{
  const x=sandbox();
  const result=await exerciseSandboxExitAfterUnknown({
    order:{...order,side:"bid"},durableMarker:marked,sandbox:x.transport,
  });
  assert.equal(result.state,"UNKNOWN");
  assert.equal(x.stats().submitted,1);
});
