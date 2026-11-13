import assert from "node:assert/strict";
import test from "node:test";
import {prepareDemoIocOnce,consumeDemoIocUnknown,finalizeVerifiedDemoIoc}
 from "./kalshiDemoIocLedger";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
const identity={
 ownerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
 demoAccountId:"demo-account-1",
 attemptId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 operatorApprovalId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
 workerHolderId:"worker-1",
 workerFencingToken:7,
};
const order:EmergencyExitOrder={
 ticker:"KXBTC15M-26OCT161945-45",side:"ask",count:"2.00",price:"0.5500",
 client_order_id:"v13p-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 time_in_force:"immediate_or_cancel",reduce_only:true,
 post_only:false,self_trade_prevention_type:"taker_at_cross",
 subaccount:1,exchange_index:2,
};
const fp="a".repeat(64),fee="b".repeat(64);
test("Atomic reservation persists scoped one-shot intent, duplicate returns false",async()=>{
 let called=0;
 const db={
   query:async(sql:string,args?:unknown[])=>{
     called++;assert.match(sql,/ON CONFLICT DO NOTHING/);
     assert.match(sql,/private\.strata_demo_ioc_attempt/);
     assert.equal(args?.[1],identity.ownerId);
     assert.equal(args?.[4],order.client_order_id);
     return {rows:called===1?[{attempt_id:identity.attemptId}]:[]};
   },
   connect:async()=>{throw Error("never")},
 };
 const payload={identity,order,signerFingerprint:fp,feeFingerprint:fee,
   approvalExpiresAtMs:1780000005000,nowMs:1780000000000};
 assert.equal(await prepareDemoIocOnce(payload,db),true);
 assert.equal(await prepareDemoIocOnce(payload,db),false);
 assert.equal(called,2);
});
test("Invalid identity, expired grant and wrong order constraints: zero DB writes",async()=>{
 let called=0;
 const db={query:async()=>{called++;return {rows:[]};},
   connect:async()=>{throw Error("unused")}};
 const base={identity,order,signerFingerprint:fp,feeFingerprint:fee,
   approvalExpiresAtMs:1780000005000,nowMs:1780000000000};
 const bad=[
  {...base,identity:{...identity,ownerId:"unverified"}},
  {...base,order:{...order,exchange_index:0}},
  {...base,order:{...order,reduce_only:false}},
  {...base,order:{...order,count:"0.00"}},
  {...base,approvalExpiresAtMs:base.nowMs-1},
 ];
 for(const x of bad)assert.equal(await prepareDemoIocOnce(x,db),false);
 assert.equal(called,0);
});
test("Exactly one PREPARED->UNKNOWN consumes the order; further consumers blocked",async()=>{
 let n=0,tx=0;
 const queries:string[]=[];
 const c={
  query:async(sql:string)=>{
   queries.push(sql);
   if(sql.startsWith("UPDATE")){n++;return {rows:n===1?[{
      attempt_id:identity.attemptId,client_order_id:order.client_order_id
   }]:[]};}
   return {rows:[]};
  },
  release:()=>{tx++;},
 };
 const db={connect:async()=>c,query:async()=>({rows:[]})};
 const props={identity,order,signerFingerprint:fp,feeFingerprint:fee};
 const first=await consumeDemoIocUnknown(props,db);
 assert.equal(first?.persisted,true);
 assert.equal(first?.mayRetry,false);
 assert.equal(first?.clientOrderId,order.client_order_id);
 const second=await consumeDemoIocUnknown(props,db);
 assert.equal(second,null);
 assert.equal(n,2);
 assert.equal(tx,2);
 assert.equal(queries.filter(x=>x==="COMMIT").length,1);
 assert.match(queries.find(x=>x.startsWith("UPDATE"))??"",/state='PREPARED'/);
 assert.match(queries.find(x=>x.startsWith("UPDATE"))??"",/expires_at>now\(\)/);
});
test("Commit uncertainty never returns dispatch authority and never tries again",async()=>{
 let calls=0,rollback=0;
 const c={
  query:async(sql:string)=>{
    if(sql==="COMMIT")throw Error("lost commit ack");
    if(sql==="ROLLBACK")rollback++;
    if(sql.startsWith("UPDATE")){
      calls++;
      return {rows:[{attempt_id:identity.attemptId,client_order_id:order.client_order_id}]};
    }
    return {rows:[]};
  },release:()=>{},
 };
 const db={connect:async()=>c,query:async()=>({rows:[]})};
 const x=await consumeDemoIocUnknown({
   identity,order,signerFingerprint:fp,feeFingerprint:fee,
 },db);
 assert.equal(x,null);assert.equal(calls,1);
 assert.equal(rollback,1);
});
test("Only explicit independently verified UNKNOWN row can finalize",async()=>{
 let count=0;
 const db={query:async(sql:string,args?:unknown[])=>{
   count++;assert.match(sql,/AND state='UNKNOWN'/);
   assert.deepEqual(args?.slice(0,2),[identity.attemptId,identity.ownerId]);
   return {rows:[{attempt_id:identity.attemptId}]};
 },connect:async()=>{throw Error("never")}};
 assert.equal(await finalizeVerifiedDemoIoc({
  identity,clientOrderId:order.client_order_id as string,
  independentlyVerified:true,exactAccountMarketOrderFillPositionMatched:true,
 },db),true);
 assert.equal(await finalizeVerifiedDemoIoc({
  identity,clientOrderId:order.client_order_id as string,
  independentlyVerified:false as true,exactAccountMarketOrderFillPositionMatched:true,
 },db),false);
 assert.equal(count,1);
});
