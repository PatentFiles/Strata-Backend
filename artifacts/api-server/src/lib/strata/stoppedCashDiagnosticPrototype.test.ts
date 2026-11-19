import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,type Snapshot} from '../v13-production/types';
import {inspectStoppedCashDiagnosticPrototype} from './stoppedCashDiagnosticPrototype';

const owner='11111111-1111-4111-8111-111111111111',sha='a'.repeat(40),fp='b'.repeat(64);
type Ports=Parameters<typeof inspectStoppedCashDiagnosticPrototype>[1];
type Held=NonNullable<Awaited<ReturnType<Ports['loadHeld']>>>;
const now=1_786_000_000_000;
const settlement={id:'leg-1',market:'KXBTC15M-FIXTURE',side:'NO',result:'NO',quantityHundredths:'100',payoutMicros:'1000000',feeMicros:'0',occurredAtMs:now-60_000} as const;
const fixture=()=>{
 const env={NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:sha,STRATA_STOPPED_CASH_DIAGNOSTIC_SHA:sha,
  STRATA_STOPPED_CASH_DIAGNOSTIC_ENABLED:'true',STRATA_STOPPED_CASH_DIAGNOSTIC_REVIEWED:'true'};
 const row:Held={owner,id:'account',armRequested:false,leaseState:'released',scheduled:false,freeze:'production_external_cash_mismatch',
  executionEnabled:true,killSwitch:false,leaseAccountKill:false,
  subaccount:1,exchangeIndex:2,cashMicros:'25000000',initialCashMicros:'24000000',reservedMicros:'0',
  commissioned:true,cashPrecisionVerified:true,approvedPolicy:true,positionCount:0,outstandingCount:0,reservationCount:0,
  releaseSha:sha,holdFence:'3'.repeat(64),keyFingerprint:fp,historyDigest:'4'.repeat(64),
  requests:[],neverPosted:[],expectedOrders:[],events:[{id:'settlement:leg-1',digest:digest(settlement),cashDeltaMicros:'1000000',realizedPnlMicros:'1000000'}],
  closedPositionBasisMicros:'0',closedPositionPnlMicros:'1000000'};
 const snapshot:Snapshot={identity:{subaccount:1,exchangeIndex:2,keyFingerprint:fp},observedAtMs:now,historyFromMs:0,
  complete:true,authenticated:true,cashExact:true,cashMicros:row.cashMicros,unexplainedCashActivity:false,orders:[],fills:[],settlements:[settlement],positions:[]};
 let db=0,keys=0,reads=0;let clock=0,after:((x:Held)=>Held)|null=null;
 const ports:Ports={wall:()=>now,mono:()=>clock,env:()=>env,
  loadHeld:async()=>{db++;return after&&db>2?after(row):row;},
  verifiedMaterial:async(subject,id,fingerprint)=>{keys++;assert.deepEqual([subject,id,fingerprint],[owner,row.id,fp]);return {keyId:'fixture',privateKey:'never-export-this'};},
  bracket:async(subject,mat,at)=>{reads++;assert.equal(subject,owner);assert.equal(mat.keyId,'fixture');assert.equal(at,now);clock=1100;return snapshot;}
 };
 return {env,row,snapshot,ports,counts:()=>[db,keys,reads],change:(fn:(x:Held)=>Held)=>{after=fn;},run:()=>inspectStoppedCashDiagnosticPrototype({subject:owner,aal:'aal2'},ports)};
};
test('complete stopped proof is private, one bracket only, never clearance',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.ok,true);assert.equal(r.tradingAuthorized,false);
 assert.equal(r.observationPersisted,false);assert.equal(r.ordersSubmitted,false);
 assert.deepEqual(f.counts(),[3,1,1]);assert.doesNotMatch(JSON.stringify(r),/never-export|leg-1|25000000/);
});
test('default-off, wrong SHA and AAL1 stop before database or signer',async()=>{
 const f=fixture();f.env.STRATA_STOPPED_CASH_DIAGNOSTIC_ENABLED='false';assert.equal((await f.run()).ok,false);
 f.env.STRATA_STOPPED_CASH_DIAGNOSTIC_ENABLED='true';f.env.RAILWAY_GIT_COMMIT_SHA='b'.repeat(40);assert.equal((await f.run()).ok,false);
 assert.equal((await inspectStoppedCashDiagnosticPrototype({subject:owner,aal:'aal1'},f.ports)).ok,false);
 assert.deepEqual(f.counts(),[0,0,0]);
});
test('refuses nonmatching freeze, schedule, arm, active order, reservation or position before signing',async()=>{
 for(const x of [{freeze:'awaiting_account_commissioning'},{scheduled:true},{armRequested:true},{outstandingCount:1},{positionCount:1},{reservationCount:1},{owner:'foreign'}]){
  const f=fixture();Object.assign(f.row,x);assert.equal((await f.run()).reason,'stopped_cash_scope_unverified');
  assert.deepEqual(f.counts(),[1,0,0]);
 }
});
test('post-bracket ARM→STOP ABA, credential/policy or ledger history revision changes cannot produce proof',async()=>{
 for(const edit of [{holdFence:'9'.repeat(64)},{keyFingerprint:'f'.repeat(64)},{historyDigest:'f'.repeat(64)},{freeze:null},{reservationCount:1},{executionEnabled:false},{killSwitch:true}]){
  const f=fixture();f.change(h=>({...h,...edit} as Held));assert.equal((await f.run()).reason,'stopped_cash_scope_changed');
 }
});
test('missing trailing balance, stale or issuer failures fail without retry',async()=>{
 for(const input of ['missing','stale','throw']){
  const f=fixture();let n=0;
  if(input==='missing')f.ports.bracket=async()=>{n++;return null;};
  if(input==='throw')f.ports.bracket=async()=>{n++;throw new Error('secret');};
  if(input==='stale'){const stock=f.ports.bracket;f.ports.bracket=async(...args)=>{n++;return stock(...args);};let t=0;f.ports.mono=()=>t++*5000;}
  const out=await f.run();assert.equal(n,1);assert.equal(out.ok,false);assert.doesNotMatch(JSON.stringify(out),/secret/);
 }
});
test('rejects incomplete archive, foreign pair, changed cent and missing/changed settlement on either side',async()=>{
 for(const edit of [
  (s:Snapshot)=>{s.complete=false;},(s:Snapshot)=>{s.identity.exchangeIndex=1;},
  (s:Snapshot)=>{s.cashMicros='24990000';},(s:Snapshot)=>{s.settlements=[];},
  (s:Snapshot)=>{s.settlements=[{...settlement,payoutMicros:'999000'}];},
  (s:Snapshot)=>{s.settlements.push({...settlement,id:'unexpected'});},
 ]){
  const f=fixture();edit(f.snapshot);assert.equal((await f.run()).reason,'stopped_cash_history_not_reconciled');
 }
});
test('time spent processing final verification counts against the original 5-second deadline',async()=>{
 const f=fixture();const moments=[0,4900,5000];
 f.ports.mono=()=>moments.shift()!;
 assert.equal((await f.run()).reason,'stopped_cash_proof_expired');assert.equal(f.counts()[2],1);
});
test('rejects unbounded or malformed local financial fields before credentials',async()=>{
 for(const replace of [{cashMicros:'9'.repeat(3000)},{closedPositionBasisMicros:'abc'},
  {events:[{id:'settlement:leg-1',digest:'a'.repeat(64),cashDeltaMicros:'1e30',realizedPnlMicros:'0'}]}]){
  const f=fixture();Object.assign(f.row,replace);
  assert.equal((await f.run()).reason,'stopped_cash_scope_unverified');
  assert.deepEqual(f.counts(),[1,0,0]);
 }
});
test('an unmatched local terminal intent is not silently ignored even without a provider ID',async()=>{
 const f=fixture();
 f.row.requests.push({market:'KXBTC15M-FIXTURE',side:'YES',action:'BUY',limitMicros:500000,timeInForce:'IOC',
  reduceOnly:false,contracts:1,clientOrderId:'local-no-id'});
 assert.equal((await f.run()).reason,'stopped_cash_scope_unverified');
 assert.deepEqual(f.counts(),[1,0,0]);
});
