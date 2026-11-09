import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planOwnerUnknownReconciliation,OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION} from
 './ownerUnknownRecoveryPlan';

const now=Date.parse('2026-11-08T23:30:00Z'),owner='11111111-1111-4111-8111-111111111111';
function fixture(){
 const request={market:'SYNTHETIC-BTC',side:'NO',action:'BUY',limitMicros:430000,
  timeInForce:'IOC',reduceOnly:false,clientOrderId:'synthetic-client',contracts:3};
 const h={ownerId:owner,accountId:'synthetic-account',subaccount:1,exchangeIndex:2,
  keyFingerprint:'f'.repeat(64),executionEnabled:false,killSwitch:true,leaseState:'killed',
  armRequested:false,accountKill:true,localWorkerRunning:false,accountRevision:'7',
  fencingToken:'8',preKillFencingToken:'7',killCommittedAtMs:now-2000,
  revisions:{account:'27',lease:'28',credential:'9',policy:'10',financial:'11',provider:'12'},
  activeProtectiveReservations:'0',pendingTransfers:'0',cashMicros:'25000000',
  reservedMicros:'6000000',blockedReason:'personal_exchange_history_unreconciled'};
 const intents=[{id:'synthetic-intent',accountId:h.accountId,createdAtMs:now-100000,
  kind:'ENTRY',state:'UNKNOWN',terminal:false,request,reservedMicros:'6000000',
  filledHundredths:'0',exchangeOrderId:'synthetic-order'}];
 return {ownerId:owner,confirmation:OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,nowMs:now,
  heldBefore:h,heldAfter:structuredClone(h),targetIntentId:'synthetic-intent',
  intents,finalIntents:structuredClone(intents),historicalCoverageComplete:true,
  snapshot:{identity:{subaccount:1,exchangeIndex:2,keyFingerprint:h.keyFingerprint},
   observedAtMs:now-1000,historyFromMs:now-100000,authenticated:true,complete:true,
   cashExact:true,unexplainedCashActivity:false,cashMicros:'23720000',
   orders:[{orderId:'synthetic-order',request:structuredClone(request),terminal:true,filledHundredths:'300'}],
   fills:[{id:'synthetic-fill',orderId:'synthetic-order',clientOrderId:request.clientOrderId,
    market:request.market,side:'NO',action:'BUY',quantityHundredths:'300',priceMicros:410000,
    grossMicros:'1230000',feeMicros:'50000',occurredAtMs:now-99000}],
   positions:[] as Array<Record<string,unknown>>,
   settlements:[{id:'synthetic-settlement',market:request.market,side:'NO',result:'YES',
    quantityHundredths:'300',payoutMicros:'0',feeMicros:'0',occurredAtMs:now-50000}]}};
}
type Fixture=ReturnType<typeof fixture>;
function deny(f:Fixture,reason?:string){
 const before=JSON.stringify(f),r=planOwnerUnknownReconciliation(f);
 assert.equal(r.ok,false,JSON.stringify(r));if(reason)assert.equal(r.reason,reason);
 assert.equal(r.plan,undefined);assert.equal(JSON.stringify(f),before,'no input changes');
 for(const k of ['ordersSubmitted','workerStarted','tradingAuthorized','riskFreezeCleared',
  'accountingCommitted','reservationsReleased'] as const)assert.equal(r[k],false);
 assert.equal(r.ledgerValidationStillRequired,true);
}
test('synthetic terminal losing 3-NO fill proposes locked ledger accounting, never cash or reserve writes',()=>{
 const f=fixture(),before=JSON.stringify(f),r=planOwnerUnknownReconciliation(f);
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.reason,'ready_for_locked_ledger_reconciliation');
 assert.equal(r.plan?.targetFilledHundredths,'300');assert.equal(r.plan?.targetOrderId,'synthetic-order');
 assert.equal(r.plan?.expectedAccountRevision,'7');assert.equal(r.plan?.expectedFencingToken,'8');
 assert.equal(r.plan?.expiresAtMs,now+14000);assert.match(r.plan!.snapshotDigest,/^[0-9a-f]{64}$/);
 assert.equal(JSON.stringify(f),before);assert.equal(f.heldBefore.reservedMicros,'6000000');
 for(const k of ['ordersSubmitted','workerStarted','tradingAuthorized','riskFreezeCleared',
  'accountingCommitted','reservationsReleased'] as const)assert.equal(r[k],false);
 assert.equal(r.ledgerValidationStillRequired,true);
});
test('same synthetic evidence is deterministic and read-only',()=>{
 const f=fixture();assert.deepEqual(planOwnerUnknownReconciliation(f),planOwnerUnknownReconciliation(f));
});
const holdCases:Array<[string,(f:Fixture)=>void]>=[
 ['foreign owner',f=>{f.ownerId='22222222-2222-4222-8222-222222222222';}],
 ['missing explicit confirmation',f=>{f.confirmation='go';}],
 ['other subaccount',f=>{f.heldBefore.subaccount=2;}],
 ['other exchange index',f=>{f.heldBefore.exchangeIndex=1;}],
 ['execution still enabled',f=>{f.heldBefore.executionEnabled=true;}],
 ['no account kill',f=>{f.heldBefore.killSwitch=false;}],
 ['stale OWNED lease is not a kill',f=>{f.heldBefore.leaseState='owned';}],
 ['released lease is not a kill',f=>{f.heldBefore.leaseState='released';}],
 ['lease is armed',f=>{f.heldBefore.armRequested=true;}],
 ['lease account-kill absent',f=>{f.heldBefore.accountKill=false;}],
 ['worker still running',f=>{f.heldBefore.localWorkerRunning=true;}],
 ['missing token advancement',f=>{f.heldBefore.fencingToken='7';}],
 ['malformed token',f=>{f.heldBefore.fencingToken='08';}],
 ['missing revision',f=>{f.heldBefore.revisions.credential='0';}],
 ['pending protective reservation',f=>{f.heldBefore.activeProtectiveReservations='1';}],
 ['pending transfer',f=>{f.heldBefore.pendingTransfers='1';}],
 ['overreserved ledger',f=>{f.heldBefore.reservedMicros='26000000';}],
 ['kill in future',f=>{f.heldBefore.killCommittedAtMs=now+1;}],
];
for(const [name,change] of holdCases)test(`rejects ${name}`,()=>{
 const f=fixture();change(f);f.heldAfter=structuredClone(f.heldBefore);deny(f);
});
test('rechecks hold revision after evidence, including ARM/KILL ABA',()=>{
 const f=fixture();f.heldAfter.revisions.lease='29';deny(f,'recovery_hold_changed');
});
test('rechecks full financial intent history after evidence',()=>{
 const f=fixture();f.finalIntents[0]!.reservedMicros='0';deny(f,'financial_history_changed_or_missing');
});
test('HTTP 201 alone and empty history never certify UNKNOWN terminality',()=>{
 const f=fixture();f.snapshot.orders=[];f.snapshot.fills=[];f.snapshot.settlements=[];
 deny(f,'unknown_order_absence_is_not_terminal_proof');
});
const evidenceCases:Array<[string,(f:Fixture)=>void]>=[
 ['incomplete archive',f=>{f.historicalCoverageComplete=false;}],
 ['unauthenticated evidence',f=>{f.snapshot.authenticated=false;}],
 ['incomplete snapshot',f=>{f.snapshot.complete=false;}],
 ['approximate cash',f=>{f.snapshot.cashExact=false;}],
 ['unexplained cash',f=>{f.snapshot.unexplainedCashActivity=true;}],
 ['different signing key',f=>{f.snapshot.identity.keyFingerprint='a'.repeat(64);}],
 ['pre-kill evidence',f=>{f.snapshot.observedAtMs=now-2001;}],
 ['future evidence',f=>{f.snapshot.observedAtMs=now+1;}],
 ['expired evidence',f=>{f.nowMs=now+15000;}],
 ['history coverage gap',f=>{f.snapshot.historyFromMs=now-99999;}],
 ['open position',f=>{f.snapshot.positions.push({market:'SYNTHETIC-BTC',side:'NO',quantityHundredths:'300'});}],
 ['open order',f=>{f.snapshot.orders[0]!.terminal=false;}],
 ['different acknowledged order ID',f=>{f.snapshot.orders[0]!.orderId='wrong-order';}],
 ['different order request',f=>{f.snapshot.orders[0]!.request.limitMicros=420000;}],
 ['duplicate order',f=>{f.snapshot.orders.push(structuredClone(f.snapshot.orders[0]!));}],
 ['duplicate fill',f=>{f.snapshot.fills.push(structuredClone(f.snapshot.fills[0]!));}],
 ['missing fill',f=>{f.snapshot.fills=[];}],
 ['fractional hidden overfill',f=>{f.snapshot.orders[0]!.filledHundredths='301';}],
 ['future fill',f=>{f.snapshot.fills[0]!.occurredAtMs=now;}],
 ['wrong fill side',f=>{f.snapshot.fills[0]!.side='YES';}],
 ['wrong fill gross',f=>{f.snapshot.fills[0]!.grossMicros='1230001';}],
 ['negative fee',f=>{f.snapshot.fills[0]!.feeMicros='-1';}],
 ['fill worse than limit',f=>{f.snapshot.fills[0]!.priceMicros=440000;f.snapshot.fills[0]!.grossMicros='1320000';}],
 ['duplicate settlement',f=>{f.snapshot.settlements.push(structuredClone(f.snapshot.settlements[0]!));}],
 ['wrong losing payout',f=>{f.snapshot.settlements[0]!.payoutMicros='3000000';}],
 ['future settlement',f=>{f.snapshot.settlements[0]!.occurredAtMs=now;}],
];
for(const [name,change] of evidenceCases)test(`rejects ${name}`,()=>{const f=fixture();change(f);deny(f);});
test('terminal zero-fill cancellation can be planned only with explicit exact terminal order evidence',()=>{
 const f=fixture();f.snapshot.orders[0]!.filledHundredths='0';f.snapshot.fills=[];f.snapshot.settlements=[];
 f.snapshot.cashMicros='25000000';assert.equal(planOwnerUnknownReconciliation(f).ok,true);
 f.snapshot.orders=[];deny(f,'unknown_order_absence_is_not_terminal_proof');
});
test('changed stale cash is not falsely rejected before exact ledger accounting',()=>{
 const f=fixture();assert.notEqual(f.heldBefore.cashMicros,f.snapshot.cashMicros);
 const r=planOwnerUnknownReconciliation(f);assert.equal(r.ok,true);assert.equal(r.accountingCommitted,false);
});
test('untrusted or malformed runtime input fails closed',()=>{
 for(const x of [undefined,null,[],{},'201',NaN,{...fixture(),nowMs:Number.MAX_SAFE_INTEGER},
  {...fixture(),historicalCoverageComplete:undefined},{...fixture(),heldAfter:undefined}]){
  assert.equal(planOwnerUnknownReconciliation(x).ok,false);
 }
 const cyclic=fixture() as unknown as Record<string,unknown>;cyclic.heldBefore=cyclic;
 assert.equal(planOwnerUnknownReconciliation(cyclic).ok,false);
});
test('candidate contains no runtime DB, signer, transport, scheduler or write imports',()=>{
 const code=readFileSync('src/lib/strata/ownerUnknownRecoveryPlan.ts','utf8');
 assert.deepEqual([...code.matchAll(/^import .* from (.*);$/gm)].map(m=>m[1]),["'node:crypto'"]);
 assert.doesNotMatch(code,/\b(fetch|readOwnedKalshiFeeds|loadedMaterial|ProductionLedger|pool)\s*\(/);
});
