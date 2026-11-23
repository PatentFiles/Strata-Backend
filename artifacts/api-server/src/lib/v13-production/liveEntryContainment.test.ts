import assert from "node:assert/strict";
import test from "node:test";
import {assertContainedProductionRequest,containedProductionFetch,LIVE_ENTRY_SOURCE_UNAVAILABLE} from "./liveEntryContainment";
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
