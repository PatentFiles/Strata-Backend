import assert from "node:assert/strict";
import test from "node:test";
import {
  assessNearExpiryCapShadow,
  MIN_RESEARCH_SECONDS_REMAINING,
  MAX_RESEARCH_CONTRACTS,
} from "./v13NearExpiryCapShadow";

test("time to expiry is strict: rejects stale/null/negative and below 30 seconds",()=>{
  for(const seconds of [null,NaN,-1,0,15,21.9,29.999])
    assert.deepEqual(assessNearExpiryCapShadow(seconds,0.40),{
      mode:"RESEARCH_SHADOW_ONLY",executionAuthority:false,providerFeeVerified:false,
      wouldEnter:false,modeledContracts:0,illustrativeEntryFeeCents:0,
      reason:"INSUFFICIENT_TIME",
    });
  assert.equal(assessNearExpiryCapShadow(MIN_RESEARCH_SECONDS_REMAINING,0.40).wouldEnter,true);
});

test("20-contract cap and illustrative fee-inclusive $5 cash ceiling",()=>{
  const penny=assessNearExpiryCapShadow(100,0.015);
  assert.equal(penny.modeledContracts,MAX_RESEARCH_CONTRACTS);
  assert.equal(penny.wouldEnter,true);
  const atFifty=assessNearExpiryCapShadow(100,0.50);
  assert.ok(atFifty.modeledContracts>0 && atFifty.modeledContracts<10);
  assert.equal(atFifty.modeledContracts,9);
  assert.ok(atFifty.illustrativeEntryFeeCents>0);
  assert.equal(atFifty.providerFeeVerified,false);
  assert.equal(atFifty.executionAuthority,false);
});

test("non-fixedpoint price, absent quote and over-expensive contract fail closed",()=>{
  for(const price of [null,NaN,0,1,-0.5,1.5,0.50001])
    assert.equal(assessNearExpiryCapShadow(600,price).wouldEnter,false);
  const tooExpensive=assessNearExpiryCapShadow(200,0.9999);
  assert.equal(tooExpensive.reason,"RESEARCH_CANDIDATE");
  assert.equal(tooExpensive.modeledContracts,4); // five contracts exceed $5 after a 1c illustrative fee
});

test("research result cannot authorize a real order or claim fee evidence",()=>{
  const r=assessNearExpiryCapShadow(180,0.25);
  assert.equal(r.mode,"RESEARCH_SHADOW_ONLY");
  assert.equal(r.executionAuthority,false);
  assert.equal(r.providerFeeVerified,false);
});
