// Shared synthetic fixtures for deadline unit and disposable PostgreSQL tests.
// Every exchange response and SQL operation below is local synthetic evidence.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from "@workspace/v13-strategy";
import {readAuthenticatedProtectiveExitOutcome} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import {persistAuthenticatedExitReconciliation} from "./ownerFeeEmergencyExitReconciliationCommit";
import {reconcileUnknownProtectiveExitAfterRestart} from "./ownerFeeEmergencyExitRestartRecovery";
import {dispatchReviewedProtectiveExitOnce} from "./ownerFeeEmergencyExitSignedDispatch";
import type {readOwnedKalshiFeeds} from "./personalExchangeRead";

const NOW=Date.parse("2026-10-19T20:00:00Z");
const OWNER="11111111-1111-4111-8111-111111111111";
const RES="22222222-2222-4222-8222-222222222222";
const CID="v13p-33333333-3333-4333-8333-333333333333";
const MARKET="KXBTC15M-26OCT191545-45";
const privateKey=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
const input={ownerId:OWNER,accountId:"offline-account",reservationId:RES,
 material:{keyId:"ephemeral-offline-test-only",privateKey},
 lease:{holderId:"offline-worker",fencingToken:1},
 order:{ticker:MARKET,client_order_id:CID,count:"2.00",price:"0.5500",side:"ask",
  reduce_only:true,post_only:false,time_in_force:"immediate_or_cancel",
  self_trade_prevention_type:"taker_at_cross",subaccount:1,exchange_index:2}};
const receipt={httpStatus:201,client_order_id:CID,order_id:"offline-order",
 fill_count:"1.00",remaining_count:"1.00",ts_ms:NOW};
function fixture(){
 const clock={wall:NOW,mono:1000,throwWall:false,throwMonotonic:false};
 const ownedInput=structuredClone(input),ownedReceipt=structuredClone(receipt);
 const hooks:{baseline?:()=>void|Promise<void>;feed?:()=>void|Promise<void>;feedResult?:(value:Record<string,unknown>)=>void;
  db?:{query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>}}={};
 const advance=(ms:number)=>{clock.wall+=ms;clock.mono+=ms;};
 const read=async(response:typeof receipt|null,delayMs=0)=>readAuthenticatedProtectiveExitOutcome(ownedInput,response,{
  now:()=>{if(clock.throwWall)throw Error("clock_failed");return clock.wall;},monotonicNow:()=>{if(clock.throwMonotonic)throw Error("clock_failed");return clock.mono;},
  db:hooks.db??{query:async()=>{await hooks.baseline?.();return {rows:[{initial_position_fp:"3.00",position_observed_at_ms:NOW-200,
   order_digest:createHash("sha256").update(JSON.stringify(input.order)).digest("hex")}]};}},
  readFeeds:(async(_material,observedAtMs)=>{
   await hooks.feed?.();advance(delayMs);
   const result={ok:true,historicalCoverageComplete:true,observedAtMs,cashMicros:"0",settlements:[],
    positions:[{ticker:MARKET,position_fp:"2.00",subaccount_number:1,exchange_index:2}],
    orders:[{client_order_id:CID,order_id:"offline-order",ticker:MARKET,book_side:"ask",
     subaccount_number:1,exchange_index:2,created_time:new Date(NOW-100).toISOString(),
     yes_price_dollars:"0.5500",fill_count_fp:"1.00",remaining_count_fp:"0.00",
     initial_count_fp:"2.00",status:"canceled"}],
    fills:[{trade_id:"offline-fill",order_id:"offline-order",ticker:MARKET,count_fp:"1.00",
     subaccount_number:1,exchange_index:2,created_time:new Date(NOW).toISOString()}]};
     hooks.feedResult?.(result);return result;
  }) as typeof readOwnedKalshiFeeds,
 });
 return {clock,advance,read,input:ownedInput,receipt:ownedReceipt,hooks};
}
function signedPorts(f:ReturnType<typeof fixture>){
 const calls={mockPosts:0,persist:0,markerState:"PREPARED"};
 const db={connect:async()=>({release(){},query:async(sql:string)=>{
  if(sql.startsWith("SELECT release_id FROM private.strata_standing_execution_reviews"))return {rows:[]};
  if(sql.startsWith("SELECT r.reservation_id"))return {rows:[{
   reservation_id:RES,reservation_age_ms:0,heartbeat_age_ms:0,max_quote_age_ms:5000,
   source_age_ms:0,release_remaining_ms:60000,
   owned_evaluation:{sourcePaperEvaluationId:"offline-source",source:{id:"offline-source",
    market_ticker:MARKET,strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,
    strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,evaluated_at:new Date(NOW).toISOString(),
    feed_freshness:"current",btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0}},
  }]};
  return {rows:[]};
 }})};
 return {calls,ports:{db,monotonicNow:()=>f.clock.mono,
  verifyFee:(async()=>({ok:true,monetaryFeeAuthorized:true,marketTicker:MARKET})) as never,
  mark:(async()=>{if(calls.markerState==="UNKNOWN")return {unknownRecorded:false};calls.markerState="UNKNOWN";return {unknownRecorded:true,clientOrderId:CID,mayRetry:false,transportAuthorized:false};}) as never,
  post:async()=>{calls.mockPosts++;return receipt;},
 }};
}

export {NOW,input,receipt,fixture,signedPorts};
