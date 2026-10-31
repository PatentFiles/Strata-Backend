import test from "node:test";
import assert from "node:assert/strict";
import {createPublicMetadataReadLimiter} from "./publicMetadataReadRateLimit";
import {createEntryMetadataSnapshot} from "./entryMetadataSnapshot";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
const market="KXBTC15M-26OCT310100-00";
const sp="/series/KXBTC15M";
test("endpoint holds survive fresh snapshots and are scoped to stable public fetch transport",async()=>{
 let calls=0;const transport=(async()=>{calls++;return new Response("{}",{status:429,headers:{"retry-after":"60","content-type":"application/json"}});}) as typeof fetch;
 await assert.rejects(createEntryMetadataSnapshot(market,transport).read(sp));
 await assert.rejects(createEntryMetadataSnapshot(market,transport).read(sp));assert.equal(calls,1);
 let otherCalls=0;const other=(async()=>{otherCalls++;return Response.json({series:{}});}) as typeof fetch;
 await createEntryMetadataSnapshot(market,other).read(sp);assert.equal(otherCalls,1);
});
test("unshared listing honors its own observed429 across probe invocations",async()=>{
 let calls=0;const transport=(async()=>{calls++;return new Response("{}",{status:429,headers:{"retry-after":"60","content-type":"application/json"}});}) as typeof fetch;
 assert.equal((await probeCurrentKalshiFeeApi(transport,()=>0)).ok,false);
 assert.equal((await probeCurrentKalshiFeeApi(transport,()=>0)).ok,false);assert.equal(calls,1);
});
test("clock regression cannot expire hold; old success cannot erase concurrent429",()=>{
 let clock=10;const begin=createPublicMetadataReadLimiter(()=>0,()=>clock);
 const old=begin(sp),newer=begin(sp);newer.response(new Response(null,{status:429,headers:{"retry-after":"2"}}));
 old.success();clock=0;assert.throws(()=>begin(sp),/cooldown/);
 assert.doesNotThrow(()=>begin(`/markets/${market}`),"unrelated endpoint is not globally blocked");
 clock=2009;assert.throws(()=>begin(sp),/cooldown/);clock=2010;assert.doesNotThrow(()=>begin(sp));
});
test("public-only limiter rejects unsupported/private/changed query scope",()=>{
 const begin=createPublicMetadataReadLimiter(()=>0,()=>0);
 for(const path of ["/portfolio/orders","/markets/OTHER",sp+"?changed=1","https://evil.invalid"])
  assert.throws(()=>begin(path),/scope_invalid/);
});
