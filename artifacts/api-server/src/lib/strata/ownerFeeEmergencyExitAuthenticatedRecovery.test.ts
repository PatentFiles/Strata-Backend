import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync} from "node:crypto";
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
 badOrder?:boolean;differentPosition?:boolean;noBaseline?:boolean;
 failPages?:boolean;badOrderStatus?:boolean}={}){
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
     position_observed_at_ms:NOW-200}]};
 }};
 const readFeeds=(async()=>{
  if(options.failPages)return {ok:false as const,reason:"exchange_history_unavailable"};
  return {ok:true as const,observedAtMs:NOW,cashMicros:"0",
   orders:[{client_order_id:ID,order_id:"order-1",ticker:MARKET,
     book_side:selected.order.side,subaccount_number:1,exchange_index:2,
     initial_count_fp:"2.00",status:options.badOrderStatus?"pending":"executed"}],
   fills:[...(Number(filled)>0?[{trade_id:"t-1",order_id:options.badOrder?"other":"order-1",
      ticker:MARKET,count_fp:filled,created_time:new Date(NOW).toISOString()}]:[]),
    ...(options.foreignFill?[{trade_id:"foreign",order_id:"other",ticker:MARKET,
       count_fp:"0.25",created_time:new Date(NOW).toISOString()}]:[])],
   positions:[{ticker:MARKET,position_fp:options.differentPosition?"0.00":ending}],
   settlements:[]};
 }) as typeof readOwnedKalshiFeeds;
 return {run:()=>readAuthenticatedProtectiveExitOutcome(selected,signedReceipt,
  {db,readFeeds,now:()=>NOW})};
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
  {foreignFill:true},{differentPosition:true},{badOrder:true}]){
  await assert.rejects(()=>harness(options).run());
 }
});
