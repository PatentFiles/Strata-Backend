import assert from "node:assert/strict";
import test from "node:test";
import {simulateEmergencyExit,type ExitDryRunScenario} from "./ownerFeeEmergencyExitDryRun";
import type {EmergencyExitOrder,EmergencyExitEvidence} from "./ownerFeeEmergencyExit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
const OWNER="11111111-1111-4111-8111-111111111111";
const MARKET="KXBTC15M-26OCT161945-45";
const NOW=Date.parse("2026-10-16T20:15:00Z");
const CLIENT="v13p-22222222-2222-4222-8222-222222222222";
function fixture(fill:"0.00"|"1.00"|"2.00"="1.00"):ExitDryRunScenario {
  const order:EmergencyExitOrder={ticker:MARKET,side:"ask",count:"2.00",price:"0.5600",
    client_order_id:CLIENT,reduce_only:true,time_in_force:"immediate_or_cancel",
    post_only:false,subaccount:1,exchange_index:2};
  const evidence:EmergencyExitEvidence={authenticatedOwnerId:OWNER,accountOwnerId:OWNER,
    accountSubaccount:1,accountExchangeIndex:2,signerVerified:true,
    globalKillActive:false,accountKillActive:false,executionEnabled:true,
    positionsComplete:true,positionMarket:MARKET,positionFp:"3.00",
    positionsObservedAtMs:NOW-100,restingOrderCount:0,uncertainOrderCount:0,
    kalshiFee:{source:"kalshi_live_api",market:MARKET,fingerprint:"a".repeat(64),
      observedAtMs:NOW-100,feeType:"quadratic",feeMultiplier:1,
      marketOpen:true,noUnverifiedOverridesOrChanges:true}};
  const left=fill==="0.00"?"2.00":fill==="1.00"?"1.00":"0.00";
  const position=fill==="0.00"?"3.00":fill==="1.00"?"2.00":"1.00";
  const obs:IocRecoveryObservation={clientOrderId:CLIENT,requestedCountFp:"2.00",
    marketTicker:MARKET,initialPositionFp:"3.00",observedPositionFp:position,
    positionMarketTicker:MARKET,reducingBookSide:"ask",completeExchangeHistory:true,
    exactMarketAndAccountMatched:true,orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
    response:{httpStatus:201,order_id:"order-test",client_order_id:CLIENT,
      fill_count:fill,remaining_count:left,ts_ms:NOW+100}};
  return {ownerId:OWNER,order,evidence,observedAtMs:NOW,exchangeObservation:obs};
}
test("zero, partial and full fill offline lifecycle never sends or authorizes a live order",()=>{
  for(const fill of ["0.00","1.00","2.00"] as const){
    const result=simulateEmergencyExit(fixture(fill));
    assert.equal(result.advisory.diagnosticEligible,true);
    assert.equal(result.reconciliation?.state,"RECONCILED");
    assert.equal(result.exchangeOrderSubmitted,false);
    assert.equal(result.attemptedNetworkCalls,0);
    assert.equal(result.tradingAuthorized,false);
    assert.equal(result.ok,false);
    assert.equal(result.reconciliation?.mayRetry,false);
  }
});
test("timeout or unknown order status cannot be reinterpreted as clean zero-fill",()=>{
  for(const change of [null,{httpStatus:503}, {client_order_id:"other"}]){
    const x=fixture();
    x.exchangeObservation!.response=change===null?null:
      {...x.exchangeObservation!.response!,...change};
    const result=simulateEmergencyExit(x);
    assert.equal(result.reconciliation?.state,"UNKNOWN");
    assert.equal(result.reconciliation?.mayRetry,false);
    assert.equal(result.attemptedNetworkCalls,0);
  }
});
test("tampered owner, order, market or position details halt offline lifecycle",()=>{
  for(const change of [
    {ownerId:"99999999-9999-4999-8999-999999999999"},
    {order:{...fixture().order,side:"bid"}},
    {order:{...fixture().order,reduce_only:false}},
    {evidence:{...fixture().evidence!,restingOrderCount:1}},
    {evidence:{...fixture().evidence!,globalKillActive:true}},
  ]){
    const out=simulateEmergencyExit({...fixture(),...change});
    assert.equal(out.reconciliation,null);
    assert.equal(out.exchangeOrderSubmitted,false);
    assert.equal(out.tradingAuthorized,false);
  }
});
test("advisory and exchange receipt must bind to exactly the same client order and inventory",()=>{
  for(const change of [
    {clientOrderId:"v13p-99999999-9999-4999-8999-999999999999"},
    {marketTicker:"KXBTC15M-OTHER"},
    {reducingBookSide:"bid"},
    {requestedCountFp:"1.00"},
    {initialPositionFp:"4.00"},
  ]){
    const x=fixture();
    x.exchangeObservation={...x.exchangeObservation!,...change} as IocRecoveryObservation;
    const result=simulateEmergencyExit(x);
    assert.equal(result.reason,"emergency_exit_dry_run_cross_binding_failed");
    assert.equal(result.tradingAuthorized,false);
  }
});
test("offline-only path cannot operate with missing exchange history",()=>{
  const result=simulateEmergencyExit({...fixture(),exchangeObservation:null});
  assert.equal(result.reconciliation,null);
  assert.equal(result.reason,"emergency_exit_dry_run_missing_exchange_observation");
});
