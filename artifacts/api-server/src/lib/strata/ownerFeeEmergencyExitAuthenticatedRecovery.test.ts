import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync,createHash} from "node:crypto";
import {readAuthenticatedProtectiveExitOutcome} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import {reconcileUnknownProtectiveExitAfterRestart} from "./ownerFeeEmergencyExitRestartRecovery";
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
 receiptWaitMs?:number;fullyClosed?:boolean;omitPosition?:boolean;
 wallElapsedMs?:number;monotonicElapsedMs?:number;observationAgeMs?:number;
 startMonotonicMs?:number;baselineWallElapsedMs?:number;baselineMonotonicElapsedMs?:number;
 startWallMs?:number;throwWallAt?:number;throwMonotonicAt?:number;}={}){
 const startedAt=options.startWallMs??NOW+(options.receiptWaitMs??0);
 let wall=startedAt,monotonic=options.startMonotonicMs??1000;
 const calls={baseline:0,feed:0,wall:0,monotonic:0};
 const filled=options.fill??"1.00";
 const baselineUnits=options.fullyClosed?2:3;
 const position=(baselineUnits-Number(filled)).toFixed(2);
 const initial=options.side==="bid"?"-"+baselineUnits.toFixed(2):baselineUnits.toFixed(2);
 const ending=options.side==="bid"?"-"+position:position;
 const selected={...input,order:{...input.order,side:options.side??"ask"}};
 const signedReceipt={...receipt,fill_count:filled,
  remaining_count:(2-Number(filled)).toFixed(2)};
 const db={query:async(sql:string,args?:unknown[])=>{
   calls.baseline++;
   assert.match(sql,/^SELECT /,"recovery evidence must leave UNKNOWN untouched");
   assert.match(sql,/r.state='UNKNOWN'/);
   assert.equal(args?.[0],RES);assert.equal(args?.[1],OWNER);
   wall+=options.baselineWallElapsedMs??0;
   monotonic+=options.baselineMonotonicElapsedMs??0;
   return {rows:options.noBaseline?[]:[{initial_position_fp:initial,
     position_observed_at_ms:NOW-(options.restart?120_000:200),
     order_digest:options.badDigest?"f".repeat(64):
      createHash("sha256").update(JSON.stringify(selected.order)).digest("hex")}]};
 }};
 const readFeeds=(async(_material,observedAt)=>{
  calls.feed++;
  assert.equal(observedAt,startedAt,"provider observation time must not be renewed");
  wall+=options.wallElapsedMs??0;
  monotonic+=options.monotonicElapsedMs??0;
  if(options.failPages)return {ok:false as const,reason:"exchange_history_unavailable"};
  return {ok:true as const,historicalCoverageComplete:true,observedAtMs:startedAt-(options.observationAgeMs??0),cashMicros:"0",
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
   positions:options.omitPosition?[]:[{ticker:MARKET,position_fp:options.differentPosition?"0.00":ending}],
   settlements:[]};
 }) as typeof readOwnedKalshiFeeds;
 return {calls,run:()=>readAuthenticatedProtectiveExitOutcome(selected,options.restart?null:signedReceipt,
  {db,readFeeds,now:()=>{
    if(++calls.wall===options.throwWallAt)throw Error("test_wall_clock_failed");return wall;
   },monotonicNow:()=>{
    if(++calls.monotonic===options.throwMonotonicAt)throw Error("test_monotonic_clock_failed");return monotonic;
   }})};
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

test("fully closed market missing from unsettled positions remains UNKNOWN",async()=>{
 // Kalshi Get Positions documents unsettled positions by default. An empty
 // page does not itself cryptographically attest that inventory is zero.
 // A fully filled terminal order and authenticated fills are insufficient
 // to infer the account inventory without a matching complete position proof.
 for(const restart of [false,true]){
  await assert.rejects(
   ()=>harness({restart,fill:"2.00",fullyClosed:true,omitPosition:true}).run(),
   /exit_recovery_position_not_unique/,
  );
 }
});
test("fully closed market with explicit scoped zero-position evidence reconciles",async()=>{
 const result=await harness({restart:true,fill:"2.00",fullyClosed:true}).run();
 assert.equal(result.initialPositionFp,"2.00");
 assert.equal(result.observedPositionFp,"0.00");
 assert.equal(result.authenticatedOrder?.status,"executed");
 assert.equal(result.response,null);
});

test("signed recovery scan retains the inclusive three-second lifetime",async()=>{
 for(const restart of [false,true]){
  for(const elapsed of [0,2999,3000]){
   const result=await harness({restart,wallElapsedMs:elapsed,monotonicElapsedMs:elapsed}).run();
   assert.equal(result.observedPositionFp,"2.00");
   assert.equal(result.authenticatedOrder?.fill_count_fp,"1.00");
  }
  await assert.rejects(()=>harness({restart,wallElapsedMs:3001,monotonicElapsedMs:3001}).run(),
   /exit_recovery_exchange_snapshot_stale/);
 }
});
test("wall or monotonic elapsed alone can expire recovery evidence",async()=>{
 for(const options of [
  {wallElapsedMs:3001,monotonicElapsedMs:0},
  {wallElapsedMs:0,monotonicElapsedMs:3001},
  {wallElapsedMs:1,monotonicElapsedMs:3001},
 ])await assert.rejects(()=>harness(options).run(),/exit_recovery_exchange_snapshot_stale/);
});
test("baseline read and signed feed share the original observation budget",async()=>{
 for(const restart of [false,true]){
  assert.equal((await harness({restart,baselineWallElapsedMs:1000,baselineMonotonicElapsedMs:1000,
   wallElapsedMs:2000,monotonicElapsedMs:2000}).run()).observedPositionFp,"2.00");
  for(const options of [
   {baselineWallElapsedMs:3001,baselineMonotonicElapsedMs:3001},
   {baselineWallElapsedMs:0,baselineMonotonicElapsedMs:3001},
   {baselineWallElapsedMs:1000,baselineMonotonicElapsedMs:1000,wallElapsedMs:2001,monotonicElapsedMs:2001},
  ])await assert.rejects(()=>harness({restart,...options}).run(),/exit_recovery_exchange_snapshot_stale/);
 }
});
test("original observation age consumes the scan budget without restamping",async()=>{
 assert.equal((await harness({observationAgeMs:1000,wallElapsedMs:2000,monotonicElapsedMs:2000}).run()).observedPositionFp,"2.00");
 for(const options of [
  {observationAgeMs:1000,wallElapsedMs:2001,monotonicElapsedMs:0},
  {observationAgeMs:1000,wallElapsedMs:0,monotonicElapsedMs:2001},
  {observationAgeMs:-1},
  {observationAgeMs:NaN},
 ])await assert.rejects(()=>harness(options).run(),/exit_recovery_exchange_snapshot_stale/);
});
test("invalid or regressed recovery clocks fail closed",async()=>{
 for(const options of [
  {wallElapsedMs:-1},
  {monotonicElapsedMs:-1},
  {wallElapsedMs:NaN},
  {wallElapsedMs:Infinity},
  {monotonicElapsedMs:NaN},
  {monotonicElapsedMs:Infinity},
  {startMonotonicMs:-1},
  {startMonotonicMs:NaN},
  {startMonotonicMs:Infinity},
 ])await assert.rejects(()=>harness(options).run(),/exit_recovery_exchange_snapshot_stale/);
});
test("expired scan keeps restart UNKNOWN without terminal persistence or POST",async()=>{
 let persisted=0;
 const result=await reconcileUnknownProtectiveExitAfterRestart(input,{
  readOutcome:async()=>harness({restart:true,wallElapsedMs:0,monotonicElapsedMs:3001}).run(),
  persistReconciled:async()=>{persisted++;return {committed:true,commitState:"COMMITTED",freshnessVerified:true,reason:"unexpected",mayRetry:false,tradingAuthorized:false};},
 });
 assert.equal(result.state,"UNKNOWN");
 assert.equal(result.reason,"authenticated_restart_history_unproven");
 assert.equal(result.mayRetry,false);
 assert.equal(result.postAttempted,false);
 assert.equal(persisted,0);
});
test("invalid initial wall clock rejects before baseline, feed or persistence",async()=>{
 for(const startWallMs of [NaN,Infinity,-Infinity,NOW+0.5]){
  const h=harness({restart:true,startWallMs});
  await assert.rejects(()=>h.run(),/exit_recovery_exchange_snapshot_stale/);
  assert.equal(h.calls.baseline,0);assert.equal(h.calls.feed,0);
  let persisted=0;
  const result=await reconcileUnknownProtectiveExitAfterRestart(input,{
   readOutcome:async()=>h.run(),
   persistReconciled:async()=>{persisted++;return {committed:true,commitState:"COMMITTED",freshnessVerified:true,reason:"unexpected",mayRetry:false,tradingAuthorized:false};},
  });
  assert.equal(result.state,"UNKNOWN");assert.equal(result.postAttempted,false);
  assert.equal(persisted,0);assert.equal(h.calls.baseline,0);assert.equal(h.calls.feed,0);
 }
});
test("throwing either clock at start or completion keeps restart UNKNOWN",async()=>{
 for(const options of [{throwWallAt:1},{throwWallAt:2},{throwMonotonicAt:1},{throwMonotonicAt:2}]){
  const h=harness({restart:true,...options});let persisted=0;
  const result=await reconcileUnknownProtectiveExitAfterRestart(input,{
   readOutcome:async()=>h.run(),
   persistReconciled:async()=>{persisted++;return {committed:true,commitState:"COMMITTED",freshnessVerified:true,reason:"unexpected",mayRetry:false,tradingAuthorized:false};},
  });
  assert.equal(result.state,"UNKNOWN");assert.equal(result.reason,"authenticated_restart_history_unproven");
  assert.equal(result.mayRetry,false);assert.equal(result.postAttempted,false);assert.equal(persisted,0);
  if(options.throwWallAt===1||options.throwMonotonicAt===1){
   assert.equal(h.calls.baseline,0);assert.equal(h.calls.feed,0);
  }
 }
});
