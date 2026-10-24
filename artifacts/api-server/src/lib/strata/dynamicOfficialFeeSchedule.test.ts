import test from "node:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {extractFeeScheduleDocumentText,readUnapprovedOfficialFeePublication} from "../microLiveFeeArtifact";

import assert from "node:assert/strict";
import {parseDynamicKalshiPublication,estimateDynamicFeeMicros,observeDynamicKalshiFees} from "./dynamicOfficialFeeSchedule";
import {issuerWholeCentFee,verifyIssuerGeneralFeeTable} from "./officialFeeTableParity";

const NOW=Date.parse("2026-10-23T20:00:00Z");
const priceMoney=(cents:number)=>"$"+Math.floor(cents/100)+"."+(cents%100).toString().padStart(2,"0");
const witness=(taker:string)=>{
 const rate=Math.round(Number(taker)*1_000_000);
 return "General Trading Fees Table Price of 1 contract Fee for 1 contract Price for 100 contracts Fee for 100 contracts "+
  [1,5,10,25,50,75,90,99].map(p=>{
   const one=issuerWholeCentFee(rate,1,p);
   const hundred=issuerWholeCentFee(rate,100,p);
   if(one===null||hundred===null)throw Error("unrepresentable test rate");
   return [priceMoney(p),priceMoney(one),priceMoney(p*100),priceMoney(hundred)].join(" ");
  }).join(" ");
};
const doc=(taker="0.07",maker="0.0175",tail="KXBTCY BTC price EOY 0 0")=>[
 "Trading Fees",
 "The following terms apply to all event contract markets on the exchange, apart from specific products listed below, which have their own fee schedule.",
 "fees = round up(M x "+taker+" x C x P x (1-P))",
 "M = the multiplier for each contract (default is 1 unless otherwise indicated)",
 "round up = rounds up such that the fee + positionCost is rounded to a centicent",
 "Maker Fees",
 "fees = round up(M x "+maker+" x C x P x (1-P))",
 "M = the multiplier for each contract (default is 0 unless otherwise indicated)",
 witness(taker),
 "Non-Standard Fees",
 "Series Maker Multiplier Taker Multiplier",
 tail,
 "Perpetual Futures Fees",
 "Last updated and effective: July 7, 2026",
].join(" ");

test("real byte-for-byte reviewed official Kalshi PDF parses into executable-candidate dynamic fees",async()=>{
 const fixture=readFileSync(resolve(process.cwd(),
   "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
 const extracted=await extractFeeScheduleDocumentText(fixture);
 assert.ok(extracted,"actual Kalshi PDF fixture must be readable");
 const model=parseDynamicKalshiPublication(extracted!,NOW);
 assert.equal(model.ok,true,JSON.stringify(model));
 if(model.ok){
   assert.equal(model.effectiveDate,"2026-07-07");
   assert.equal(model.takerRatePpm,70000);
   assert.equal(model.makerRatePpm,17500);
   assert.equal(model.defaultTakerMultiplierPpm,1000000);
   assert.equal(model.defaultMakerMultiplierPpm,0);
 }
 // Original issuer exceptions stay mandatory: never rewrite PDF inputs to
 // get a passing parser, or hard-code a rate when source parsing fails.
 const changed=extracted!.replace("Non-Standard Fees","Not Reviewed Fees");
 assert.equal(parseDynamicKalshiPublication(changed,NOW).ok,false);
});
test("official July PDF explanatory Maker Fees mention never truncates taker formula",()=>{
 const officialStructure=doc().replace("Trading Fees",
  "Kalshi Trading Fees").replace(
  "fees = round up(M x 0.07",
  "Trading fees are only charged for orders immediately matched. "
  +"Other orders can be included in our “Maker Fees” section. "
  +"The general trading formula is: fees = round up(M x 0.07");
 const result=parseDynamicKalshiPublication(officialStructure,NOW);
 assert.equal(result.ok,true,JSON.stringify(result));
 if(result.ok){
   assert.equal(result.takerRatePpm,70_000);
   assert.equal(result.makerRatePpm,17_500);
 }
 const absentFormula=officialStructure.replace(
  "fees = round up(M x 0.07","this formula was removed (M x 0.07");
 assert.equal(parseDynamicKalshiPublication(absentFormula,NOW).ok,false);
 const wrongOrder=doc().replace("Non-Standard Fees","Unverified Fees");
 assert.equal(parseDynamicKalshiPublication(wrongOrder,NOW).ok,false);
});
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
test("official PDF formula and own fee table must agree for both one and 100 contracts",()=>{
 const live=doc();
 const verified=verifyIssuerGeneralFeeTable(live,70_000);
 assert.equal(verified.ok,true,JSON.stringify(verified));
 assert.equal(issuerWholeCentFee(70_000,1,50),2);
 assert.equal(issuerWholeCentFee(70_000,100,50),175);
 // The published 1-contract table rounds $0.0175 to $0.02;
 // the separate V4 centicent model quotes 17,500 micros before any
 // full-cent table rounding. Do not silently confuse those conventions.
 assert.equal(estimateDynamicFeeMicros(70_000,1_000_000,100,5000),17_500n);
 for(const malformed of [
  live.replace("General Trading Fees Table","Unavailable Worked Examples"),
  live.replace("$0.50 $0.02 $50.00 $1.75","$0.50 $0.01 $50.00 $1.75"),
  live.replace("$0.50 $0.02 $50.00 $1.75","$0.50 $0.02 $50.00 $1.74"),
  live.replace("$0.50 $0.02 $50.00 $1.75","$0.50 $0.02 $50.00 $1.75 $0.50 $0.02 $50.00 $1.75"),
 ]){
  const result=parseDynamicKalshiPublication(malformed,NOW);
  assert.equal(result.ok,false,malformed.slice(-180));
  assert.ok(["official_fee_reference_table_formula_mismatch",
    "official_fee_reference_table_missing_or_reordered"].includes(result.reason),result.reason);
 }
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
test("V4 fee PDF rate limit obeys official Retry-After without repeated Kalshi requests or fee proof",async()=>{
 let now=Date.parse("2026-10-24T12:00:00Z"),calls=0;
 const transport=(async()=>{
   calls++;
   if(calls===1)return new Response(null,{status:429,headers:{"retry-after":"1800"}});
   return new Response(null,{status:404});
 }) as typeof fetch;
 const first=await readUnapprovedOfficialFeePublication(transport,()=>now);
 assert.deepEqual(first,{ok:false,reason:"dynamic_fee_publication_http_429"});
 now+=60_000;
 const second=await readUnapprovedOfficialFeePublication(transport,()=>now);
 assert.deepEqual(second,{ok:false,reason:"dynamic_fee_publication_http_429"});
 assert.equal(calls,1,"provider 429 must not be hammered during 30-minute official backoff");
 now+=1_740_000;
 const retry=await readUnapprovedOfficialFeePublication(transport,()=>now);
 assert.deepEqual(retry,{ok:false,reason:"dynamic_fee_publication_http_404"});
 assert.equal(calls,2,"direct source can be rechecked after its actual Retry-After");
});
test("V4 unknown or malicious Retry-After is bounded, never interpreted as approval",async()=>{
 let now=Date.parse("2026-10-24T12:00:00Z"),calls=0;
 const transport=(async()=>{
   calls++;
   return new Response(null,{status:429,headers:{"retry-after":"malicious-non-numeric"}});
 }) as typeof fetch;
 const initial=await readUnapprovedOfficialFeePublication(transport,()=>now);
 assert.equal(initial.ok,false);
 now+=59_000;
 const suppressed=await readUnapprovedOfficialFeePublication(transport,()=>now);
 assert.equal(suppressed.ok,false);
 assert.equal(calls,1);
 now+=1_000;
 const after=await readUnapprovedOfficialFeePublication(transport,()=>now);
 assert.equal(after.ok,false);
 assert.equal(calls,2);
 // Second 429 ramps the cooldown to two minutes, even with a forged header.
 now+=119_000;
 assert.equal((await readUnapprovedOfficialFeePublication(transport,()=>now)).ok,false);
 assert.equal(calls,2);
 now+=1_000;
 assert.equal((await readUnapprovedOfficialFeePublication(transport,()=>now)).ok,false);
 assert.equal(calls,3);
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
