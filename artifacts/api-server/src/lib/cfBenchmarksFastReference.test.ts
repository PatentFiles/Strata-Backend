import assert from "node:assert/strict";
import test from "node:test";
import {parseKalshiFastBrtiTick,compareFastBrtiCoinbase} from "./cfBenchmarksFastReference";
const ts=Date.parse("2026-10-22T15:05:00.250Z");
const frame=(override:Record<string,unknown>={})=>({
 type:"cfbenchmarks_value_5hz",sid:9,seq:45,
 msg:{
  index_id:"BRTI",source_ts_ms:ts,received_at:ts+20,
  value_usd:"68123.45000000",
  data:JSON.stringify({type:"value",id:"BRTI",time:ts,value:"68123.45"}),
  ...override,
 },
});
test("accepts fresh official 5Hz tick but never grants settlement or execution authority",()=>{
 const result=parseKalshiFastBrtiTick(frame(),ts+100);
 assert.equal(result.ok,true);
 if(!result.ok)return;
 assert.equal(result.tick.sourceTimestampMs,ts);
 assert.equal(result.tick.valueUsd,"68123.45000000");
 assert.equal(result.tick.settlementAuthority,false);
 assert.equal(result.tick.tradingAuthority,false);
 const compared=compareFastBrtiCoinbase(result.tick,{
  price:68125.25,providerTimestampMs:ts+400,receivedAtMs:ts+500,
 },ts+550);
 assert.equal(compared.basisUsd,1.80);
 assert.equal(compared.code,"SYNCHRONIZED_RESEARCH_REFERENCE");
 assert.equal(compared.readyForExecution,false);
 assert.equal(compared.settlementAuthority,false);
});
test("rejects wrong index, forgery, stale tick, future timestamp or inconsistent vendor payload",()=>{
 const tests=[
  frame({index_id:"ETHUSD_RTI"}),
  frame({source_ts_ms:ts+8000}),
  frame({source_ts_ms:ts-5000}),
  frame({received_at:ts-5000}),
  frame({value_usd:"68123.46000000"}),
  frame({data:JSON.stringify({type:"value",id:"BRTI",time:ts+100,value:"68123.45"})}),
  frame({data:JSON.stringify({type:"value",id:"WRONG",time:ts,value:"68123.45"})}),
  frame({data:"{unparseable"}),
 ];
 for(const f of tests)assert.equal(parseKalshiFastBrtiTick(f,ts+100).ok,false);
 assert.equal(parseKalshiFastBrtiTick(frame(),ts+5000).ok,false);
 assert.equal(parseKalshiFastBrtiTick({...frame(),type:"cfbenchmarks_value"},ts+100).ok,false);
});
test("does not calculate false Coinbase basis from stale or unmatched publisher timestamps",()=>{
 const parsed=parseKalshiFastBrtiTick(frame(),ts+80);
 if(!parsed.ok)throw Error("fixture invalid");
 for(const other of [null,{price:68125,providerTimestampMs:ts-2000,receivedAtMs:ts+100},
   {price:68125,providerTimestampMs:ts+2000,receivedAtMs:ts+2300}]){
  const result=compareFastBrtiCoinbase(parsed.tick,other,ts+2500,1000);
  assert.equal(result.code,"UNVERIFIED_TEMPORAL_ALIGNMENT");
  assert.equal(result.basisUsd,null);
 }
 const outdated=compareFastBrtiCoinbase(parsed.tick,{
  price:68125,providerTimestampMs:ts,receivedAtMs:ts,
 },ts+15000);
 assert.equal(outdated.basisUsd,null);
});
