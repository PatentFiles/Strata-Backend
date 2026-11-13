import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pool} from "@workspace/db";
import {dedicatedSignerFingerprint} from "./commissioning";
import {persistAuthenticatedExitReconciliation} from "./ownerFeeEmergencyExitReconciliationCommit";
import {fixture,NOW} from "./protectiveRecoveryDeadline.testSupport";

const target=process.env.V13_PROTECTIVE_DEADLINE_DISPOSABLE_URL;
assert.ok(target&&target===process.env.DATABASE_URL,"explicit disposable URL required");
const url=new URL(target);
assert.equal(url.hostname,"127.0.0.1");assert.equal(url.username,"v13_test");
assert.match(url.pathname,/^\/protective_deadline_disposable_[0-9]+$/);
assert.equal(process.env.NODE_ENV,"test");
type Stage="CONNECT"|"BEGIN"|"LOCK_TIMEOUT"|"STATEMENT_TIMEOUT"|"SELECT"|"INSERT"|"UPDATE"|"COMMIT"|"ROLLBACK";
const stageOf=(sql:string):Stage=>sql.startsWith("SELECT")?"SELECT":sql.startsWith("INSERT")?"INSERT":sql.startsWith("UPDATE")?"UPDATE":
 sql.includes("lock_timeout")?"LOCK_TIMEOUT":sql.includes("statement_timeout")?"STATEMENT_TIMEOUT":sql as Stage;
function instrumented(f:ReturnType<typeof fixture>,options:{expire?:Stage;rollbackFailsBefore?:boolean;commitThrows?:"before"|"after"}={}){
 const state={commits:0,evicted:false,pid:0};
 return {state,db:{connect:async()=>{
  const c=await pool.connect();state.pid=(c as unknown as {processID:number}).processID;
  if(options.expire==="CONNECT")f.advance(3001);
  return {query:async(sql:string,args?:unknown[])=>{
   const stage=stageOf(sql);
   if(stage==="ROLLBACK"&&options.rollbackFailsBefore)throw Error("synthetic_rollback_not_executed");
   if(stage==="COMMIT"){
    state.commits++;
    if(options.commitThrows==="before")throw Error("synthetic_commit_ack_lost");
   }
   const result=await c.query(sql,args);
   if(stage===options.expire)f.advance(3001);
   if(stage==="COMMIT"&&options.commitThrows==="after")throw Error("synthetic_commit_ack_lost");
   return result;
  },release(error?:Error|boolean){state.evicted=Boolean(error);c.release(error);}};
 }}};
}
async function seed(f:ReturnType<typeof fixture>){
 await pool.query("TRUNCATE private.strata_protective_exit_reconciliations,private.strata_emergency_exit_reservations,public.v13_production_account,auth.users CASCADE");
 const i=f.input,raw=JSON.stringify(i.order);
 await pool.query("INSERT INTO auth.users(id) VALUES($1)",[i.ownerId]);
 await pool.query("INSERT INTO public.v13_production_account(id,owner_user_id,subaccount,exchange_index,key_fingerprint) VALUES($1,$2,1,2,$3)",
  [i.accountId,i.ownerId,dedicatedSignerFingerprint(i.material.keyId,i.material.privateKey)]);
 await pool.query(`INSERT INTO private.strata_emergency_exit_reservations
  (reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,quantity_hundredths,
   order_digest,worker_fencing_token,worker_holder_id,initial_position_fp,position_observed_at_ms,order_request_json)
  VALUES($1,$2,$3,$4,$5,'YES',200,$6,1,'offline-worker','3.00',$7,$8)`,
  [i.reservationId,i.ownerId,i.accountId,i.order.ticker,i.order.client_order_id,createHash("sha256").update(raw).digest("hex"),NOW-200,raw]);
 await pool.query("UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN',updated_at=now()");
 f.hooks.db=pool;
}
async function snapshot(){
 const {rows}=await pool.query(`SELECT r.state,
  (SELECT count(*)::integer FROM private.strata_protective_exit_reconciliations) AS audits,
  r.initial_position_fp,r.quantity_hundredths::text FROM private.strata_emergency_exit_reservations r`);
 return rows[0];
}
test("disposable PostgreSQL protective deadline admission and uncertain-commit proof",async(t)=>{
 try{
  await pool.query(`CREATE SCHEMA private;CREATE SCHEMA auth;CREATE ROLE anon;CREATE ROLE authenticated;
   CREATE TABLE auth.users(id uuid PRIMARY KEY);
   CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int,key_fingerprint text);`);
  for(const name of ["strata_emergency_exit_reservation_private.sql","strata_emergency_exit_baseline_private.sql",
   "strata_protective_exit_reconciliation_private.sql","strata_protective_exit_request_snapshot_private.sql"])
   await pool.query(readFileSync(resolve("../../sql",name),"utf8"));
  for(const stage of ["CONNECT","BEGIN","LOCK_TIMEOUT","STATEMENT_TIMEOUT","SELECT","INSERT","UPDATE"] as const){
   await t.test(`expiry after actual ${stage} leaves audit and marker unchanged`,async()=>{
    const f=fixture();await seed(f);const before=await snapshot(),observation=await f.read(null);
    const wrapped=instrumented(f,{expire:stage});
    const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:wrapped.db});
    assert.equal(result.committed,false);assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(result.mayRetry,false);
    assert.equal(wrapped.state.commits,0);assert.deepEqual(await snapshot(),before);
   });
  }
  await t.test("timely proof commits exactly one audit and preserves inventory",async()=>{
   const f=fixture();await seed(f);const observation=await f.read(null),wrapped=instrumented(f);
   const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:wrapped.db});
   assert.equal(result.committed,true);assert.equal(result.freshnessVerified,true);
   assert.deepEqual(await snapshot(),{state:"RECONCILED",audits:1,initial_position_fp:"3.00",quantity_hundredths:"200"});
  });
  await t.test("actual row-lock wait cannot carry expired evidence into audit insertion",async()=>{
   const f=fixture();await seed(f);const observation=await f.read(null);
   const blocker=await pool.connect();
   await blocker.query("BEGIN");await blocker.query("SELECT reservation_id FROM private.strata_emergency_exit_reservations FOR UPDATE");
   const wrapped=instrumented(f),pending=persistAuthenticatedExitReconciliation(f.input,observation,{db:wrapped.db});
   try{
    let locked=false;
    for(let count=0;count<50;count++){
     const rs=await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[wrapped.state.pid]);
     if(rs.rows.length){locked=true;break;}await new Promise(r=>setTimeout(r,5));
    }
    assert.equal(locked,true,"must observe an actual PostgreSQL row-lock wait");f.advance(3001);
   }finally{await blocker.query("ROLLBACK");blocker.release();}
   const result=await pending;
   assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(wrapped.state.commits,0);
   assert.equal((await snapshot()).state,"UNKNOWN");assert.equal((await snapshot()).audits,0);
  });
  await t.test("failed rollback evicts a real dirty backend and cannot leak staged audit",async()=>{
   const f=fixture();await seed(f);const observation=await f.read(null),wrapped=instrumented(f,{expire:"UPDATE",rollbackFailsBefore:true});
   const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:wrapped.db});
   assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(wrapped.state.evicted,true);
   const borrowed=await pool.connect();
   assert.notEqual((borrowed as unknown as {processID:number}).processID,wrapped.state.pid);borrowed.release();
   assert.deepEqual(await snapshot(),{state:"UNKNOWN",audits:0,initial_position_fp:"3.00",quantity_hundredths:"200"});
  });
  for(const accepted of [false,true]){
   await t.test(`lost COMMIT acknowledgment with actual commit ${accepted?"accepted":"not executed"} stays explicitly uncertain`,async()=>{
    const f=fixture();await seed(f);const observation=await f.read(null),wrapped=instrumented(f,{commitThrows:accepted?"after":"before"});
    const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:wrapped.db});
    assert.equal(result.committed,false);assert.equal(result.commitState,"UNKNOWN");assert.equal(result.mayRetry,false);
    assert.equal(wrapped.state.evicted,true);
    const durable=await snapshot();assert.equal(durable.state,accepted?"RECONCILED":"UNKNOWN");assert.equal(durable.audits,accepted?1:0);
   });
  }
  await t.test("late acknowledged actual COMMIT is reported committed but not freshness-verified",async()=>{
   const f=fixture();await seed(f);const observation=await f.read(null),wrapped=instrumented(f,{expire:"COMMIT"});
   const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:wrapped.db});
   assert.equal(result.committed,true);assert.equal(result.commitState,"COMMITTED");assert.equal(result.freshnessVerified,false);
   assert.equal(result.mayRetry,false);assert.equal((await snapshot()).state,"RECONCILED");assert.equal((await snapshot()).audits,1);
  });
 }finally{await pool.end();}
});
