import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionLedger,type Account} from './ledger';
import {beginExecutionStage,type StageTiming} from './stageTiming';
import {digest,type Snapshot} from './types';
import {reconciliationObservation} from './reconciliationObservation';
const snapshot:Snapshot={identity:{subaccount:1,exchangeIndex:2,keyFingerprint:'private'},observedAtMs:1000,historyFromMs:0,complete:true,authenticated:true,cashExact:true,cashMicros:'25000000',orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
function fixture(fail:'none'|'persist'|'commit'='none',commitWait?:Promise<void>,onCommitEntered?:()=>void){
 const account={id:'account-a',revision:'1',subaccount:'1',exchange_index:'2',key_fingerprint:'private',cash_micros:'25000000',initial_cash_micros:'25000000',reserved_micros:'0'} as Account;
 const calls:{sql:string;params:unknown[]}[]=[];
 const tx={query:async(sql:string,params:unknown[]=[])=>{
  calls.push({sql,params});
  if(sql==="BEGIN; SELECT * FROM v13_production_account WHERE id='account-a' FOR UPDATE")return [{command:'BEGIN',rows:[]},{command:'SELECT',rows:[account]}];
  if(sql==='COMMIT'){onCommitEntered?.();if(commitWait)await commitWait;}
  if(sql.startsWith('SELECT e.cash'))return {rows:[{cash:'0',pnl:'0',basis:'0',position_pnl:'0',amount:'0'}]};
  if((fail==='persist'&&sql.startsWith('UPDATE'))||(fail==='commit'&&sql==='COMMIT'))throw Error('test_failure');
  if(sql.includes('v13_production_account')&&sql.startsWith('SELECT'))return {rows:[account]};
  return {rows:[]};
 },release(){}};
 class Ledger extends ProductionLedger{
  override async freeze(){/* failure accounting unchanged; no second tx in fixture */}
 }
 const ledger=new Ledger({connect:async()=>tx} as never,'account-a');
 return {ledger,calls};
}
test('committed pointer is exact inserted UUID/account with unchanged payload/digests and no extra SQL',async()=>{
 const {ledger,calls}=fixture();const before=JSON.stringify(snapshot);
 const receipt=await ledger.reconcile(snapshot,'1',1000);
 const insert=calls.find(x=>x.sql.startsWith('INSERT INTO v13_production_observation'))!;
 assert.equal(receipt.observationId,insert.params[0]);assert.equal(receipt.accountId,insert.params[1]);
 assert.equal(insert.params[3],JSON.stringify(reconciliationObservation(snapshot)));
 assert.equal(insert.params[4],digest(reconciliationObservation(snapshot)));
 assert.equal(calls.find(x=>x.sql.includes('reconciled_at=$5,evidence_digest=$6'))!.params[5],digest(snapshot));
 assert.equal(JSON.stringify(snapshot),before);assert.equal(calls.at(-1)!.sql,'COMMIT');
 assert.equal(calls.length,7); // Reconciliation combines two adjacent account UPDATEs into one request.
 assert.equal(calls[0]!.sql,"BEGIN; SELECT * FROM v13_production_account WHERE id='account-a' FOR UPDATE");
 assert.equal(calls.filter(x=>x.sql.includes('v13_production_observation')).length,1);
});
test('rollback and failed/uncertain COMMIT never return or emit a durable reconciliation pointer',async()=>{
 for(const failure of ['persist','commit'] as const){
  const {ledger,calls}=fixture(failure);const events:StageTiming[]=[];
  const end=beginExecutionStage(e=>{events.push(e)},'ledger_reconcile_commit',{accountId:'account-a',mode:'LIVE'});
  await assert.rejects(async()=>{try{const reconciliationReceipt=await ledger.reconcile(snapshot,'1',1000);end('completed',{reconciliationReceipt});}catch(error){end('rejected',{error});throw error;}});
  await Promise.resolve();assert.equal(calls.at(-1)!.sql,'ROLLBACK');
  assert.equal(events.length,1);assert.equal(events[0]!.outcome,'rejected');
  assert.equal(events[0]!.reconciliationObservationId,undefined);
 }
});
test('receipt metadata is UUID-only, account-bound and restricted to completed ledger commit',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 for(const [stage,outcome,accountId,observationId,expected] of [
 ['ledger_reconcile_commit','completed','account-a',id,id],
 ['ledger_reconcile_commit','completed','account-b',id,undefined],
 ['ledger_reconcile_commit','rejected','account-a',id,undefined],
 ['signed_snapshot','completed','account-a',id,undefined],
 ['ledger_reconcile_commit','completed','account-a','Bearer secret',undefined],
 ['ledger_reconcile_commit','completed','account-a',{toString:()=>id,secret:'must not appear'},undefined],
 ] as const){
  const events:StageTiming[]=[];const end=beginExecutionStage(e=>{events.push(e)},stage,{accountId:'account-a',mode:'LIVE'});
  end(outcome,{reconciliationReceipt:{accountId,observationId,secret:'must not appear'} as never});
  await Promise.resolve();assert.equal(events[0]!.reconciliationObservationId,expected);
  assert.equal(JSON.stringify(events).includes('must not appear'),false);
 }
});
test('actual executor forwards committed pointer exactly once on existing event, not snapshot/authority stages',async()=>{
 const {ProductionExecutor}=await import('./executor');
 const id='11111111-1111-4111-8111-111111111111';let providerReads=0;
 const executor=new ProductionExecutor({accountId:'account-a',readReconcileAccount:async()=>({account:{id:'account-a'},earliest:null}),reconcile:async()=>({accountId:'account-a',observationId:id})} as never,
  {mode:'SIMULATION',snapshot:async()=>{providerReads++;return {};}} as never,()=>1000);
 const events:StageTiming[]=[];executor.timingObserver=e=>{events.push(e)};
 await executor.reconcile();await Promise.resolve();
 assert.equal(providerReads,1);
 assert.deepEqual(events.filter(e=>e.reconciliationObservationId).map(e=>[e.stage,e.reconciliationObservationId]),[['ledger_reconcile_commit',id]]);
 assert.deepEqual(events.map(e=>e.stage),['signed_snapshot','ledger_reconcile_commit','reconciliation']);
});
test('held COMMIT cannot emit early pointer; release emits once, actual executor rejection omits it',async()=>{
 const {ProductionExecutor}=await import('./executor');
 for(const failure of ['none','commit'] as const){
  let release!:()=>void;const wait=new Promise<void>(r=>{release=r});
  let entered!:()=>void;const commitEntered=new Promise<void>(r=>{entered=r});
  const {ledger}=fixture(failure,wait,entered);
  ledger.readReconcileAccount=async()=>({account:{id:'account-a',revision:'1'} as Account,earliest:null});
  const executor=new ProductionExecutor(ledger,{mode:'SIMULATION',snapshot:async()=>snapshot} as never,()=>1000);
  const events:StageTiming[]=[];executor.timingObserver=e=>{events.push(e)};
  const pending=executor.reconcile();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([commitEntered,pending.then(()=>{throw Error('reconciliation_returned_before_commit');}),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('commit_entry_timeout')),1000);})]);}
  finally{if(timer)clearTimeout(timer);}
  assert.equal(events.some(e=>e.reconciliationObservationId!==undefined),false);
  assert.equal(events.some(e=>e.stage==='ledger_reconcile_commit'),false);
  release();if(failure==='commit')await assert.rejects(pending);else await pending;
  await Promise.resolve();
  assert.equal(events.filter(e=>e.reconciliationObservationId!==undefined).length,failure==='commit'?0:1);
 }
});
