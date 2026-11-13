import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ProductionLedger,HeldReconciliationCommitUncertain,type Account,type Intent,type HeldReconciliationGuard} from './ledger';
import {digest,type Snapshot} from './types';
import {entryCashProof,cashRiskModelFingerprint,cashRiskFeeFingerprint,ENTRY_CASH_RISK_VERSION} from '../v13EntryCashRisk';
import type {V13VerifiedFeeEvidence} from '../v13LiveMoneyEntryPreflight';
const snapshot:Snapshot={identity:{subaccount:1,exchangeIndex:2,keyFingerprint:'private'},observedAtMs:1000,historyFromMs:0,complete:true,authenticated:true,cashExact:true,cashMicros:'25000000',orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
function fixture(){
 const account={id:'a',revision:'1',subaccount:'1',exchange_index:'2',key_fingerprint:'private',cash_micros:'25000000',initial_cash_micros:'25000000',reserved_micros:'0',blocked_reason:'prior_freeze'} as Account;
 const calls:{sql:string;params:unknown[]}[]=[];
 const responses = new Map<string, unknown[]>();
 let clock=1000,freezes=0,connects=0,failCommit=false,releaseFails=false;
 let queryHook:((sql:string)=>Promise<void>)|undefined;
 const client=Object.assign(new EventEmitter(),{_queryable:true,_ending:false,_ended:false,connection:{stream:{destroyed:false}},
  query:async(sql:string,params:unknown[]=[])=>{
   calls.push({sql,params});await queryHook?.(sql);
   for (const [prefix, rows] of responses) if(sql.startsWith(prefix)) return {rows};
   if(sql==='COMMIT'&&failCommit)throw Error('socket lost');
   if(sql.startsWith('SELECT e.cash'))return {rows:[{cash:'0',pnl:'0',basis:'0',position_pnl:'0',amount:'0'}]};
   if(sql.startsWith('UPDATE v13_production_account SET cash_micros=')&&sql.endsWith('RETURNING revision::text AS revision'))return {rows:[{revision:String(BigInt(account.revision)+1n)}]};
   if(sql.startsWith('SELECT * FROM v13_production_account'))return {rows:[account]};
   return {rows:[]};
  },release(){if(releaseFails)throw Error('release failed');}});
 class Ledger extends ProductionLedger {override async freeze(){freezes++;}}
 const ledger=new Ledger({connect:async()=>{connects++;return client;}} as never,'a');
 const phases:string[]=[];
 const guard:HeldReconciliationGuard={now:()=>clock,deadlineMs:2000,
  lock:async(tx)=>{assert.equal(tx,client);assert.equal(ledger.currentTransaction(),client);phases.push('lock');},
  beforeCommit:async(tx)=>{assert.equal(tx,client);assert.equal(calls.at(-1)!.params[2],'HELD_RECONCILIATION_RECEIPT');phases.push('final');}};
 return {ledger,client,calls,guard,phases,account,responses,setClock:(n:number)=>{clock=n;},
  failCommit:()=>{failCommit=true;},failRelease:()=>{releaseFails=true;},
  hook:(fn:(sql:string)=>Promise<void>)=>{queryHook=fn;},counts:()=>({freezes,connects})};
}
test('held receipt and finances use one bounded transaction, existing freeze retained',async()=>{
 const f=fixture();const receipt=await f.ledger.reconcileHeld(snapshot,'1',f.guard);
 assert.deepEqual(f.phases,['lock','final']);assert.deepEqual(f.counts(),{freezes:0,connects:1});
 assert.equal(f.calls[0]!.sql,'BEGIN');assert.deepEqual(f.calls[1]!.params,['750ms','1000ms']);
 const observations=f.calls.filter(x=>x.sql.startsWith('INSERT INTO v13_production_observation'));
 assert.equal(observations.length,2);assert.equal(receipt.observationId,observations[0]!.params[0]);
 assert.equal(receipt.receiptId,observations[1]!.params[0]);assert.equal(receipt.revision,'2');
 const payload=JSON.parse(observations[1]!.params[3] as string);
 assert.equal(payload.financialDigest,receipt.financialDigest);assert.equal(payload.evidenceDigest,digest(snapshot));
 assert.equal(f.calls.find(x=>x.sql.startsWith('UPDATE v13_production_account'))!.params[3],'prior_freeze');
 assert.equal(f.calls.at(-1)!.sql,'COMMIT');assert.equal(f.ledger.currentTransaction(),null);
});
for(const phase of ['lock','final'] as const)test(`${phase} refusal rolls back, never commits or freezes in another transaction`,async()=>{
 const f=fixture();f.guard[phase==='lock'?'lock':'beforeCommit']=async()=>{throw Error('lease_changed');};
 await assert.rejects(f.ledger.reconcileHeld(snapshot,'1',f.guard),/lease_changed/);
 assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');assert(!f.calls.some(x=>x.sql==='COMMIT'));
 assert.deepEqual(f.counts(),{freezes:0,connects:1});
});
for(const phase of ['lock','final'] as const)test(`deadline and regressing clock after ${phase} hook refuse`,async()=>{
 for(const clock of [2000,999]){
  const f=fixture();f.guard[phase==='lock'?'lock':'beforeCommit']=async()=>f.setClock(clock);
  await assert.rejects(f.ledger.reconcileHeld(snapshot,'1',f.guard),/expired_or_clock_invalid/);
  assert(!f.calls.some(x=>x.sql==='COMMIT'));assert.equal(f.counts().freezes,0);
 }
});
test('account lock wait expiry is checked before trusted lock hook',async()=>{
 const f=fixture();f.hook(async sql=>{if(sql.includes('FOR UPDATE'))f.setClock(2000);});
 await assert.rejects(f.ledger.reconcileHeld(snapshot,'1',f.guard),/expired_or_clock_invalid/);
 assert.deepEqual(f.phases,[]);assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');
});
test('financial mismatch still refuses and retains hold without unfenced freeze',async()=>{
 const f=fixture();await assert.rejects(f.ledger.reconcileHeld({...snapshot,cashMicros:'1'},'1',f.guard),/external_cash_mismatch/);
 assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');assert.equal(f.counts().freezes,0);
});
test('revision mismatch refuses without unfenced freeze',async()=>{
 const f=fixture();await assert.rejects(f.ledger.reconcileHeld(snapshot,'2',f.guard),/observation_raced/);
 assert.equal(f.counts().freezes,0);assert(!f.calls.some(x=>x.sql.startsWith('UPDATE')));
});
test('connection loss at final hook prevents COMMIT',async()=>{
 const f=fixture();f.guard.beforeCommit=async()=>{f.client.emit('error',Error('lost'));};
 await assert.rejects(f.ledger.reconcileHeld(snapshot,'1',f.guard),/connection_unavailable/);
 assert(!f.calls.some(x=>x.sql==='COMMIT'));assert.equal(f.counts().freezes,0);
});
test('uncertain COMMIT returns no receipt and does not rollback, freeze or retry',async()=>{
 const f=fixture();f.failCommit();await assert.rejects(f.ledger.reconcileHeld(snapshot,'1',f.guard),HeldReconciliationCommitUncertain);
 assert.equal(f.calls.at(-1)!.sql,'COMMIT');assert.equal(f.calls.filter(x=>x.sql==='COMMIT').length,1);
 assert.deepEqual(f.counts(),{freezes:0,connects:1});
});
test('receipt is not exposed before acknowledged COMMIT and release errors do not erase it',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;
 const waiting=new Promise<void>(resolve=>{release=resolve;});const atCommit=new Promise<void>(resolve=>{entered=resolve;});
 f.hook(async sql=>{if(sql==='COMMIT'){entered();await waiting;}});f.failRelease();
 let returned=false;const pending=f.ledger.reconcileHeld(snapshot,'1',f.guard).then(r=>{returned=true;return r;});
 await atCommit;assert.equal(returned,false);release();assert.equal((await pending).revision,'2');
});
test('snapshot and callback references are pinned before awaits',async()=>{
 const f=fixture();const input=structuredClone(snapshot);const old=f.guard.beforeCommit;let count=0;
 f.guard.beforeCommit=async(...args)=>{count++;return old(...args);};
 f.hook(async sql=>{if(sql==='BEGIN'){input.cashMicros='1';f.guard.beforeCommit=async()=>{throw Error('replaced');};f.guard.deadlineMs=0;}});
 await f.ledger.reconcileHeld(input,'1',f.guard);assert.equal(count,1);
});
test('invalid or overlong deadline never opens a connection',async()=>{
 for(const deadlineMs of [1000,1000+15001,NaN]){
  const f=fixture();f.guard.deadlineMs=deadlineMs;
  await assert.rejects(f.ledger.reconcileHeld(snapshot,'1',f.guard),/deadline_invalid/);
  assert.equal(f.counts().connects,0);
 }
});

function entryIntent(terminal=false): Intent {
 const request={market:'m',side:'YES',action:'BUY',limitMicros:500000,timeInForce:'IOC',reduceOnly:false,clientOrderId:'client',contracts:1} as const;
 const decision={},policy_hash='policy',fee_fingerprint='fee';
 return {id:'entry',account_id:'a',evaluation_id:null,parent_id:null,kind:'ENTRY',market:'m',side:'YES',
  state:terminal?'TERMINAL':'UNKNOWN',request,decision,policy_hash,fee_fingerprint,
  capability_digest:digest({id:'entry',request,decision,policyHash:policy_hash,fee:fee_fingerprint}),
  client_order_id:'client',exchange_order_id:'order',reserved_micros:'0',exit_fee_micros:'0',
  filled_hundredths:'0',terminal,cancel_attempted:false,created_at:new Date(0),dispatch_at:new Date(500)};
}
for (const priorFreeze of ['prior_freeze',null]) {
 for(const reason of ['late_fill_after_terminal','entry_cost_exceeded_remaining_reservation','terminal_order_reopened','overlap_ownership_after_late_fill'] as const) {
  test(`held ${reason} refuses rather than hiding risk behind ${priorFreeze ?? 'no freeze'}`,async()=>{
   const f=fixture();f.account.blocked_reason=priorFreeze;
   const evidence=structuredClone(snapshot);
   if(reason==='overlap_ownership_after_late_fill') {
    f.responses.set('SELECT market,side,quantity_hundredths',[{market:'m',side:'YES',quantity_hundredths:'100'},{market:'n',side:'YES',quantity_hundredths:'100'}]);
   } else {
    const i=entryIntent(reason!=='entry_cost_exceeded_remaining_reservation');
    f.responses.set('SELECT id,account_id,evaluation_id',[i]);
    f.responses.set('SELECT * FROM v13_production_position',[{id:'entry',quantity_hundredths:'0',basis_micros:'0'}]);
    evidence.orders=[{orderId:'order',request:i.request,terminal:false,filledHundredths:'0'}];
    if(reason!=='terminal_order_reopened') evidence.fills=[{id:'fill',orderId:'order',clientOrderId:'client',market:'m',side:'YES',action:'BUY',quantityHundredths:'100',priceMicros:500000,grossMicros:'500000',feeMicros:'0',occurredAtMs:900}];
   }
   await assert.rejects(f.ledger.reconcileHeld(evidence,'1',f.guard),new RegExp(reason));
   assert.equal(f.account.blocked_reason,priorFreeze);
   assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');
   assert(!f.calls.some(x=>x.sql==='COMMIT'||x.sql.startsWith('UPDATE v13_production_account')));
   assert(!f.calls.some(x=>x.params[2]==='HELD_RECONCILIATION_RECEIPT'));
   assert.equal(f.counts().freezes,0);
  });
 }
}

for(const reason of ['exit_fee_exceeded_reservation','entry_fill_fee_bound_exceeded','entry_cash_bound_exceeded'] as const) {
 test(`held ${reason} rejects even with an existing freeze`,async()=>{
  const f=fixture(),i=entryIntent();
  const evidence=structuredClone(snapshot);
  let action:'BUY'|'SELL'='BUY',feeMicros='0';
  const intents=[i];
  if(reason==='exit_fee_exceeded_reservation') {
   const parent={...i,id:'parent',client_order_id:'parent-client'};
   i.kind='EXIT';i.parent_id=parent.id;i.request={...i.request,action:'SELL',reduceOnly:true};
   intents.push(parent);action='SELL';feeMicros='1';
  } else {
   const hash='a'.repeat(64);
   const risk={version:ENTRY_CASH_RISK_VERSION,marketTicker:'KXBTC15M-TEST',side:'YES' as const,
    modelFingerprint:'',gridDigest:hash,policyHash:hash,artifactDigest:hash,feeMetadataDigest:hash,seriesDigest:hash,
    entryCashDebitPerContractMicros:1000000,entryTradeFeePerContractMicros:17500,exitLossPerContractMicros:100};
   risk.modelFingerprint=cashRiskModelFingerprint(risk);
   const fee={contracts:1,limitPrice:0.5,reservedEntryFeeCents:2,reservedExitFeeCents:1,cashRisk:risk,fingerprint:''} as V13VerifiedFeeEvidence;
   fee.fingerprint=cashRiskFeeFingerprint(fee);
   i.fee_fingerprint=fee.fingerprint;i.decision={book:{fee},preflight:{cashRisk:entryCashProof(fee,1,200)}};
   i.capability_digest=digest({id:i.id,request:i.request,decision:i.decision,policyHash:i.policy_hash,fee:i.fee_fingerprint});
   if(reason==='entry_fill_fee_bound_exceeded')feeMicros='20001';
   else f.responses.set('SELECT coalesce(sum(-cash_delta_micros)',[{amount:'500001'}]);
  }
  f.responses.set('SELECT id,account_id,evaluation_id',intents);
  f.responses.set('SELECT * FROM v13_production_position',[{id:'entry',quantity_hundredths:'100',basis_micros:'500000'}]);
  evidence.orders=[{orderId:'order',request:i.request,terminal:false,filledHundredths:'0'}];
  evidence.fills=[{id:'fill',orderId:'order',clientOrderId:'client',market:'m',side:'YES',action,quantityHundredths:'100',priceMicros:500000,grossMicros:'500000',feeMicros,occurredAtMs:900}];
  await assert.rejects(f.ledger.reconcileHeld(evidence,'1',f.guard),new RegExp(reason));
  assert.equal(f.account.blocked_reason,'prior_freeze');assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');
  assert(!f.calls.some(x=>x.sql==='COMMIT'||x.sql.startsWith('UPDATE v13_production_account')));
  assert.equal(f.counts().freezes,0);
 });
}
