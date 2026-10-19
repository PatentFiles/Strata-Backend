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
