import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {pool,type Pool} from '@workspace/db';
import {ProductionLedger,RECONCILE_ACCOUNT_HISTORY_SQL,identity} from './ledger';
import {digest,type Snapshot} from './types';

assert.match(process.env.V13_DISPOSABLE_DATABASE_URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/, 'fresh disposable PostgreSQL only');
after(()=>pool.end());
const own='reconciliation-head-local',foreign='reconciliation-head-foreign';
async function setup(){
 for(const id of [own,foreign]){
  await pool.query('DELETE FROM v13_production_observation WHERE account_id=$1',[id]);
  await pool.query('DELETE FROM v13_production_intent WHERE account_id=$1',[id]);
  await pool.query('DELETE FROM v13_production_account WHERE id=$1',[id]);
  await pool.query(`INSERT INTO v13_production_account(id,owner_user_id,subaccount,exchange_index,key_fingerprint,cash_micros,initial_cash_micros,kill_switch,execution_enabled)
   VALUES($1,$2,1,2,$3,25000000,25000000,false,true)`,[id,randomUUID(),'b'.repeat(64)]);
 }
}
async function history(accountId:string,createdAt:Date){
 const id=randomUUID();
 // Terminal local fixture rows only: never dispatched orders or venue evidence.
 await pool.query(`INSERT INTO v13_production_intent(id,account_id,parent_id,kind,market,side,state,request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,reserved_micros,exit_fee_micros,terminal,created_at)
 VALUES($1,$2,'local-fixture-parent','EXIT','LOCAL-TEST','NO','TERMINAL','{}','{}','local','local','local',$1,0,0,true,$3)`,[id,accountId,createdAt]);
}
function tracked(accountId=own,fail=false){
 const calls:{sql:string,args:unknown[]|undefined}[]=[];
 const wrapped={query:async(sql:string,args?:unknown[])=>{
  calls.push({sql,args});if(fail)throw Error('injected_reconciliation_head_read_failure');return pool.query(sql,args);
 },connect:pool.connect.bind(pool)};
 return {ledger:new ProductionLedger(wrapped as unknown as Pool,accountId),calls};
}
async function legacy(ledger:ProductionLedger){
 const account=await ledger.readAccount();
 const earliest=(await ledger.pool.query('SELECT min(created_at) AS earliest FROM v13_production_intent WHERE account_id=$1',[account.id])).rows[0].earliest;
 return {account,earliest};
}

test('differential head read preserves exact account/digest and empty nullable history with two-to-one SQL calls',async()=>{
 await setup();const old=tracked(),next=tracked();
 const expected=await legacy(old.ledger),actual=await next.ledger.readReconcileAccount();
 assert.deepEqual(actual,expected);assert.equal(actual.earliest,null);
 assert.equal(digest(actual.account),digest(expected.account));
 assert.equal(Object.hasOwn(actual.account,'reconciliation_history_floor'),false);
 assert.equal(old.calls.length,2);assert.equal(next.calls.length,1);
 assert.equal(next.calls[0].sql,RECONCILE_ACCOUNT_HISTORY_SQL);assert.deepEqual(next.calls[0].args,[own]);
});

test('history floor is own-account minimum Date, excludes earlier foreign history and preserves null with foreign-only rows',async()=>{
 await setup();await history(foreign,new Date('2000-01-01T00:00:00.000Z'));
 assert.equal((await tracked().ledger.readReconcileAccount()).earliest,null);
 await history(own,new Date('2025-01-03T04:05:06.789Z'));
 await history(own,new Date('2025-01-02T04:05:06.123Z'));
 const expected=await legacy(tracked().ledger),actual=await tracked().ledger.readReconcileAccount();
 assert.deepEqual(actual,expected);assert.ok(actual.earliest instanceof Date);
 assert.equal(actual.earliest.toISOString(),'2025-01-02T04:05:06.123Z');
 assert.equal(digest(actual.account),digest(expected.account));
});

test('missing account rejects and actual EXPLAIN ANALYZE does not execute correlated history subplan',async()=>{
 await setup();await history(foreign,new Date(0));
 const t=tracked('missing-reconciliation-head');
 await assert.rejects(t.ledger.readReconcileAccount(),/production_account_missing/);
 assert.equal(t.calls.length,1);
 const explained=(await pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${RECONCILE_ACCOUNT_HISTORY_SQL}`,['missing-reconciliation-head'])).rows[0]['QUERY PLAN'][0].Plan;
 const nodes:Record<string,unknown>[]=[];
 const walk=(node:Record<string,unknown>)=>{nodes.push(node);for(const child of (node.Plans??[]) as Record<string,unknown>[])walk(child);};walk(explained);
 const subplans=nodes.filter(node=>node['Parent Relationship']==='SubPlan');
 assert.ok(subplans.length>0,'history aggregate must remain a correlated subplan');
 for(const node of subplans)assert.equal(node['Actual Loops'],0);
 for(const node of nodes.filter(node=>node['Relation Name']==='v13_production_intent'))assert.equal(node['Actual Loops'],0);
});

test('query errors propagate with no fallback read, and ordinary readAccount remains unaugmented',async()=>{
 const failed=tracked(own,true);await assert.rejects(failed.ledger.readReconcileAccount(),/injected_reconciliation_head_read_failure/);assert.equal(failed.calls.length,1);
 await setup();const t=tracked();const account=await t.ledger.readAccount();
 assert.equal(t.calls.length,1);assert.equal(t.calls[0].sql,'SELECT * FROM v13_production_account WHERE id=$1');
 assert.equal(Object.hasOwn(account,'reconciliation_history_floor'),false);
 assert.deepEqual(account,(await pool.query('SELECT * FROM v13_production_account WHERE id=$1',[own])).rows[0]);
});

test('both head paths retain authoritative revision rejection after STOP-like update between read and reconcile',async()=>{
 for(const useLegacy of [true,false]){
  await setup();const t=tracked();const read=useLegacy?await legacy(t.ledger):await t.ledger.readReconcileAccount();
  const snapshot:Snapshot={identity:identity(read.account),observedAtMs:1000,historyFromMs:0,complete:true,authenticated:true,cashExact:true,cashMicros:'25000000',orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
  await pool.query('UPDATE v13_production_account SET revision=revision+1,kill_switch=true,execution_enabled=false WHERE id=$1',[own]);
  await assert.rejects(t.ledger.reconcile(snapshot,read.account.revision,1000),/production_observation_raced/);
  const after=(await pool.query('SELECT * FROM v13_production_account WHERE id=$1',[own])).rows[0];
  assert.equal(after.revision,'1');assert.equal(after.kill_switch,true);assert.equal(after.execution_enabled,false);
  assert.equal(after.reconciled_at,null);assert.equal(after.evidence_digest,null);
  assert.equal((await pool.query('SELECT count(*) FROM v13_production_observation WHERE account_id=$1',[own])).rows[0].count,'0');
 }
});
