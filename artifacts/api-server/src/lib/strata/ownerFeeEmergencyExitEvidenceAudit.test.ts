import test from "node:test";
import assert from "node:assert/strict";
import {auditExitOutcomeMatrix,type ExitEvidenceScenario} from "./ownerFeeEmergencyExitEvidenceAudit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

const ticker="KXBTC15M-26OCT19T0345";
const uuids=[
 "11111111-1111-4111-8111-111111111111",
 "22222222-2222-4222-8222-222222222222",
 "33333333-3333-4333-8333-333333333333",
 "44444444-4444-4444-8444-444444444444",
];
function observation(i:number,fill:string,remaining:string,position:string):
 IocRecoveryObservation {
 const clientOrderId="v13p-"+uuids[i]!;
 return {
  clientOrderId,requestedCountFp:"1.00",marketTicker:ticker,
  initialPositionFp:"4.00",observedPositionFp:position,
  positionMarketTicker:ticker,reducingBookSide:"ask",
  completeExchangeHistory:true,exactMarketAndAccountMatched:true,
  orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
  response:{httpStatus:201,order_id:"order-"+i,client_order_id:clientOrderId,
   fill_count:fill,remaining_count:remaining,ts_ms:1792370000000},
 };
}
function scenarios():ExitEvidenceScenario[]{
 const z=observation(0,"0.00","1.00","4.00");
 const p=observation(1,"0.50","0.50","3.50");
 const f=observation(2,"1.00","0.00","3.00");
 const u=observation(3,"0.00","1.00","4.00");
 u.response=null;u.completeExchangeHistory=false;u.orderAndFillHistoryMatched=false;
 return [
  {kind:"ZERO_FILL",unknownPersistedBeforeTransport:true,submitCount:1,observation:z},
  {kind:"PARTIAL_FILL",unknownPersistedBeforeTransport:true,submitCount:1,observation:p},
  {kind:"FULL_FILL",unknownPersistedBeforeTransport:true,submitCount:1,observation:f},
  {kind:"UNKNOWN_TIMEOUT",unknownPersistedBeforeTransport:true,submitCount:1,observation:u},
 ];
}
test("four independent offline outcome models pass but NEVER constitute exchange approval",()=>{
 const result=auditExitOutcomeMatrix(scenarios());
 assert.equal(result.conformsToRecoveryModel,true);
 assert.deepEqual(result.problems,[]);
 assert.equal(result.authenticatedExchangeEvidenceVerified,false);
 assert.equal(result.independentProductionSignoff,false);
 assert.equal(result.liveOrderAuthorized,false);
});
test("timeout never counts as independently reconciled zero fill",()=>{
 const s=scenarios();s[3]!.observation.response=observation(3,"0.00","1.00","4.00").response;
 assert.equal(auditExitOutcomeMatrix(s).conformsToRecoveryModel,false);
});
test("duplicate client order ID and retry are hard failures",()=>{
 const s=scenarios();
 s[2]!.observation.clientOrderId=s[1]!.observation.clientOrderId;
 s[2]!.submitCount=2;
 assert.equal(auditExitOutcomeMatrix(s).conformsToRecoveryModel,false);
});
test("UNKNOWN marker must predate network; missing one blocks audit",()=>{
 const s=scenarios();s[0]!.unknownPersistedBeforeTransport=false;
 assert.equal(auditExitOutcomeMatrix(s).conformsToRecoveryModel,false);
});
test("fill classification, position, market and history must align",()=>{
 for(const mutation of [
  (s:ExitEvidenceScenario[])=>{s[0]!.observation.response!.fill_count="0.50";s[0]!.observation.response!.remaining_count="0.50";s[0]!.observation.observedPositionFp="3.50";},
  (s:ExitEvidenceScenario[])=>{s[1]!.observation.observedPositionFp="4.00";},
  (s:ExitEvidenceScenario[])=>{s[2]!.observation.positionMarketTicker="KXBTC15M-OTHER";},
  (s:ExitEvidenceScenario[])=>{s[2]!.observation.orderAndFillHistoryMatched=false;},
 ]){
  const s=scenarios();mutation(s);
  assert.equal(auditExitOutcomeMatrix(s).conformsToRecoveryModel,false);
 }
});
