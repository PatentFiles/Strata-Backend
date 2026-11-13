import test from 'node:test';
import assert from 'node:assert/strict';
import {fenceOwnerUnknownForAccounting} from './ownerUnknownRecoveryFence';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION} from './ownerUnknownRecoveryPlan';
const owner='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
const input={ownerId:owner,targetIntentId:target,confirmation:OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION};
function fixture(options:{fail?:string;commitThenFail?:boolean;running?:boolean;change?:string}={}){
 const initial={account:{id:'synthetic-account',owner_user_id:owner,revision:'7',key_fingerprint:'f'.repeat(64),
  subaccount:1,exchange_index:2,kill_switch:false,execution_enabled:true,cash_micros:'25000000',
  reserved_micros:'6000000',blocked_reason:'personal_exchange_history_unreconciled'},
  lease:{execution_account_id:'synthetic-account',owner_user_id:owner,state:'owned',fencing_token:'7',
   credential_fingerprint:'f'.repeat(64),account_kill:false,arm_requested:true},
  intent:{id:target,account_id:'synthetic-account',kind:'ENTRY',state:'UNKNOWN',terminal:false,
   reserved_micros:'6000000'},events:[] as unknown[]};
 let durable=structuredClone(initial),work=structuredClone(initial),connects=0,released=false,discarded=false;
 const calls:string[]=[];
 async function query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>{
  calls.push(sql);
  if(options.fail&&sql.includes(options.fail))throw Error('injected_failure');
  if(sql==='BEGIN'){work=structuredClone(durable);return {rows:[]};}
  if(sql.startsWith('SET LOCAL'))return {rows:[]};
  if(sql==='COMMIT'){
   durable=structuredClone(work);if(options.commitThenFail)throw Error('lost_commit_ack');return {rows:[]};
  }
  if(sql==='ROLLBACK'){work=structuredClone(durable);return {rows:[]};}
  if(sql.startsWith('SELECT id FROM public.v13_production_account'))return {rows:[{id:durable.account.id}]};
  if(sql.startsWith('SELECT id,owner_user_id'))return {rows:[{...work.account,
   ...(options.change==='foreignOwner'?{owner_user_id:'33333333-3333-4333-8333-333333333333'}:{}),
   ...(options.change==='scope'?{exchange_index:1}:{})}]};
  if(sql.startsWith('SELECT execution_account_id'))return {rows:[{...work.lease,
   ...(options.change==='wrongKey'?{credential_fingerprint:'a'.repeat(64)}:{}),
   ...(options.change==='overflowToken'?{fencing_token:'9223372036854775807'}:{})}]};
  if(sql.startsWith('SELECT id,account_id,kind'))return {rows:[{...work.intent,
   ...(options.change==='terminal'?{state:'TERMINAL',terminal:true}:{}),
   ...(options.change==='foreignIntent'?{account_id:'other-account'}:{})}]};
  if(sql.startsWith('UPDATE public.v13_production_account')){
   assert.deepEqual(args,['synthetic-account',owner,'7']);
   if(options.change==='accountCas')return {rows:[]};
   work.account.kill_switch=true;work.account.execution_enabled=false;work.account.revision='8';
   return {rows:[{revision:'8'}]};
  }
  if(sql.startsWith('UPDATE private.kalshi_account_worker_lease')){
   assert.deepEqual(args,['synthetic-account',owner,'7']);
   if(options.change==='leaseCas')return {rows:[]};
   work.lease.state='killed';work.lease.account_kill=true;work.lease.arm_requested=false;work.lease.fencing_token='8';
   return {rows:[{fencing_token:'8'}]};
  }
  if(sql.startsWith('INSERT INTO public.v13_production_observation')){
   work.events.push(args);return {rows:[]};
  }
  throw Error('unexpected_sql');
 }
 const db={query,connect:async()=>{connects++;return {query,release(e?:Error){released=true;discarded=!!e;}};}};
 return {db,initial,state:()=>durable,calls,connects:()=>connects,released:()=>released,discarded:()=>discarded,
  run:()=>fenceOwnerUnknownForAccounting(input,{db,isScheduled:()=>options.running??false})};
}
test('atomic offline safety fence kills account/lease and preserves UNKNOWN, $6 reservation, cash and freeze',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.reason,'unknown_accounting_safety_fence_committed');
 const s=f.state();assert.equal(s.account.kill_switch,true);assert.equal(s.account.execution_enabled,false);
 assert.equal(s.lease.state,'killed');assert.equal(s.lease.arm_requested,false);assert.equal(s.lease.account_kill,true);
 assert.equal(s.lease.fencing_token,'8');assert.equal(s.account.revision,'8');
 assert.equal(s.account.cash_micros,'25000000');assert.equal(s.account.reserved_micros,'6000000');
 assert.equal(s.account.blocked_reason,'personal_exchange_history_unreconciled');assert.deepEqual(s.intent,f.initial.intent);
 assert.equal(s.events.length,1);assert.equal(f.released(),true);assert.equal(f.discarded(),false);
 assert.equal(f.calls.filter(x=>x==='COMMIT').length,1);
 for(const k of ['ordersSubmitted','workerStarted','tradingAuthorized','riskFreezeCleared',
  'accountingCommitted','reservationsReleased'] as const)assert.equal(r[k],false);
 const account=f.calls.findIndex(x=>x.startsWith('SELECT id,owner_user_id'));
 const lease=f.calls.findIndex(x=>x.startsWith('SELECT execution_account_id'));
 assert.ok(account>0&&lease>account);assert.match(f.calls[account]!,/FOR UPDATE/);
 assert.match(f.calls[lease]!,/FOR UPDATE/);
 const writes=f.calls.filter(x=>x.startsWith('UPDATE'));
 assert.equal(writes.length,2);assert.equal(writes.some(x=>/cash_micros|reserved_micros|blocked_reason|v13_production_intent/.test(x)),false);
});
test('bad owner, target or confirmation touches no database',async()=>{
 for(const bad of [{ownerId:'bad'},{targetIntentId:'bad'},{confirmation:'go'}]){
  const f=fixture();const r=await fenceOwnerUnknownForAccounting({...input,...bad},{db:f.db,isScheduled:()=>false});
  assert.equal(r.ok,false);assert.equal(f.calls.length,0);assert.equal(f.connects(),0);
 }
});
test('missing worker registry fails before database access',async()=>{
 const f=fixture(),r=await fenceOwnerUnknownForAccounting(input,{db:f.db,isScheduled:undefined as never});
 assert.equal(r.ok,false);assert.equal(f.calls.length,0);
});
test('known running worker fails before any transaction or mutation',async()=>{
 const f=fixture({running:true}),r=await f.run();assert.equal(r.ok,false);assert.equal(f.connects(),0);
 assert.deepEqual(f.state(),f.initial);
});
for(const change of ['foreignOwner','scope','wrongKey','overflowToken','terminal','foreignIntent','accountCas','leaseCas'])
 test(`rollback preserves all state on ${change}`,async()=>{
  const f=fixture({change}),r=await f.run();assert.equal(r.ok,false,JSON.stringify(r));
  assert.equal(r.outcomeUnknown,false);assert.deepEqual(f.state(),f.initial);
  assert.ok(f.calls.includes('ROLLBACK'));assert.ok(!f.calls.includes('COMMIT'));
 });
for(const fail of ['SELECT id,owner_user_id','SELECT execution_account_id','UPDATE public.v13_production_account',
 'UPDATE private.kalshi_account_worker_lease','INSERT INTO public.v13_production_observation'])
 test(`transaction error before ${fail.split(' ')[0]} acknowledgement rolls back`,async()=>{
  const f=fixture({fail}),r=await f.run();assert.equal(r.ok,false);assert.equal(r.outcomeUnknown,false);
  assert.deepEqual(f.state(),f.initial);assert.ok(f.calls.includes('ROLLBACK'));assert.equal(f.released(),true);
 });
test('lost COMMIT acknowledgement reports uncertain receipt and discards connection without blind retry',async()=>{
 const f=fixture({commitThenFail:true}),r=await f.run();assert.equal(r.ok,false);
 assert.equal(r.reason,'recovery_fence_commit_outcome_unverified');assert.equal(r.outcomeUnknown,true);
 assert.match(r.attemptId!,/^[0-9a-f-]{36}$/);assert.equal(f.discarded(),true);
 assert.equal(f.state().events.length,1);assert.equal(f.state().lease.fencing_token,'8');
 assert.equal(f.state().intent.state,'UNKNOWN');assert.equal(f.state().intent.reserved_micros,'6000000');
 assert.equal(f.calls.filter(x=>x==='COMMIT').length,1);
});
test('COMMIT error before commit also remains uncertain because caller cannot infer server outcome',async()=>{
 const f=fixture({fail:'COMMIT'}),r=await f.run();assert.equal(r.ok,false);assert.equal(r.outcomeUnknown,true);
 assert.deepEqual(f.state(),f.initial);assert.equal(f.discarded(),true);
});
