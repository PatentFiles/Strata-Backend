import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync,createHash} from "node:crypto";
import {readAuthenticatedProtectiveExitOutcome} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import type {readOwnedKalshiFeeds} from "./personalExchangeRead";
const NOW=Date.parse("2026-10-19T20:00:00Z");
const OWNER="11111111-1111-4111-8111-111111111111";
const RES="22222222-2222-4222-8222-222222222222";
const ID="v13p-33333333-3333-4333-8333-333333333333";
const MARKET="KXBTC15M-26OCT191545-45";
const SECRET=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
const input={ownerId:OWNER,accountId:"owner-execution-2",reservationId:RES,
 material:{keyId:"ephemeral-test-only",privateKey:SECRET},
 order:{ticker:MARKET,client_order_id:ID,count:"2.00",price:"0.5500",
  side:"ask",reduce_only:true,post_only:false,time_in_force:"immediate_or_cancel",
  self_trade_prevention_type:"taker_at_cross",subaccount:1,exchange_index:2}};
const receipt={httpStatus:201,client_order_id:ID,order_id:"order-1",
 fill_count:"1.00",remaining_count:"1.00",ts_ms:NOW};
function harness(options:{fill?:string;side?:"ask"|"bid";foreignFill?:boolean;
 badOrder?:boolean;differentPosition?:boolean;noBaseline?:boolean;restart?:boolean;
 failPages?:boolean;badOrderStatus?:boolean;badPrice?:boolean;badFillMarket?:boolean;
 badProviderTotals?:boolean;duplicateOrder?:boolean;concurrentOrder?:boolean;badDigest?:boolean;
 missingOrderScope?:boolean;wrongOrderScope?:boolean;missingFillScope?:boolean;
 wrongFillScope?:boolean;oldOrder?:boolean;oldFill?:boolean;
 receiptWaitMs?:number;}={}){
 const filled=options.fill??"1.00",position=(3-Number(filled)).toFixed(2);
 const initial=options.side==="bid"?"-3.00":"3.00";
 const ending=options.side==="bid"?"-"+position:position;
 const selected={...input,order:{...input.order,side:options.side??"ask"}};
 const signedReceipt={...receipt,fill_count:filled,
  remaining_count:(2-Number(filled)).toFixed(2)};
 const db={query:async(sql:string,args?:unknown[])=>{
   assert.match(sql,/r.state='UNKNOWN'/);
   assert.equal(args?.[0],RES);assert.equal(args?.[1],OWNER);
   return {rows:options.noBaseline?[]:[{initial_position_fp:initial,
     position_observed_at_ms:NOW-(options.restart?120_000:200),
     order_digest:options.badDigest?"f".repeat(64):
      createHash("sha256").update(JSON.stringify(selected.order)).digest("hex")}]};
 }};
 const readFeeds=(async()=>{
  if(options.failPages)return {ok:false as const,reason:"exchange_history_unavailable"};
  return {ok:true as const,observedAtMs:NOW+(options.receiptWaitMs??0),cashMicros:"0",
   orders:[{client_order_id:ID,order_id:"order-1",ticker:MARKET,
     book_side:selected.order.side,
     subaccount_number:options.missingOrderScope?undefined:options.wrongOrderScope?0:1,
     exchange_index:options.missingOrderScope?undefined:2,
     created_time:new Date(NOW-(options.oldOrder?180_000:100)).toISOString(),
     yes_price_dollars:options.badPrice?"0.9000":"0.5500",fill_count_fp:filled,
     remaining_count_fp:options.badProviderTotals?"0.50":"0.00",
     initial_count_fp:"2.00",status:options.badOrderStatus?"pending":filled==="2.00"?"executed":"canceled"},
     ...(options.duplicateOrder?[{client_order_id:ID,order_id:"order-dup",ticker:MARKET}]:[]),
     ...(options.concurrentOrder?[{client_order_id:"foreign",order_id:"order-concurrent",
      ticker:MARKET,created_time:new Date(NOW).toISOString(),status:"executed"}]:[])],
   fills:[...(Number(filled)>0?[{trade_id:"t-1",order_id:options.badOrder?"other":"order-1",
      ticker:options.badFillMarket?"OTHER":MARKET,count_fp:filled,
      subaccount_number:options.missingFillScope?undefined:options.wrongFillScope?0:1,
      exchange_index:options.missingFillScope?undefined:2,
      created_time:new Date(NOW-(options.oldFill?180_000:0)).toISOString()}]:[]),
    ...(options.foreignFill?[{trade_id:"foreign",order_id:"other",ticker:MARKET,
       count_fp:"0.25",created_time:new Date(NOW).toISOString()}]:[])],
   positions:[{ticker:MARKET,position_fp:options.differentPosition?"0.00":ending}],
   settlements:[]};
 }) as typeof readOwnedKalshiFeeds;
 return {run:()=>readAuthenticatedProtectiveExitOutcome(selected,options.restart?null:signedReceipt,
  {db,readFeeds,now:()=>NOW+(options.receiptWaitMs??0)})};
}
test("zero, partial and full signed account history reconcile against immutable baseline",async()=>{
 for(const fill of ["0.00","1.00","2.00"]){
  const result=await harness({fill}).run();
  assert.equal(result.completeExchangeHistory,true);
  assert.equal(result.exactMarketAndAccountMatched,true);
  assert.equal(result.orderAndFillHistoryMatched,true);
  assert.equal(result.initialPositionFp,"3.00");
  assert.equal(result.response?.fill_count,fill);
 }
});
test("NO holdings reduce by bid and preserve signed position orientation",async()=>{
 const result=await harness({side:"bid",fill:"1.00"}).run();
 assert.equal(result.initialPositionFp,"-3.00");
 assert.equal(result.observedPositionFp,"-2.00");
 assert.equal(result.reducingBookSide,"bid");
});
test("absent baseline, incomplete history, bad status, unrelated fills, or position mismatch fail closed",async()=>{
 for(const options of [{noBaseline:true},{failPages:true},{badOrderStatus:true},
  {foreignFill:true},{differentPosition:true},{badOrder:true},
  {badPrice:true},{badFillMarket:true}]){
  await assert.rejects(()=>harness(options).run());
 }
});

test("restart after 120 seconds recovers UNKNOWN from authenticated order and fills with no POST",async()=>{
 const result=await harness({restart:true,fill:"1.00"}).run();
 assert.equal(result.observedPositionFp,"2.00");
 assert.equal(result.response,null);
 assert.equal(result.authenticatedOrder?.order_id,"order-1");
 assert.equal(result.authenticatedOrder?.fill_count_fp,"1.00");
});
test("restart fails closed on missing provider history, concurrent fills, or conflicting balance",async()=>{
 for(const options of [{restart:true,failPages:true},{restart:true,foreignFill:true},
  {restart:true,differentPosition:true},{restart:true,badOrderStatus:true},
  {restart:true,badProviderTotals:true},{restart:true,duplicateOrder:true},
  {restart:true,concurrentOrder:true},{restart:true,badDigest:true}])
  await assert.rejects(()=>harness(options).run());
});

test("canceled IOC has zero resting quantity even after partial or zero fill",async()=>{
 for(const fill of ["0.00","1.00"]){
  const result=await harness({restart:true,fill}).run();
  assert.equal(result.response,null);
  assert.equal(result.authenticatedOrder?.status,"canceled");
  assert.equal(result.authenticatedOrder?.remaining_count_fp,"0.00");
  assert.equal(result.authenticatedOrder?.fill_count_fp,fill);
 }
});
test("nonzero resting quantity cannot establish terminal IOC recovery",async()=>{
 await assert.rejects(()=>harness({restart:true,badProviderTotals:true}).run());
});

test("authenticated recovery rejects missing/foreign order and fill account provenance",async()=>{
 for(const testCase of [
  {restart:true,missingOrderScope:true},{restart:true,wrongOrderScope:true},
  {restart:true,missingFillScope:true},{restart:true,wrongFillScope:true},
  {restart:true,oldOrder:true},{restart:true,oldFill:true}
 ]){
  await assert.rejects(()=>harness(testCase).run());
 }
});
test("full/partial/zero IOC scoped provider history remains recoverable",async()=>{
 for(const fill of ["0.00","1.00","2.00"]){
  const recovered=await harness({restart:true,fill}).run();
  assert.equal(recovered.orderAndFillHistoryMatched,true);
  assert.equal(recovered.response,null);
  assert.equal(recovered.authenticatedOrder?.fill_count_fp,fill);
 }
});

// A witnessed POST receipt does not expire merely because a scoped provider
// history read is delayed. The immutable request, timestamps, fills and
// inventory must still match; this test submits no exchange order.
test("late witnessed HTTP 201 can reconcile from complete signed history",async()=>{
 const result=await harness({receiptWaitMs:120_000,fill:"1.00"}).run();
 assert.equal(result.response?.httpStatus,201);
 assert.equal(result.authenticatedOrder?.status,"canceled");
 assert.equal(result.observedPositionFp,"2.00");
});
