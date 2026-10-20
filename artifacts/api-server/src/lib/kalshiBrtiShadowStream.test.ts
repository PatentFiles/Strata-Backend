import assert from "node:assert/strict";
import test from "node:test";
import {
  kalshiBrtiShadowConfigured,
  readKalshiBrtiShadowStatus,
  startKalshiBrtiShadowFeed,
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
