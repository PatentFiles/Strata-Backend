/**
 * REAL PostgreSQL verification on disposable CI service only.
 * No production URL permitted, no real Kalshi requests or monetary writes.
 * Tests the exact migration, not the mocked query() implementation.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {resolve} from "node:path";
const root=process.cwd();
const {Pool}=createRequire(resolve(root,"lib/db/package.json"))("pg");
const expected="postgresql://strata_test:strata_test@127.0.0.1:5432/strata_test";
if(process.env.DATABASE_URL!==expected)throw Error("refusing non-disposable database");
const pool=new Pool({connectionString:expected,max:6,connectionTimeoutMillis:4000,
 statement_timeout:7000});
const owner="11111111-1111-4111-8111-111111111111";
const cid=(n)=>"v13p-"+String(n).padStart(8,"0")+"-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const uid=(n)=>String(n).padStart(8,"0")+"-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const market="KXBTC15M-26OCT161945-45";
let passes=0;
async function verify(name,fn){
 await fn();passes++;process.stdout.write("PASS "+name+"\n");
}
async function insert(client,attempt,clientId,marketName=market){
 return client.query( `INSERT INTO private.strata_demo_ioc_attempt
   (attempt_id,owner_user_id,demo_account_id,signer_fingerprint,
    client_order_id,market_ticker,reducing_side,requested_hundredths,
    price_dollars,fee_fingerprint,operator_approval_id,worker_holder_id,
    worker_fencing_token,expires_at,state)
   VALUES ($1,$2,'DEMO-1',$3,$4,$5,'ask',200,'0.5500',$6,$7,
     'worker-demo',7,now()+interval '20 seconds','PREPARED')
   ON CONFLICT DO NOTHING RETURNING attempt_id`,
   [attempt,owner,"a".repeat(64),clientId,marketName,"b".repeat(64),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
}
try{
 await pool.query("CREATE SCHEMA IF NOT EXISTS auth");
 await pool.query("CREATE TABLE auth.users (id uuid PRIMARY KEY)");
 await pool.query("INSERT INTO auth.users VALUES ($1)",[owner]);
 await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$");
 await pool.query(readFileSync(resolve(root,"sql/strata_demo_ioc_private.sql"),"utf8"));
 await verify("private schema, RLS, no anon/authenticated grants",async()=>{
   const x=await pool.query(`SELECT c.relrowsecurity, n.nspname,
    has_table_privilege('anon',c.oid,'SELECT') anon_read,
    has_table_privilege('authenticated',c.oid,'INSERT') authenticated_insert,
    has_table_privilege('authenticated',c.oid,'UPDATE') authenticated_update
    FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
    WHERE c.oid='private.strata_demo_ioc_attempt'::regclass`);
   assert.equal(x.rows.length,1);
   assert.equal(x.rows[0].nspname,"private");
   assert.equal(x.rows[0].relrowsecurity,true);
   assert.equal(x.rows[0].anon_read,false);
   assert.equal(x.rows[0].authenticated_insert,false);
   assert.equal(x.rows[0].authenticated_update,false);
 });
 await verify("PostgreSQL regex matches the same client ID",async()=>{
  const x=await pool.query("SELECT $1::text ~ $2::text AS valid",[
   cid(1),"^v13p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  ]);
  assert.equal(x.rows[0].valid,true);
 });
 await verify("inspect installed PostgreSQL constraint definition",async()=>{
  const x=await pool.query("SELECT pg_get_constraintdef(oid) AS rule FROM pg_constraint WHERE conname='strata_demo_ioc_attempt_client_order_id_check'");
  assert.equal(x.rows.length,1);
  process.stdout.write("CID_RULE "+x.rows[0].rule+"\n");
 });
 await verify("unique client ID survives terminal state",async()=>{
   const first=await insert(pool,uid(1),cid(1));
   assert.equal(first.rowCount,1);
   const collision=await insert(pool,uid(2),cid(1),"KXBTC15M-ANOTHER");
   assert.equal(collision.rowCount,0);
 });
 await verify("partial unique pending market rejects unrelated client IDs",async()=>{
   const duplicate=await insert(pool,uid(3),cid(3));
   assert.equal(duplicate.rowCount,0);
 });
 await verify("transactional PREPARED->UNKNOWN with COMMIT before external POST",async()=>{
   const c=await pool.connect();
   try{
     await c.query("BEGIN");
     const x=await c.query(`UPDATE private.strata_demo_ioc_attempt
      SET state='UNKNOWN',updated_at=now() WHERE attempt_id=$1
      AND state='PREPARED' AND worker_fencing_token=7 RETURNING state`,[uid(1)]);
     assert.equal(x.rowCount,1);assert.equal(x.rows[0].state,"UNKNOWN");
     // A concurrent session must not see the uncommitted UNKNOWN transition.
     const other=await pool.query("SELECT state FROM private.strata_demo_ioc_attempt WHERE attempt_id=$1",[uid(1)]);
     assert.equal(other.rows[0].state,"PREPARED");
     await c.query("COMMIT");
   }finally{c.release();}
   const check=await pool.query("SELECT state FROM private.strata_demo_ioc_attempt WHERE attempt_id=$1",[uid(1)]);
   assert.equal(check.rows[0].state,"UNKNOWN");
   const retry=await pool.query("UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN' WHERE attempt_id=$1 AND state='PREPARED' RETURNING attempt_id",[uid(1)]);
   assert.equal(retry.rowCount,0);
 });
 await verify("crash/restart and failed COMMIT acknowledgment cannot replay",async()=>{
   const afterRestart=await pool.query("UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN' WHERE attempt_id=$1 AND state='PREPARED' RETURNING attempt_id",[uid(1)]);
   assert.equal(afterRestart.rowCount,0);
   const duplicate=await insert(pool,uid(4),cid(4));
   assert.equal(duplicate.rowCount,0);
 });
 await verify("DB trigger prohibits UNKNOWN replay, identity mutation and skipped states",async()=>{
   await assert.rejects(pool.query(
     "UPDATE private.strata_demo_ioc_attempt SET state='PREPARED' WHERE attempt_id=$1",[uid(1)]),
     /invalid demo IOC state transition/);
   await assert.rejects(pool.query(
     "UPDATE private.strata_demo_ioc_attempt SET client_order_id=$2 WHERE attempt_id=$1",
     [uid(1),cid(81)]),/immutable identity/);
   await assert.rejects(pool.query(
     "UPDATE private.strata_demo_ioc_attempt SET state='RECONCILED' WHERE attempt_id=$1",
     [uid(1)]).then(async()=>pool.query(
       "UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN' WHERE attempt_id=$1",
       [uid(1)])),/invalid demo IOC state transition/);
 });
 await verify("rollback leaves PREPARED; no durable UNKNOWN grant",async()=>{
   await pool.query("UPDATE private.strata_demo_ioc_attempt SET state='RECONCILED' WHERE attempt_id=$1 AND state='UNKNOWN'",[uid(1)]);
   const inserted=await insert(pool,uid(5),cid(5));
   assert.equal(inserted.rowCount,1);
   const c=await pool.connect();
   try{
     await c.query("BEGIN");
     await c.query("UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN' WHERE attempt_id=$1 AND state='PREPARED'",[uid(5)]);
     await c.query("ROLLBACK");
   }finally{c.release();}
   const x=await pool.query("SELECT state FROM private.strata_demo_ioc_attempt WHERE attempt_id=$1",[uid(5)]);
   assert.equal(x.rows[0].state,"PREPARED");
 });
 await verify("concurrent worker reservation: exactly one wins",async()=>{
   await pool.query("UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN' WHERE attempt_id=$1 AND state='PREPARED'",[uid(5)]);
   await pool.query("UPDATE private.strata_demo_ioc_attempt SET state='RECONCILED' WHERE attempt_id=$1 AND state='UNKNOWN'",[uid(5)]);
   const c1=await pool.connect(),c2=await pool.connect();
   try{
     const [x,y]=await Promise.all([insert(c1,uid(6),cid(6)),insert(c2,uid(7),cid(7))]);
     assert.equal(x.rowCount+y.rowCount,1);
   }finally{c1.release();c2.release();}
 });
 await verify("stale worker token and nonterminal duplicates fail",async()=>{
   const all=await pool.query("SELECT attempt_id FROM private.strata_demo_ioc_attempt WHERE state='PREPARED'");
   assert.equal(all.rowCount,1);
   const stale=await pool.query("UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN' WHERE attempt_id=$1 AND worker_fencing_token=6 AND state='PREPARED' RETURNING attempt_id",[all.rows[0].attempt_id]);
   assert.equal(stale.rowCount,0);
 });
 await verify("actual backend prepare, UNKNOWN and finalize helpers use real transactions",async()=>{
  const handlers=createRequire(resolve(root,"package.json"))(resolve(root,"artifacts/api-server/dist/kalshiDemoIocLedger.integration.cjs"));
  const identity={
    ownerId:owner,demoAccountId:"DEMO-2",attemptId:uid(8),
    operatorApprovalId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workerHolderId:"worker-demo",workerFencingToken:12,
  };
  const order={
    ticker:"KXBTC15M-26OCT161950-50",client_order_id:cid(8),
    count:"1.00",side:"ask",price:"0.5500",post_only:false,
    reduce_only:true,time_in_force:"immediate_or_cancel",
    self_trade_prevention_type:"taker_at_cross",
    subaccount:1,exchange_index:2,
  };
  const fingerprint="c".repeat(64),feeFingerprint="d".repeat(64);
  const when=Date.now();
  const prep=await handlers.prepareDemoIocOnce({
    identity,order,signerFingerprint:fingerprint,feeFingerprint,
    approvalExpiresAtMs:when+20000,nowMs:when,
  },pool);
  assert.equal(prep,true);
  const repeat=await handlers.prepareDemoIocOnce({
    identity,order,signerFingerprint:fingerprint,feeFingerprint,
    approvalExpiresAtMs:when+20000,nowMs:when,
  },pool);
  assert.equal(repeat,false);
  const bad=await handlers.consumeDemoIocUnknown({
    identity:{...identity,workerFencingToken:11},order,
    signerFingerprint:fingerprint,feeFingerprint,
  },pool);
  assert.equal(bad,null);
  const committed=await handlers.consumeDemoIocUnknown({
    identity,order,signerFingerprint:fingerprint,feeFingerprint,
  },pool);
  assert.equal(committed?.persisted,true);
  assert.equal(committed?.state,"UNKNOWN");
  const duplicate=await handlers.consumeDemoIocUnknown({
    identity,order,signerFingerprint:fingerprint,feeFingerprint,
  },pool);
  assert.equal(duplicate,null);
  const final=await handlers.finalizeVerifiedDemoIoc({
    identity,clientOrderId:cid(8),independentlyVerified:true,
    exactAccountMarketOrderFillPositionMatched:true,
  },pool);
  assert.equal(final,true);
  const finalDuplicate=await handlers.finalizeVerifiedDemoIoc({
    identity,clientOrderId:cid(8),independentlyVerified:true,
    exactAccountMarketOrderFillPositionMatched:true,
  },pool);
  assert.equal(finalDuplicate,false);
 });
 process.stdout.write(JSON.stringify({result:"PASS",realPostgres:true,
  cases:passes,noProductionDatabaseUsed:true})+"\n");
}finally{await pool.end();}
