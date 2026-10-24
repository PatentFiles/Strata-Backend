import test from "node:test";
import assert from "node:assert/strict";
import {parseDynamicKalshiPublication,estimateDynamicFeeMicros,observeDynamicKalshiFees} from "./dynamicOfficialFeeSchedule";

const NOW=Date.parse("2026-10-23T20:00:00Z");
const doc=(taker="0.07",maker="0.0175",tail="KXBTCY BTC price EOY 0 0")=>[
 "Trading Fees",
 "The following terms apply to all event contract markets on the exchange, apart from specific products listed below, which have their own fee schedule.",
 "fees = round up(M x "+taker+" x C x P x (1-P))",
 "M = the multiplier for each contract (default is 1 unless otherwise indicated)",
 "round up = rounds up such that the fee + positionCost is rounded to a centicent",
 "Maker Fees",
 "fees = round up(M x "+maker+" x C x P x (1-P))",
 "M = the multiplier for each contract (default is 0 unless otherwise indicated)",
 "Non-Standard Fees",
 "Series Maker Multiplier Taker Multiplier",
 tail,
 "Perpetual Futures Fees",
 "Last updated and effective: July 7, 2026",
].join(" ");

test("provider-extracted fee rates are dynamic decimals, not hard-coded 0.07",()=>{
 const first=parseDynamicKalshiPublication(doc(),NOW);
 assert.equal(first.ok,true,JSON.stringify(first));
 if(!first.ok)return;
 assert.equal(first.takerRatePpm,70000);
 assert.equal(first.makerRatePpm,17500);
 assert.equal(first.defaultTakerMultiplierPpm,1000000);
 assert.equal(first.defaultMakerMultiplierPpm,0);
 const revised=parseDynamicKalshiPublication(doc("0.08","0.02"),NOW);
 assert.equal(revised.ok,true,JSON.stringify(revised));
 if(!revised.ok)return;
 assert.equal(revised.takerRatePpm,80000);
 assert.equal(revised.makerRatePpm,20000);
 assert.notEqual(revised.takerRatePpm,first.takerRatePpm);
});
test("unknown market exceptions, ambiguous fees, malformed structure and dates all fail closed",()=>{
 for(const altered of [
  doc("0.07","0.0175","KXBTC15M Bitcoin override 0 0"),
  doc().replace("round up(M x 0.07","round up(M x variable"),
  doc().replace("round up(M x 0.0175","round up(M x variable"),
  doc().replace("default is 1","default is undetermined"),
  doc().replace("rounded to a centicent","rounded to an unspecified unit"),
  doc().replace("July 7, 2026","December 7, 2027"),
  doc()+" Last updated and effective: October 1, 2026",
  doc().replace("Non-Standard Fees","Special Rate Table"),
  doc().replace("0.07","0.1234567"),
 ])assert.equal(parseDynamicKalshiPublication(altered,NOW).ok,false,altered);
});
test("integer monetary fee calculation respects order-side multiplier and split rounding",()=>{
 assert.equal(estimateDynamicFeeMicros(70000,1000000,100,5000),17500n);
 assert.equal(estimateDynamicFeeMicros(80000,1000000,100,5000),20000n);
 assert.equal(estimateDynamicFeeMicros(17500,0,100,5000),0n);
 assert.equal(estimateDynamicFeeMicros(70000,1000000,1,5000),200n);
 assert.equal(estimateDynamicFeeMicros(70000,1000000,100,0),null);
 assert.equal(estimateDynamicFeeMicros(70000,1000000,100,10000),null);
 assert.equal(estimateDynamicFeeMicros(70000,1000000,0,5000),null);
 assert.equal(estimateDynamicFeeMicros(NaN,1000000,100,5000),null);
});
test("read-only runtime refuses malformed market before any network call",async()=>{
 let calls=0;
 const fetcher=async()=>{calls++;throw Error("do not fetch");};
 const result=await observeDynamicKalshiFees("ATTACK?url=https://example.com",null,
   fetcher as never,()=>NOW);
 assert.equal(result.ok,false);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(calls,0);
});
test("unavailable official PDF, HTTP 429 and redirect are non-authorizing",async()=>{
 for(const status of [429,404,503]){
  const fetcher=async()=>new Response("",{status});
  const result=await observeDynamicKalshiFees("KXBTC15M-26OCT231915",null,
    fetcher as never,()=>NOW);
  assert.equal(result.ok,false);
  assert.equal(result.tradingAuthorized,false);
  assert.equal(result.reason,"dynamic_fee_publication_http_"+status);
 }
 const redirected=async()=>{
  const response=new Response("%PDF-invalid",{status:200,
    headers:{"content-type":"application/pdf"}});
  Object.defineProperty(response,"url",{value:"https://attacker.invalid/fee.pdf"});
  return response;
 };
 const result=await observeDynamicKalshiFees("KXBTC15M-26OCT231915",null,
   redirected as never,()=>NOW);
 assert.equal(result.ok,false);
 assert.equal(result.reason,"dynamic_fee_publication_origin_invalid");
});
test("dynamic price observation cannot modify risk, grants or broker/exchange APIs",async()=>{
 const source=await import("node:fs").then(fs=>fs.readFileSync(
   "src/lib/strata/dynamicOfficialFeeSchedule.ts","utf8"));
 assert.doesNotMatch(source,/\b(?:INSERT INTO|UPDATE (?:public|private)\.|DELETE FROM|router\.post|submitOrder)\b/i);
 assert.match(source,/tradingAuthorized:false/);
 assert.match(source,/requiresVersionedReview:true/);
});
