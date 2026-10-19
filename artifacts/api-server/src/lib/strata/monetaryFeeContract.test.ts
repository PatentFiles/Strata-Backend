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
 const fetcher=(async()=>{throw Error("offline");}) as typeof fetch;
 for(const stage of ["STEP_9","STEP_11","ORDER_ENTRY"] as const){
  const market=stage==="ORDER_ENTRY"?"KXBTC15M-26OCT191145-45":undefined;
  const r=await verifyMonetaryFeeContract(stage,market,fetcher);
  assert.equal(r.ok,false);
  assert.equal(r.monetaryFeeAuthorized,false);
  assert.equal(r.policyApproved,false);
  assert.equal(r.tradingAuthorized,false);
 }
});
