import test from 'node:test';
import assert from 'node:assert/strict';
import {economicDischargeFixture} from './economicExitDischargeFixture';
import {proveEconomicDischarge,economicDischargePlan} from './economicExitDischargeEvidence';
import {verifyEconomicRuntimeEvidence,readEconomicRuntimeEvidence} from './economicExitRuntimeEvidence';
import {captureEconomicProtectiveEvidence,recheckEconomicProtectiveEvidence} from './economicExitProtectiveEvidence';
import {digest} from '../v13-production/types';
import type {Account} from '../v13-production/ledger';
function fixture(){
 const f=economicDischargeFixture(),p=economicDischargePlan(proveEconomicDischarge(f));
 const row:Record<string,unknown>={request_id:'test-discharge',execution_account_id:p.accountId,owner_user_id:p.ownerId,
  exit_intent_id:p.exitId,client_order_id:p.exitRequest.clientOrderId,exit_dispatch_at:p.exitDispatchAt,
  settlement_event_id:p.settlementEventId,settlement_digest:p.settlementDigest,payload:p,payload_digest:digest(p),
  entry_intent_id:p.parentId,reservation_id:p.reservationId,booking_request_id:p.bookingRequestId,booking_digest:p.bookingDigest,
  exit_request:p.exitRequest,exit_capability_digest:p.exitCapabilityDigest};
 const scope={account:f.account as unknown as Account,ownerId:p.ownerId,snapshot:structuredClone(f.snapshot),nowMs:f.nowMs,currentIntentId:null as string|null};
 const db={query:async(sql:string)=>({rows:sql.includes('FROM private.strata_economic_exit_discharge')?[row]:
   sql.includes('strata_has_economic_exit_discharge')?[{verified:true}]:[scope.account as unknown as Record<string,unknown>]})};
 return {row,scope,db,p};
}
test('fresh exact receipt permits only its retained historic identity, without implying trading authority',()=>{
 const x=fixture(),p=verifyEconomicRuntimeEvidence([x.row],x.scope);assert.deepEqual(p.exitIds,[x.p.exitId]);
 assert.equal(p.observedAtMs,x.scope.snapshot.observedAtMs);assert(Object.isFrozen(p));
 const future=fixture();future.scope.account.cash_micros='50000000';future.scope.snapshot.cashMicros='50000000';
 assert(verifyEconomicRuntimeEvidence([future.row],future.scope),'later reconciled earnings do not rewrite the old receipt');
});
const bad:Array<[string,(x:ReturnType<typeof fixture>)=>void]>=[
 ['stale',x=>x.scope.nowMs=x.scope.snapshot.observedAtMs+5001],
 ['future clock',x=>x.scope.nowMs=x.scope.snapshot.observedAtMs-1],
 ['incomplete history',x=>x.scope.snapshot.complete=false],
 ['unsigned',x=>x.scope.snapshot.authenticated=false],
 ['inexact cash',x=>x.scope.snapshot.cashExact=false],
 ['unexplained movement',x=>x.scope.snapshot.unexplainedCashActivity=true],
 ['wrong cash',x=>x.scope.snapshot.cashMicros='1'],
 ['different owner',x=>x.scope.ownerId='foreign'],
 ['different account',x=>x.scope.account.id='other'],
 ['different key',x=>x.scope.snapshot.identity.keyFingerprint='f'.repeat(64)],
 ['different shard',x=>x.scope.snapshot.identity.exchangeIndex=3 as 2],
 ['history gap',x=>x.scope.snapshot.historyFromMs=x.scope.snapshot.observedAtMs],
 ['missing settlement',x=>x.scope.snapshot.settlements=[]],
 ['duplicate settlement',x=>x.scope.snapshot.settlements.push(structuredClone(x.scope.snapshot.settlements[0]!))],
 ['changed payout',x=>x.scope.snapshot.settlements[0]!.payoutMicros='1'],
 ['changed fee',x=>x.scope.snapshot.settlements[0]!.feeMicros='1'],
 ['nonzero retired-market exposure',x=>x.scope.snapshot.positions.push({market:x.p.settlement.market,side:'YES',quantityHundredths:'1'})],
 ['later order',x=>x.scope.snapshot.orders.push({...x.scope.snapshot.orders[0]!,request:{...x.scope.snapshot.orders[0]!.request,clientOrderId:String(x.row.client_order_id)}})],
 ['later fill',x=>x.scope.snapshot.fills.push({...x.scope.snapshot.fills[0]!,clientOrderId:String(x.row.client_order_id)})],
 ['attempt to replay retired exit',x=>x.scope.currentIntentId=x.p.exitId],
 ['corrupted receipt',x=>x.row.payload_digest='f'.repeat(64)],
];
for(const [name,mutate]of bad)test('runtime discharge refuses '+name,()=>{const x=fixture();mutate(x);assert.throws(()=>verifyEconomicRuntimeEvidence([x.row],x.scope));});
test('database recognition disabled has no new query; missing receipt grants no exception',async()=>{
 const before=process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;try{
 delete process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;const x=fixture();
 assert.equal(await readEconomicRuntimeEvidence({query:async()=>{throw Error('must not read');}},x.scope),null);
 process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED='true';
 assert.equal(await readEconomicRuntimeEvidence({query:async()=>({rows:[]})},x.scope),null);
 assert.deepEqual((await readEconomicRuntimeEvidence(x.db,x.scope))?.exitIds,[x.p.exitId]);
 await assert.rejects(readEconomicRuntimeEvidence({query:async(sql)=>sql.includes('strata_has_')?{rows:[{verified:false}]}:x.db.query(sql)},x.scope));
 }finally{if(before===undefined)delete process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;else process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED=before;}
});
test('protective final sender requires process-local carry for its exact owner, account, client and original timestamp',async()=>{
 const before=process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED='true';try{
 const x=fixture(),s={ownerId:x.p.ownerId,accountId:x.p.accountId,clientId:'new-exit-client',intentId:'new-exit-id'};
 const token=captureEconomicProtectiveEvidence(s,x.scope.snapshot);
 assert.equal(await recheckEconomicProtectiveEvidence(x.db,token,s,x.scope.nowMs),x.scope.snapshot.observedAtMs);
 for(const t of [undefined,{},JSON.parse(JSON.stringify(token))])await assert.rejects(recheckEconomicProtectiveEvidence(x.db,t,s,x.scope.nowMs));
 for(const change of [{ownerId:'foreign'},{accountId:'foreign'},{clientId:'foreign'},{intentId:x.p.exitId}])
  await assert.rejects(recheckEconomicProtectiveEvidence(x.db,token,{...s,...change},x.scope.nowMs));
 await assert.rejects(recheckEconomicProtectiveEvidence(x.db,token,s,x.scope.snapshot.observedAtMs+5001));
 x.scope.snapshot.settlements=[];
 assert.equal(await recheckEconomicProtectiveEvidence(x.db,token,s,x.scope.nowMs),x.scope.snapshot.observedAtMs,'carry owns an immutable clone');
 }finally{if(before===undefined)delete process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;else process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED=before;}
});

test('PostgreSQL numeric identity projection matches signed numeric scope without trusting coercible foreign values',()=>{
 const x=fixture();Object.assign(x.scope.account,{subaccount:'1',exchange_index:'2'});
 assert(verifyEconomicRuntimeEvidence([x.row],x.scope));
 Object.assign(x.scope.account,{exchange_index:'3'});assert.throws(()=>verifyEconomicRuntimeEvidence([x.row],x.scope));
});
