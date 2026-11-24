import assert from "node:assert/strict";
import test from "node:test";
import {assertContainedProductionRequest,containedProductionFetch,createIndependentProductionFetch,independentLiveRolloutAllowed,LIVE_ENTRY_SOURCE_UNAVAILABLE} from "./liveEntryContainment";
const url="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders";
const reducing={reduce_only:true,subaccount:1,exchange_index:2,time_in_force:"immediate_or_cancel",post_only:false};
const post=(value:unknown):RequestInit=>({method:"POST",body:JSON.stringify(value)});
test("entry source containment rejects entry, forged live labels and absent reduce flag",()=>{
  for(const x of [{...reducing,reduce_only:false},{...reducing,reduce_only:"true"},{source:"LIVE",reduce_only:false},{...reducing,subaccount:2},{...reducing,exchange_index:1},{...reducing,post_only:true},{}])
    assert.throws(()=>assertContainedProductionRequest(url,post(x)),{message:LIVE_ENTRY_SOURCE_UNAVAILABLE});
});
test("unknown mutation, altered destination and ambiguous body fail closed",()=>{
  for(const [u,i] of [[url,{method:"POST",body:"{"}],[url+"?other=1",post(reducing)],["https://example.com"+new URL(url).pathname,post(reducing)],[url,{method:"PUT"}],[new Request(url,{method:"POST",body:JSON.stringify(reducing)}),undefined]] as [Parameters<typeof fetch>[0],RequestInit|undefined][])
    assert.throws(()=>assertContainedProductionRequest(u,i),{message:LIVE_ENTRY_SOURCE_UNAVAILABLE});
});
test("existing reducing and cancel routes are not blocked by the narrowing fence",()=>{
  assert.doesNotThrow(()=>assertContainedProductionRequest(url,post(reducing)));
  assert.doesNotThrow(()=>assertContainedProductionRequest(url+"/order-1",{method:"DELETE"}));
  assert.doesNotThrow(()=>assertContainedProductionRequest(url,{method:"GET"}));
});
test("blocked real wire wrapper never invokes fetch; permitted exit stays redirect fenced",async()=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async(_input,init)=>{calls++;assert.equal(init?.redirect,"error");return new Response(null,{status:204});};
  try{
    await assert.rejects(containedProductionFetch(url,post({...reducing,reduce_only:false})),{message:LIVE_ENTRY_SOURCE_UNAVAILABLE});
    assert.equal(calls,0);
    await containedProductionFetch(url,post(reducing));
    assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});

const rolloutScope=Object.freeze({ownerId:"11111111-1111-4111-8111-111111111111",accountId:"strata-account-test",releaseSha:"a".repeat(40)});
const rolloutEnv:NodeJS.ProcessEnv={NODE_ENV:"production",STRATA_INDEPENDENT_LIVE_SOURCE_V1:"true",
  STRATA_INDEPENDENT_LIVE_SOURCE_V1_OWNER:rolloutScope.ownerId,
  STRATA_INDEPENDENT_LIVE_SOURCE_V1_ACCOUNT:rolloutScope.accountId,
  STRATA_INDEPENDENT_LIVE_SOURCE_V1_SHA:rolloutScope.releaseSha,
  RAILWAY_GIT_COMMIT_SHA:rolloutScope.releaseSha};
test("independent rollout requires exact owner, account and running release; no global opt-in",()=>{
  assert.equal(independentLiveRolloutAllowed(rolloutScope,rolloutEnv),true);
  assert.equal(independentLiveRolloutAllowed(rolloutScope,{STRATA_INDEPENDENT_LIVE_SOURCE_V1:"true"}),false);
  for(const key of Object.keys(rolloutEnv)){
    assert.equal(independentLiveRolloutAllowed(rolloutScope,{...rolloutEnv,[key]:undefined}),false,key);
    assert.equal(independentLiveRolloutAllowed(rolloutScope,{...rolloutEnv,[key]:"mismatch"}),false,key);
  }
  assert.equal(independentLiveRolloutAllowed({...rolloutScope,accountId:"foreign-account"},rolloutEnv),false);
  assert.equal(independentLiveRolloutAllowed({...rolloutScope,ownerId:"22222222-2222-4222-8222-222222222222"},rolloutEnv),false);
  assert.equal(independentLiveRolloutAllowed({...rolloutScope,releaseSha:"b".repeat(40)},rolloutEnv),false);
});
test("independent default transport refuses entry without a bound ledger and scoped rollout",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:204});};
  try{
    const wire=createIndependentProductionFetch(()=>null);
    await assert.rejects(wire(url,post({...reducing,reduce_only:false})),{message:LIVE_ENTRY_SOURCE_UNAVAILABLE});
    assert.equal(calls,0);
    // Containment is not exit authority; preserve the existing reducing path.
    await wire(url,post(reducing));assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
