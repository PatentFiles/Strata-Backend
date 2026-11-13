import test from "node:test";
import assert from "node:assert/strict";
import {reconcileWalletV4OrderFees} from "./walletV4FeeReceiptReconciliation";
const original={
 ownerId:"11111111-1111-4111-8111-111111111111",
 accountId:"index2-subaccount1-owner",
 orderId:"v13p-11111111-1111-4111-8111-111111111111",
 ticker:"KXBTC15M-26OCT231915",expectedModelDigest:"b".repeat(64),
 authorizedGrossMicros:"5000000",maximumEntryFeesMicros:"200000",
 expectedFilledHundredths:"1000",feeReservedMicros:"200000",
};
const proof={source:"kalshi_server_authenticated" as const,ownerId:original.ownerId,
 accountId:original.accountId,orderId:original.orderId,marketTicker:original.ticker,
 observedAtMs:Date.now(),complete:true as const,authoritativeFillDigest:"e".repeat(64)};
const fills=[
 {tradeId:"t-001",orderId:original.orderId,ticker:original.ticker,
   quantityHundredths:"600",executionPriceTicks:5000,
   exchangeFeeMicros:"120000",feeVerified:true},
 {tradeId:"t-002",orderId:original.orderId,ticker:original.ticker,
   quantityHundredths:"400",executionPriceTicks:4900,
   exchangeFeeMicros:"80000",feeVerified:true},
];
test("exact Kalshi-derived split-fill fees reconcile against original fee bounds",()=>{
 const result=reconcileWalletV4OrderFees(original,fills,true,proof);
 assert.equal(result.ok,true);
 if(result.ok){
  assert.equal(result.filledHundredths,"1000");
  assert.equal(result.actualFeeMicros,"200000");
  assert.equal(result.netCashDebitMicros,"5160000");
  assert.equal(result.needsAdjustment,false);
  assert.equal(result.receiptDigest.length,64);
  assert.equal(result.tradingAuthorized,false);
  assert.equal(reconcileWalletV4OrderFees(original,[...fills].reverse(),true,proof).ok,true);
 }
});
test("zero-fill completed IOC produces zero fees only if ledger also says zero",()=>{
 const l={...original,expectedFilledHundredths:"0"};
 const r=reconcileWalletV4OrderFees(l,[],true,proof);
 assert.equal(r.ok,true);
 if(r.ok){assert.equal(r.actualFeeMicros,"0");assert.equal(r.needsAdjustment,true);}
 assert.equal(reconcileWalletV4OrderFees(original,[],true,proof).ok,false);
});
test("incomplete, duplicate, incorrect owner order and bad fee receipts fail closed",()=>{
 const bad=[
   [original,fills,false],
   [original,[fills[0],fills[0]],true],
   [original,[{...fills[0],orderId:"other"},fills[1]],true],
   [original,[{...fills[0],ticker:"OTHER"},fills[1]],true],
   [original,[{...fills[0],feeVerified:false},fills[1]],true],
   [original,[{...fills[0],exchangeFeeMicros:"-1"},fills[1]],true],
   [original,[{...fills[0],exchangeFeeMicros:"9999999"},fills[1]],true],
   [{...original,maximumEntryFeesMicros:"100000"},fills,true],
   [{...original,authorizedGrossMicros:"4900000"},fills,true],
   [{...original,feeReservedMicros:"100000"},fills,true],
   [{...original,expectedFilledHundredths:"999"},fills,true],
   [{...original,expectedModelDigest:""},fills,true],
 ] as const;
 for(const [l,f,c] of bad)
  assert.equal(reconcileWalletV4OrderFees(l,f,c,proof).ok,false);
});

test("Wallets rejects receipt input without server-bound source proof",()=>{
 assert.equal(reconcileWalletV4OrderFees(original,fills,true).ok,false);
 assert.equal(reconcileWalletV4OrderFees(original,fills,true,{...proof,ownerId:"other"}).ok,false);
 assert.equal(reconcileWalletV4OrderFees(original,fills,true,{...proof,observedAtMs:0}).ok,false);
});
