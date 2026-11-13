import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {pool} from '@workspace/db';
import {ProductionExecutor} from './executor';
import {ProductionLedger, type Account} from './ledger';
import type {Exchange} from './types';
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url));
after(()=>pool.end());
const owner='00000000-0000-4000-8000-000000000001',foreign='00000000-0000-4000-8000-000000000002';
test('owned gate batches identity/UNKNOWN only; matches old query semantics and preserves locks',async()=>{
 const tx=await pool.connect(),other=await pool.connect();
 const schema='gate_batch_test';
 try {
 await tx.query(`CREATE SCHEMA ${schema}`);
 await tx.query(`SET search_path TO ${schema}`);await other.query(`SET search_path TO ${schema}`);
 await tx.query(`CREATE TABLE v13_production_account(id text PRIMARY KEY,owner_user_id uuid,policy_id text);
 CREATE TABLE v13_production_intent(id text PRIMARY KEY,account_id text,state text);
 CREATE TABLE live_execution_config(manual_kill_switch boolean,live_execution_enabled boolean);
 CREATE TABLE v13_live_money_policy(id text,execution_account_id text,state text,policy_hash text)`);
 await tx.query("INSERT INTO live_execution_config VALUES(false,true)");
 await tx.query("INSERT INTO v13_live_money_policy VALUES('p','a','APPROVED',$1)",['c'.repeat(64)]);
 const ex=new ProductionExecutor(new ProductionLedger(pool,'a'),{mode:'LIVE'} as Exchange,()=>1000);
 ex.accountOwnerUserId=owner;
 const a:Account={id:'a',policy_id:'p',key_fingerprint:'d'.repeat(64),minimum_exit_micros:null,cash_micros:'0',reserved_micros:'0',initial_cash_micros:'0',revision:'1',commissioned:true,kill_switch:false,execution_enabled:true,commissioning_digest:'a'.repeat(64),
 subaccount:'1',exchange_index:'2',cash_precision_verified:true,fee_artifact_digest:'b'.repeat(64),blocked_reason:null,
 reconciled_at:new Date(1000)};
 const originalQuery=tx.query.bind(tx);let calls:string[]=[];let batchSql='';
 tx.query=((...args:unknown[])=>{calls.push(String(args[0]));return (originalQuery as Function)(...args);}) as typeof tx.query;
 const outcome=async(ignore:string|null,lifecycle:boolean)=>{try{await ex.gate(tx,a,false,ignore,lifecycle);return 'ok';}catch(e){return (e as Error).message;}};
 for(const account of [owner,foreign,null,'missing']) for(const states of [[],['UNKNOWN'],['DISPATCHED'],['PREPARED'],['UNKNOWN','UNKNOWN']]) for(const lifecycle of [false,true]) for(const ignore of [null,'i0']) {
  await tx.query('BEGIN');await tx.query('DELETE FROM v13_production_intent');await tx.query('DELETE FROM v13_production_account');
  if(account!=='missing')await tx.query("INSERT INTO v13_production_account VALUES('a',$1,'p')",[account]);
  for(let n=0;n<states.length;n++)await tx.query("INSERT INTO v13_production_intent VALUES($1,'a',$2)",['i'+n,states[n]]);
  await tx.query("INSERT INTO v13_production_intent VALUES('foreign','other','UNKNOWN')");
  await tx.query("SELECT * FROM v13_production_account WHERE id='a' FOR UPDATE");
  const oldUnknown=await tx.query("SELECT id FROM v13_production_intent WHERE account_id=$1 AND state IN ('DISPATCHED','UNKNOWN') AND ($2::text IS NULL OR id<>$2)",['a',ignore]);
  let expected='production_uncertain_order_blocks_mutation';
  if(lifecycle||oldUnknown.rows.length===0){const r=await tx.query('SELECT owner_user_id::text AS owner_user_id FROM v13_production_account WHERE id=$1',['a']);expected=r.rows.length===1&&r.rows[0].owner_user_id===owner?'ok':'foreign_execution_account';}
  calls=[];assert.equal(await outcome(ignore,lifecycle),expected,JSON.stringify({account,states,lifecycle,ignore}));
  assert.equal(calls.filter(q=>q.includes('WITH uncertain AS MATERIALIZED')).length,1);
  batchSql=calls.find(q=>q.includes('WITH uncertain AS MATERIALIZED'))!;
  assert.equal(calls.length,expected==='ok'?3:1); // old owned success was4, no extra reads on denial
  await tx.query('ROLLBACK');
 }
 // Already-held account lock fences a competing owner change; same-tx changes remain visible.
 await tx.query("INSERT INTO v13_production_account VALUES('a',$1,'p')",[owner]);
 // EXPLAIN ANALYZE proves CASE's owner relation is not executed on UNKNOWN denial.
 await tx.query("INSERT INTO v13_production_intent VALUES('u','a','UNKNOWN')");
 const ownerLoops=async(lifecycle:boolean)=>{
  const explained=await tx.query('EXPLAIN (ANALYZE,FORMAT JSON) '+batchSql,['a',null,lifecycle]);
  const plans:Record<string,unknown>[]=[];
  const visit=(p:Record<string,unknown>)=>{if(p['Relation Name']==='v13_production_account')plans.push(p);for(const c of (p.Plans??[]) as Record<string,unknown>[])visit(c);};
  visit(explained.rows[0]['QUERY PLAN'][0].Plan);assert.equal(plans.length,1);return plans[0]['Actual Loops'];
 };
 assert.equal(await ownerLoops(false),0);assert.equal(await ownerLoops(true),1);
 await tx.query('DELETE FROM v13_production_intent');assert.equal(await ownerLoops(false),1);
 await tx.query('BEGIN');await tx.query("SELECT * FROM v13_production_account WHERE id='a' FOR UPDATE");
 await other.query("SET lock_timeout='40ms'");
 await assert.rejects(other.query("UPDATE v13_production_account SET owner_user_id=$1 WHERE id='a'",[foreign]),/lock timeout/);
 assert.equal(await outcome(null,false),'ok');
 await tx.query("UPDATE v13_production_account SET owner_user_id=$1 WHERE id='a'",[foreign]);
 assert.equal(await outcome(null,false),'foreign_execution_account');await tx.query('ROLLBACK');
 // Master remains a later independent read, with unchanged failure precedence.
 await tx.query('UPDATE live_execution_config SET manual_kill_switch=true');
 assert.equal(await outcome(null,false),'production_master_kill_switch_or_flag');
 } finally {await tx.query('ROLLBACK');await tx.query('SET search_path TO public');await other.query('SET search_path TO public');await tx.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);tx.release();other.release();}
});
