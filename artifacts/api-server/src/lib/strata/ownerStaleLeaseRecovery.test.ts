import test from "node:test";
import assert from "node:assert/strict";
import {eligibleStaleLeaseRecovery,recoverOwnerStaleLease,OWNER_STALE_LEASE_CONFIRMATION}
 from "./ownerStaleLeaseRecovery";
const now=Date.parse("2026-10-23T15:00:00Z");
const base={
 nowMs:now,bootAtMs:now-60000,heartbeatAtMs:now-3600000,
 localWorkerRunning:false,sameOwner:true,owned:true,accountKill:false,
 cashMatches:true,exchangeFlat:true,localFlat:true,
};
test("issue155: genuine stale flat worker can be considered ONLY for fenced recovery",()=>{
 assert.deepEqual(eligibleStaleLeaseRecovery(base),{ok:true});
});
test("issue155: all unsafe recovery predicates fail closed",()=>{
 for(const x of [
  {sameOwner:false},{localWorkerRunning:true},{owned:false},{accountKill:true},
  {heartbeatAtMs:now-40000},{bootAtMs:now-5000000},
  {cashMatches:false},{exchangeFlat:false},{localFlat:false},
  {nowMs:NaN},{heartbeatAtMs:NaN},
 ]) assert.equal(eligibleStaleLeaseRecovery({...base,...x}).ok,false,JSON.stringify(x));
});
test("issue155: no authorization or invalid user never touches exchange or database",async()=>{
 let called=0;
 const db={query:async()=>{called++;throw Error("forbidden");},connect:async()=>{called++;throw Error("forbidden");}};
 for(const [user,confirm] of [
  ["wrong",OWNER_STALE_LEASE_CONFIRMATION],
  ["11111111-1111-4111-8111-111111111111","fake"],
  ["11111111-1111-4111-8111-111111111111",null],
 ] as const){
  const r=await recoverOwnerStaleLease(user,confirm,{db:db as never});
  assert.equal(r.ok,false);
  assert.equal(r.ordersSubmitted,false);
  assert.equal(r.riskFreezeCleared,false);
 }
 assert.equal(called,0);
});
test("issue155: preflight unavailability does not start worker or mutate lease",async()=>{
 let transactions=0;
 const db={query:async()=>({rows:[]}),connect:async()=>{transactions++;throw Error("unexpected mutation");}};
 const r=await recoverOwnerStaleLease("11111111-1111-4111-8111-111111111111",
   OWNER_STALE_LEASE_CONFIRMATION,{db:db as never});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"owner_lease_not_unique_or_missing");
 assert.equal(transactions,0);
});
