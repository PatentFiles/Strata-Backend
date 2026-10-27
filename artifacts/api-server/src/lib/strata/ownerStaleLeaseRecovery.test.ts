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

test("issue155: stale owner lease is atomically token-fenced, signed twice and leaves risk freeze untouched",async()=>{
 const owner="11111111-1111-4111-8111-111111111111",account="owner-account";
 const hb=new Date(now-3600000),fp="f".repeat(64);
 const calls:string[]=[];let signed=0;
 const q=async(sql:string):Promise<{rows:Record<string,unknown>[]}>=>{
  calls.push(sql);
  if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.startsWith("SET LOCAL"))return {rows:[]};
  if(sql.includes("FROM public.v13_production_account a")&&sql.includes("JOIN private.kalshi_account_worker_lease")) {
   // The transaction revalidates these account safety gates: they MUST be
   // explicitly selected in the initial snapshot (not merely mocked fields).
   assert.match(sql,/a\.execution_enabled/);
   assert.match(sql,/a\.kill_switch/);
   return {rows:[{id:account,owner_user_id:owner,kalshi_connection_id:GRANT_ID,
     key_fingerprint:fp,credential_fingerprint:fp,cash_micros:"25000000",
     reserved_micros:"0",revision:3,blocked_reason:"awaiting_account_commissioning",
     execution_enabled:true,kill_switch:false,state:"owned",holder_id:"old-process",
     fencing_token:"2",heartbeat_at:hb,arm_requested:true,account_kill:false}]};
  }
  if(sql.includes("FROM public.v13_production_intent WHERE account_id=")&&sql.includes("ORDER BY"))
   return {rows:[]};
  if(sql.includes("FROM private.kalshi_connection_credentials c"))
   return {rows:[{decrypted_secret:JSON.stringify({api_key_id:"offline-id",private_key:"offline-key"})}]};
  if(sql.includes("WITH unresolved_intents"))return {rows:[{n:"0"}]};
  if(sql.includes("SELECT count(*)::int AS n FROM public.v13_production_position"))return {rows:[{n:0}]};
  if(sql.includes("FROM public.v13_production_account WHERE id=")&&sql.includes("FOR UPDATE"))
   return {rows:[{id:account,revision:3,cash_micros:"25000000",key_fingerprint:fp,
     blocked_reason:"awaiting_account_commissioning",execution_enabled:true,kill_switch:false}]};
  if(sql.includes("FROM private.kalshi_account_worker_lease WHERE")&&sql.includes("FOR UPDATE"))
   return {rows:[{state:"owned",holder_id:"old-process",fencing_token:"2",heartbeat_at:hb}]};
  if(sql.startsWith("UPDATE private.kalshi_account_worker_lease"))
   return {rows:[{fencing_token:"3"}]};
  if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
  throw Error("unexpected SQL "+sql.slice(0,90));
 };
 const db={query:q,connect:async()=>({query:q,release(){}})};
 const result=await recoverOwnerStaleLease(owner,OWNER_STALE_LEASE_CONFIRMATION,{
  db:db as never,now:()=>now,bootAtMs:now-30000,
  readFeeds:(async(_material:unknown,ms:number)=>{
    signed++;return {ok:true,observedAtMs:ms,cashMicros:"25000000",
     orders:[],fills:[],positions:[],settlements:[]};
  }) as never,
  isScheduled:()=>false,
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(signed,2,"before and after signed account reads");
 assert.ok(calls.includes("COMMIT"));
 assert.equal(calls.some(s=>s.includes("UPDATE public.v13_production_account")),false);
 const release=calls.find(s=>s.startsWith("UPDATE private.kalshi_account_worker_lease"))??"";
 assert.match(release,/fencing_token=fencing_token\+1/);
 assert.match(release,/heartbeat_at=\$5::timestamptz/);
 assert.match(release,/NOT EXISTS/);
});
const GRANT_ID="22222222-2222-4222-8222-222222222222";
