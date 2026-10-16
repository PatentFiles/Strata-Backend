import assert from "node:assert/strict";
import test from "node:test";
import {inspectEmergencyExitCandidate,type EmergencyExitEvidence,
  type EmergencyExitOrder} from "./ownerFeeEmergencyExit";

const OWNER="11111111-1111-4111-8111-111111111111";
const OTHER="99999999-9999-4999-8999-999999999999";
const MARKET="KXBTC15M-26OCT161045-45";
const NOW=Date.parse("2026-10-16T19:45:00Z");
const order=():EmergencyExitOrder=>({
  ticker:MARKET,side:"ask",count:"2.00",price:"0.5600",
  client_order_id:"v13p-22222222-2222-4222-8222-222222222222",
  time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",reduce_only:true,
  post_only:false,subaccount:1,exchange_index:2,
});
const evidence=():EmergencyExitEvidence=>({
  authenticatedOwnerId:OWNER,accountOwnerId:OWNER,
  accountSubaccount:1,accountExchangeIndex:2,
  signerVerified:true,globalKillActive:false,accountKillActive:false,
  executionEnabled:true,positionsComplete:true,
  positionMarket:MARKET,positionFp:"2.00",positionsObservedAtMs:NOW-100,
  restingOrderCount:0,uncertainOrderCount:0,
  kalshiFee:{source:"kalshi_live_api",market:MARKET,
    fingerprint:"a".repeat(64),observedAtMs:NOW-100,
    feeType:"quadratic",feeMultiplier:1,
    noUnverifiedOverridesOrChanges:true,marketOpen:true},
});
const check=(o=order(),e:EmergencyExitEvidence|null=evidence(),owner=OWNER,now=NOW)=>
  inspectEmergencyExitCandidate(owner,o,e,now);
test("positive proof is read-only: never authorizes or submits orders",()=>{
  const x=check();
  assert.equal(x.ok,false);
  assert.equal(x.reason,"emergency_exit_candidate_verified_requires_fenced_dispatch");
  assert.equal(x.tradingAuthorized,false);
  assert.equal(x.needsIndependentApproval,true);
  assert.equal(x.diagnosticEligible,true);
});
test("NO holdings can only be reduced with bid book side",()=>{
  assert.equal(check({...order(),side:"bid"}, {...evidence(),positionFp:"-2.00"}).reason,
    "emergency_exit_candidate_verified_requires_fenced_dispatch");
  assert.equal(check({...order(),side:"ask"}, {...evidence(),positionFp:"-2.00"}).reason,
    "emergency_exit_side_not_reducing");
  assert.equal(check({...order(),side:"bid"}).reason,"emergency_exit_side_not_reducing");
});
test("invalid owner, wrong account, unverified signer fail closed",()=>{
  for(const e of [
    {...evidence(),accountOwnerId:OTHER},
    {...evidence(),authenticatedOwnerId:OTHER},
    {...evidence(),accountSubaccount:0},
    {...evidence(),accountExchangeIndex:1},
    {...evidence(),signerVerified:false},
  ])assert.equal(check(order(),e).reason,"emergency_exit_authenticated_pair_unverified");
  assert.equal(check(order(),evidence(),OTHER).reason,"emergency_exit_authenticated_pair_unverified");
});
test("global/account kill and disabled execution remain authoritative",()=>{
  for(const e of [
    {...evidence(),globalKillActive:true},
    {...evidence(),accountKillActive:true},
    {...evidence(),executionEnabled:false},
  ])assert.equal(check(order(),e).reason,"emergency_exit_execution_gate_closed");
});
test("wrong account, market, client id or malformed ticker denied",()=>{
  for(const o of [
    {...order(),subaccount:0},
    {...order(),exchange_index:0},
    {...order(),ticker:"OTHER-1"},
    {...order(),client_order_id:"invalid"},
  ])assert.equal(check(o).reason,"emergency_exit_order_identity_invalid");
});
test("requires native V2 strict reduce-only IOC, nonresting order",()=>{
  for(const o of [
    {...order(),reduce_only:false},
    {...order(),reduce_only:"true"},
    {...order(),time_in_force:"good_till_canceled"},
    {...order(),post_only:true},
    {...order(),post_only:undefined},
    {...order(),self_trade_prevention_type:undefined},
    {...order(),self_trade_prevention_type:"maker"},
    {...order(),expiration_time:123},
    {...order(),price:"0"},
    {...order(),price:"1.0000"},
  ])assert.equal(check(o).reason,"emergency_exit_order_constraints_invalid");
});
test("cannot over-close or accept fractional/overflow quantity",()=>{
  for(const o of [
    {...order(),count:"0.00"},
    {...order(),count:"-1.00"},
    {...order(),count:"not-a-count"},
    {...order(),count:"2"},
    {...order(),count:"1001.00"},
  ]) assert.equal(check(o).reason,"emergency_exit_quantity_invalid");
  assert.equal(check({...order(),count:"2.01"}).reason,"emergency_exit_exceeds_position");
  assert.equal(check(order(),{...evidence(),positionFp:"1.00"}).reason,"emergency_exit_exceeds_position");
});
test("position evidence must be complete, exact, fresh and parseable",()=>{
  for(const e of [
    {...evidence(),positionsComplete:false},
    {...evidence(),positionMarket:"OTHER"},
    {...evidence(),positionsObservedAtMs:NOW-3001},
    {...evidence(),positionsObservedAtMs:NOW+1},
  ])assert.equal(check(order(),e).reason,"emergency_exit_live_position_unverified");
  assert.equal(check(order(),{...evidence(),positionFp:"zero"}).reason,"emergency_exit_exceeds_position");
});
test("resting orders and uncertain requests must be reconciled",()=>{
  for(const e of [
    {...evidence(),restingOrderCount:1},
    {...evidence(),uncertainOrderCount:1},
  ])assert.equal(check(order(),e).reason,"emergency_exit_orders_unreconciled");
});
test("exact Kalshi fee evidence must be current, specific and consistent",()=>{
  const fees=evidence().kalshiFee!;
  for(const bad of [
    {...fees,market:"OTHER"},
    {...fees,observedAtMs:NOW-3001},
    {...fees,observedAtMs:NOW+1},
    {...fees,noUnverifiedOverridesOrChanges:false},
    {...fees,marketOpen:false},
    {...fees,feeMultiplier:2},
    {...fees,fingerprint:"bad"},
  ]){
    assert.equal(check(order(),{...evidence(),kalshiFee:bad as EmergencyExitEvidence["kalshiFee"]}).reason,
      "emergency_exit_exact_fee_evidence_unverified");
  }
  assert.equal(check(order(),{...evidence(),kalshiFee:null}).reason,
    "emergency_exit_exact_fee_evidence_unverified");
});
