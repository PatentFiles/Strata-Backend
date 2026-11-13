import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {pool,type Pool} from '@workspace/db';
import {ProductionLedger,identity} from './ledger';
import {digest,type Snapshot} from './types';
import {reconciliationObservation} from './reconciliationObservation';

assert.match(process.env.V13_DISPOSABLE_DATABASE_URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/, 'fresh disposable PostgreSQL only');
after(()=>pool.end());
const id='reconciliation-tail-local';
const combined=(sql:string)=>sql.startsWith('UPDATE v13_production_account SET cash_micros=')&&sql.includes('reconciled_at=$5');
async function setup(){
 await pool.query('DELETE FROM v13_production_observation WHERE account_id=$1',[id]);
 await pool.query('DELETE FROM v13_production_account WHERE id=$1',[id]);
 await pool.query(`INSERT INTO v13_production_account(id,subaccount,exchange_index,key_fingerprint,cash_micros,initial_cash_micros,kill_switch,execution_enabled)
 VALUES($1,1,2,$2,25000000,25000000,false,true)`,[id,'b'.repeat(64)]);
 const account=(await pool.query('SELECT * FROM v13_production_account WHERE id=$1',[id])).rows[0];
 const snapshot:Snapshot={identity:identity(account),observedAtMs:1000,historyFromMs:0,complete:true,authenticated:true,cashExact:true,cashMicros:'25000000',orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
 return {account,snapshot};
}
type Options={legacy?:boolean;fail?:'write'|'beforeCommit'|'lostCommitAck';beforeWrite?:()=>Promise<void>};
function instrument(options:Options={}){
 const calls:string[]=[];const freezes:string[]=[];
 const wrapped={query:pool.query.bind(pool),connect:async()=>{
  const tx=await pool.connect();
  const execute=async(sql:string,args?:unknown[])=>{calls.push(sql);return tx.query(sql,args);};
  return {release:()=>tx.release(),query:async(sql:string,args?:unknown[])=>{
   if(combined(sql)){
    await options.beforeWrite?.();
    if(options.legacy){
     await execute('UPDATE v13_production_account SET cash_micros=$2,reserved_micros=$3,blocked_reason=$4,revision=revision+1 WHERE id=$1',args!.slice(0,4));
     if(options.fail==='write')throw Error('injected_reconcile_write_failure');
     return execute('UPDATE v13_production_account SET reconciled_at=$2,evidence_digest=$3 WHERE id=$1',[args![0],args![4],args![5]]);
    }
    if(options.fail==='write')throw Error('injected_reconcile_write_failure');
   }
   if(sql==='COMMIT'&&options.fail==='beforeCommit')throw Error('injected_commit_failure');
   const result=await execute(sql,args);
   if(sql==='COMMIT'&&options.fail==='lostCommitAck')throw Error('injected_commit_ack_lost');
   return result;
  }};
 }};
 class IsolatedLedger extends ProductionLedger{
  // Isolate reconciliation rollback from the intentionally separate freeze tx.
  // Actual freeze/recovery behavior remains covered by the complete safety suite.
  override async freeze(reason:string){freezes.push(reason);}
 }
 return {ledger:new IsolatedLedger(wrapped as unknown as Pool,id),calls,freezes};
}
async function row(){return (await pool.query('SELECT * FROM v13_production_account WHERE id=$1',[id])).rows[0];}
async function observations(){return (await pool.query('SELECT * FROM v13_production_observation WHERE account_id=$1 ORDER BY id',[id])).rows;}

test('differential real PostgreSQL: merged tail equals former two statements and saves exactly one request',async()=>{
 const results=[];
 for(const legacy of [true,false]){
  const f=await setup(),i=instrument({legacy});
  const receipt=await i.ledger.reconcile(f.snapshot,f.account.revision,1000);
  const final=await row(),obs=await observations();
  assert.equal(final.revision,'1');assert.equal(final.evidence_digest,digest(f.snapshot));
  assert.equal(final.reconciled_at.getTime(),1000);assert.equal(final.cash_micros,'25000000');assert.equal(final.reserved_micros,'0');
  assert.equal(obs.length,1);assert.equal(receipt.observationId,obs[0].id);assert.equal(receipt.accountId,id);
  assert.deepEqual(obs[0].payload,reconciliationObservation(f.snapshot));assert.equal(obs[0].digest,digest(obs[0].payload));
  const conservation=i.calls.findIndex(sql=>sql.startsWith('SELECT e.cash'));
  const observation=i.calls.findIndex(sql=>sql.startsWith('INSERT INTO v13_production_observation'));
  const write=i.calls.findIndex(sql=>sql.startsWith('UPDATE v13_production_account'));
  assert.ok(conservation>=0&&conservation<observation&&observation<write);
  assert.equal(i.calls.at(-1),'COMMIT');assert.equal(i.calls.length,legacy?8:7);
  assert.equal(i.calls.filter(sql=>sql.startsWith('UPDATE v13_production_account')).length,legacy?2:1);
  assert.deepEqual(i.freezes,[]);results.push({final,payload:obs[0].payload,digest:obs[0].digest});
 }
 assert.deepEqual(results[0],results[1]);
});

test('differential write and pre-COMMIT failures roll back account, revision and receipt together',async()=>{
 for(const legacy of [true,false])for(const fail of ['write','beforeCommit'] as const){
  const f=await setup(),i=instrument({legacy,fail});
  await assert.rejects(i.ledger.reconcile(f.snapshot,f.account.revision,1000),/injected_/);
  assert.deepEqual(await row(),f.account);assert.deepEqual(await observations(),[]);
  assert.equal(i.calls.at(-1),'ROLLBACK');assert.equal(i.freezes.length,1);
 }
});

test('differential lost COMMIT acknowledgement never returns receipt despite potentially durable result',async()=>{
 for(const legacy of [true,false]){
  const f=await setup(),i=instrument({legacy,fail:'lostCommitAck'});
  let returned=false;
  await assert.rejects(i.ledger.reconcile(f.snapshot,f.account.revision,1000).then(()=>{returned=true;}),/injected_commit_ack_lost/);
  assert.equal(returned,false);assert.equal((await row()).revision,'1');assert.equal((await observations()).length,1);
  assert.equal(i.calls.at(-1),'ROLLBACK');assert.equal(i.freezes.length,1);
 }
});

test('conservation failure stays before receipt and merged write',async()=>{
 const f=await setup();await pool.query('UPDATE v13_production_account SET initial_cash_micros=24000000 WHERE id=$1',[id]);
 const i=instrument();await assert.rejects(i.ledger.reconcile(f.snapshot,f.account.revision,1000),/production_money_conservation_failed/);
 assert.equal((await row()).revision,'0');assert.equal((await observations()).length,0);
 assert.equal(i.calls.some(sql=>sql.startsWith('UPDATE v13_production_account')),false);
});

test('differential STOP-like account mutation serializes after reconciliation and is not overwritten',async()=>{
 for(const legacy of [true,false]){
  const f=await setup();let stopped:Promise<unknown>|undefined;
  const i=instrument({legacy,beforeWrite:async()=>{
   stopped=pool.query('UPDATE v13_production_account SET kill_switch=true,execution_enabled=false,revision=revision+1 WHERE id=$1',[id]);
   const deadline=Date.now()+2000;
   while(Date.now()<deadline){
    const q=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE v13_production_account SET kill_switch=true%' AND cardinality(pg_blocking_pids(pid))>0");
    if(q.rows.length)return;
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   throw Error('stop_account_wait_not_observed');
  }});
  try{await i.ledger.reconcile(f.snapshot,f.account.revision,1000);await stopped;}finally{await stopped?.catch(()=>{});}
  const a=await row();assert.equal(a.revision,'2');assert.equal(a.kill_switch,true);assert.equal(a.execution_enabled,false);
  assert.equal(a.evidence_digest,digest(f.snapshot));assert.equal((await observations()).length,1);
 }
});

test('differential revision race before account lock rejects without writing or freezing',async()=>{
 for(const legacy of [true,false]){
  const f=await setup();await pool.query('UPDATE v13_production_account SET revision=revision+1,kill_switch=true,execution_enabled=false WHERE id=$1',[id]);
  const i=instrument({legacy});await assert.rejects(i.ledger.reconcile(f.snapshot,f.account.revision,1000),/production_observation_raced/);
  assert.equal((await row()).revision,'1');assert.equal((await row()).kill_switch,true);
  assert.equal((await observations()).length,0);assert.deepEqual(i.freezes,[]);
  assert.equal(i.calls.some(sql=>sql.startsWith('UPDATE')),false);
 }
});

test('ordinary persist caller retains existing SQL and does not replace reconciliation evidence',async()=>{
 const f=await setup();const i=instrument();
 await i.ledger.reconcile(f.snapshot,f.account.revision,1000);
 i.calls.length=0;
 await i.ledger.transaction(async(tx,a)=>{a.blocked_reason='test_unrelated_persist';await i.ledger.persist(tx,a);});
 const a=await row();assert.equal(a.revision,'2');assert.equal(a.blocked_reason,'test_unrelated_persist');
 assert.equal(a.evidence_digest,digest(f.snapshot));assert.equal(a.reconciled_at.getTime(),1000);
 assert.equal(i.calls.length,3);assert.equal(i.calls.filter(sql=>sql.startsWith('UPDATE')).length,1);
 assert.equal(i.calls.some(combined),false);assert.equal((await observations()).length,1);
});
