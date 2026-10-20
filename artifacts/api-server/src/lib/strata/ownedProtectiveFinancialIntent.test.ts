import assert from "node:assert/strict";
import test from "node:test";
import {sealedFinancialProtectiveExitOrder} from "./ownedProtectiveFinancialIntent";
import type {MarketEvidence,Request} from "../v13-production/types";
const market="KXBTC15M-26OCT191945-45";
const clientOrderId="v13p-33333333-3333-4333-8333-333333333333";
const selection={
 positionId:"22222222-2222-4222-8222-222222222222",
 market,side:"YES" as "YES"|"NO",
 quantityHundredths:"200",minimumExitMicros:10000,
};
const request:Request={market,side:"YES",action:"SELL",
 contracts:2,limitMicros:550000,timeInForce:"IOC",
 reduceOnly:true,clientOrderId};
const book:MarketEvidence={
 observedAtMs:Date.now(),bestBidDollars:"0.5500",
 bids:[{priceDollars:"0.5500",availableContracts:"5.00"}],
 bestAskDollars:"0.5600",
 asks:[{priceDollars:"0.5600",availableContracts:"5.00"}],
 fee:{policyVersion:"test",sourceUrl:"test",formulaVersion:"test",
  fingerprint:"a".repeat(64),verifiedAtMs:Date.now(),
  contracts:2,limitPrice:0.55,reservedEntryFeeCents:1,reservedExitFeeCents:1},
};
test("YES owned EXIT shares immutable V13 client ID, price and amount",()=>{
 const x=sealedFinancialProtectiveExitOrder(selection,request,book);
 assert.equal(x.client_order_id,clientOrderId);
 assert.equal(x.side,"ask");assert.equal(x.price,"0.5500");
 assert.equal(x.count,"2.00");assert.equal(x.reduce_only,true);
 assert.equal(x.time_in_force,"immediate_or_cancel");
 assert.equal(x.subaccount,1);assert.equal(x.exchange_index,2);
});
test("NO reduces NO position with complementary YES bid and same V13 identity",()=>{
 const x=sealedFinancialProtectiveExitOrder(
  {...selection,side:"NO"},{...request,side:"NO"},book);
 assert.equal(x.side,"bid");assert.equal(x.price,"0.4500");
 assert.equal(x.client_order_id,clientOrderId);
});
test("modified sealed intent, stale depth or floor fails closed without POST",()=>{
 for(const mismatch of [
  {...request,clientOrderId:"arbitrary-client"},
  {...request,contracts:3},
  {...request,limitMicros:560000},
  {...request,action:"BUY" as const},
  {...request,reduceOnly:false},
  {...request,side:"NO" as const},
 ]){
  assert.throws(()=>sealedFinancialProtectiveExitOrder(selection,mismatch as Request,book));
 }
 assert.throws(()=>sealedFinancialProtectiveExitOrder(
  {...selection,minimumExitMicros:560000},request,book));
 assert.throws(()=>sealedFinancialProtectiveExitOrder(
  selection,request,{...book,bestBidDollars:"0.5400",
   bids:[{priceDollars:"0.5400",availableContracts:"5.00"}]}));
});
