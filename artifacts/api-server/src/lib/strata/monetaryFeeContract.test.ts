import test from "node:test";
import assert from "node:assert/strict";
import { verifyMonetaryFeeContract } from "./monetaryFeeContract";

test("ORDER_ENTRY refuses unspecified market without a provider request",async()=>{
 let called=false;
 const fetcher=(async()=>{called=true;throw Error("unexpected");}) as typeof fetch;
 const result=await verifyMonetaryFeeContract("ORDER_ENTRY",undefined,fetcher);
 assert.equal(result.ok,false);
 assert.equal(result.reason,"exact_order_market_required");
 assert.equal(result.monetaryFeeAuthorized,false);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(called,false);
});

test("all authorization stages fail closed when provider source is unavailable",async()=>{
 const validPdf=(async()=>({ok:true as const,digest:"a".repeat(64),diagnostic:{httpStatus:200,contentType:"application/pdf",finalOrigin:"https://kalshi.com",finalPathname:"/docs/kalshi-fee-schedule.pdf",retryAfterSeconds:null,networkAttempts:1}}));
 const fetcher=(async()=>{throw Error("offline");}) as typeof fetch;
 for(const stage of ["STEP_9","STEP_11","ORDER_ENTRY"] as const){
  const market=stage==="ORDER_ENTRY"?"KXBTC15M-26OCT191145-45":undefined;
  const r=await verifyMonetaryFeeContract(stage,market,fetcher,Date.now,validPdf);
  assert.equal(r.ok,false);
  assert.equal(r.monetaryFeeAuthorized,false);
  assert.equal(r.policyApproved,false);
  assert.equal(r.tradingAuthorized,false);
 }
});

test("all stages reject unavailable official monetary proof before API use",async()=>{
 let calls=0;
 const fetcher=(async()=>{calls++;throw Error("unexpected API read");}) as typeof fetch;
 const missing=async()=>{throw Error("official schedule unavailable");};
 for(const stage of ["STEP_9","STEP_11","ORDER_ENTRY"] as const){
  const r=await verifyMonetaryFeeContract(stage,stage==="ORDER_ENTRY"?"KXBTC15M-26OCT191145-45":undefined,fetcher,Date.now,missing);
  assert.equal(r.ok,false);
  assert.equal(r.reason,"official_monetary_fee_source_unavailable");
  assert.equal(r.monetaryFeeAuthorized,false);
 }
 assert.equal(calls,0);
});

const fixtureClock=Date.parse("2026-10-15T22:00:00Z");
const marketTicker="KXBTC15M-26OCT15T2200";
function feeApiPages(){
 const close="2026-10-15T22:12:00Z", expiration="2026-10-15T22:13:00Z";
 return {
  "/markets?series_ticker=KXBTC15M&status=open&limit=100":{
   markets:[{ticker:marketTicker,event_ticker:marketTicker,close_time:close,status:"open"}],cursor:""},
  ["/markets/"+marketTicker]:{
   market:{ticker:marketTicker,event_ticker:marketTicker,close_time:close,status:"open",exchange_index:2,open_time:"2026-10-15T21:59:00Z",
   expiration_time:expiration,latest_expiration_time:expiration,expected_expiration_time:expiration}},
  ["/events/"+marketTicker]:{event:{event_ticker:marketTicker,series_ticker:"KXBTC15M",
   fee_type_override:null,fee_multiplier_override:null}},
  "/series/KXBTC15M":{series:{ticker:"KXBTC15M",exchange_index:2,
   fee_type:"quadratic",fee_multiplier:1}},
  "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false":{
   series_fee_change_arr:[],cursor:""},
  ["/events/fee_changes?event_ticker="+marketTicker+"&limit=100"]:{
   event_fee_changes:[],cursor:""},
 } as Record<string,Record<string,unknown>>;
}
function kalshiFeed(pages:Record<string,Record<string,unknown>>):typeof fetch{
 return (async(request:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  assert.equal(init?.method,"GET");
  assert.equal(init?.redirect,"error");
  const url=String(request),base="https://external-api.kalshi.com/trade-api/v2";
  assert.ok(url.startsWith(base+"/"));
  return new Response(JSON.stringify(pages[url.slice(base.length)]??{}),{
   status:200,headers:{"content-type":"application/json"}});
 }) as typeof fetch;
}
const pinnedPdfProof=async()=>({ok:true as const,digest:"d".repeat(64),
 diagnostic:{httpStatus:200,contentType:"application/pdf",
 finalOrigin:"https://kalshi.com",finalPathname:"/docs/kalshi-fee-schedule.pdf",
 retryAfterSeconds:null,networkAttempts:1}});

test("official monetary proof plus full exact-market Kalshi metadata qualifies source only",async()=>{
 for(const stage of ["STEP_9","STEP_11","ORDER_ENTRY"] as const){
  const result=await verifyMonetaryFeeContract(stage,
   stage==="ORDER_ENTRY"?marketTicker:undefined,
   kalshiFeed(feeApiPages()),()=>fixtureClock,pinnedPdfProof);
  assert.equal(result.ok,true);
  assert.equal(result.monetaryFeeAuthorized,true);
  assert.equal(result.marketTicker,marketTicker);
  assert.equal(result.sourceDigest,"d".repeat(64));
  assert.equal(result.policyApproved,false);
  assert.equal(result.tradingAuthorized,false);
 }
});

test("official monetary proof cannot override wrong multiplier, event fee exception or scheduled change",async()=>{
 for(const patch of ["multiplier","override","future_change"] as const){
  const pages=feeApiPages();
  if(patch==="multiplier")
   (pages["/series/KXBTC15M"].series as Record<string,unknown>).fee_multiplier=2;
  if(patch==="override")
   (pages["/events/"+marketTicker].event as Record<string,unknown>).fee_multiplier_override=2;
  if(patch==="future_change")
   pages["/series/fee_changes?series_ticker=KXBTC15M&show_historical=false"].series_fee_change_arr=[
    {id:"fee_change_1",scheduled_ts:"2026-10-15T22:03:00Z"}];
  const outcome=await verifyMonetaryFeeContract("ORDER_ENTRY",marketTicker,
   kalshiFeed(pages),()=>fixtureClock,pinnedPdfProof);
  assert.equal(outcome.ok,false,patch);
  assert.equal(outcome.monetaryFeeAuthorized,false,patch);
  assert.equal(outcome.tradingAuthorized,false,patch);
 }
});

test("wrong exact market never qualifies even with an official monetary digest",async()=>{
 const proof=await verifyMonetaryFeeContract("ORDER_ENTRY","KXBTC15M-26OCT15T2215",
  kalshiFeed(feeApiPages()),()=>fixtureClock,pinnedPdfProof);
 assert.equal(proof.ok,false);
 assert.equal(proof.monetaryFeeAuthorized,false);
});

test("429 proof source origin and retry time reach fee contract without generating an approval",async()=>{
 const date="2026-10-24T22:46:58.810Z";
 for(const origin of ["provider","shared_cooldown","backend_local","bridge_unclassified"] as const){
   const proof={ok:false as const,reason:"official_fee_schedule_http_429",diagnostic:{
     httpStatus:429,contentType:null,finalOrigin:null,finalPathname:null,
     retryAfterSeconds:60,networkAttempts:origin==="backend_local"?0:1,
     rateLimitOrigin:origin,retryAt:date,
   }};
   const r=await verifyMonetaryFeeContract("STEP_9",undefined,globalThis.fetch,Date.now,
      async()=>proof);
   assert.equal(r.ok,false);
   assert.equal(r.reason,"official_fee_schedule_http_429_"+origin);
   assert.equal(r.rateLimitOrigin,origin);
   assert.equal(r.retryAt,date);
   assert.equal(r.monetaryFeeAuthorized,false);
   assert.equal(r.tradingAuthorized,false);
 }
});
