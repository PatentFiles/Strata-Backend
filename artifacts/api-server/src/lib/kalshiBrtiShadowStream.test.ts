import assert from "node:assert/strict";
import test from "node:test";
import {
  kalshiBrtiShadowConfigured,
  readKalshiBrtiShadowStatus,
  startKalshiBrtiShadowFeed,
  brtiStreamTimedOut,
} from "./kalshiBrtiShadowStream";

test("BRTI shadow feed is off by default and has no trading authority",()=>{
  const env={NODE_ENV:"production",KALSHI_API_ENVIRONMENT:"production"};
  assert.equal(kalshiBrtiShadowConfigured(env),false);
  startKalshiBrtiShadowFeed(env);
  const status=readKalshiBrtiShadowStatus();
  assert.equal(status.state,"DISABLED");
  assert.equal(status.tradingAuthority,false);
  assert.equal(status.sourceFresh,false);
  assert.equal(status.instantSourceFresh,false);
  assert.equal(status.lastIndex,null);
  assert.equal(status.lastFrame,null);
  assert.equal(status.fastState,"DISABLED");
  assert.equal(status.fastIndex,null);
  assert.equal(status.fastSourceFresh,false);
  assert.equal(status.fastMessageGaps,0);
});

test("a nonproduction environment cannot enable the production BRTI observer",()=>{
  for(const environment of ["development","test","staging"]){
    const env={NODE_ENV:environment,KALSHI_API_ENVIRONMENT:"production",
      STRATA_CF_BRTI_SHADOW_ENABLED:"true"};
    assert.equal(kalshiBrtiShadowConfigured(env),false);
  }
  assert.equal(kalshiBrtiShadowConfigured({
    NODE_ENV:"production",KALSHI_API_ENVIRONMENT:"demo",
    STRATA_CF_BRTI_SHADOW_ENABLED:"true",
  }),false);
  assert.equal(kalshiBrtiShadowConfigured({
    NODE_ENV:"production",KALSHI_API_ENVIRONMENT:"production",
    STRATA_CF_BRTI_SHADOW_ENABLED:"TRUE",
  }),false);
});

test("optional 5Hz does not start when parent settlement observer is disabled",()=>{
 const env={NODE_ENV:"production",KALSHI_API_ENVIRONMENT:"production",
  STRATA_CF_BRTI_5HZ_SHADOW_ENABLED:"true"};
 assert.equal(kalshiBrtiShadowConfigured(env),false);
 startKalshiBrtiShadowFeed(env);
 assert.equal(readKalshiBrtiShadowStatus().fastState,"DISABLED");
});
test("shadow config is exact-match and never confers orders or owner authorization",()=>{
  assert.equal(kalshiBrtiShadowConfigured({
    NODE_ENV:"production",KALSHI_API_ENVIRONMENT:"production",
    STRATA_CF_BRTI_SHADOW_ENABLED:"true",
  }),true);
  const record=readKalshiBrtiShadowStatus();
  assert.equal("ordersSubmitted" in record,false);
  assert.equal("ownerAuthorized" in record,false);
  assert.equal("signedMutations" in record,false);
});

test("BRTI observer watchdog requires current verified index ticks, not merely an open socket",()=>{
 const t=Date.parse("2026-10-22T16:45:00.000Z");
 assert.equal(brtiStreamTimedOut(null,t,t+14_999),false);
 assert.equal(brtiStreamTimedOut(null,t,t+15_000),false);
 assert.equal(brtiStreamTimedOut(null,t,t+15_001),true);
 assert.equal(brtiStreamTimedOut(t+9000,t,t+22_000),false);
 assert.equal(brtiStreamTimedOut(t+9000,t,t+24_001),true);
 assert.equal(brtiStreamTimedOut(t+9000,t,t+8000),true);
});
