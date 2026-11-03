import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {digest} from '../v13-production/types';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {inspectOwnerSignedExchangeReleaseProof} from './ownerSignedExchangeReleaseProof';
import {recoverPreparedOwnedExitIntents} from './preparedProtectiveExitRecovery';

const owner='11111111-1111-4111-8111-111111111111',accountId='synthetic-exit-diagnostic';
const at=Date.parse('2026-10-25T12:00:00Z');
type Row=Record<string,any>;
function fixture(markerPresent=false,fractional=false){
 const parent:Row={id:'synthetic-parent',account_id:accountId,kind:'ENTRY',state:'TERMINAL',terminal:true,
  client_order_id:'v13p-synthetic-parent',exchange_order_id:'synthetic-provider-order',filled_hundredths:'300',reserved_micros:'0',
  market:'KXBTC15M-SYNTHETIC',side:'YES',request:{clientOrderId:'v13p-synthetic-parent',market:'KXBTC15M-SYNTHETIC',side:'YES',
   action:'BUY',reduceOnly:false,timeInForce:'IOC',contracts:3,limitMicros:500000}};
 const exit:Row={id:'synthetic-exit',account_id:accountId,kind:'EXIT',state:'BLOCKED',terminal:true,parent_id:parent.id,
  client_order_id:'v13p-synthetic-exit',exchange_order_id:null,dispatch_at:null,cancel_attempted:false,
  filled_hundredths:'0',reserved_micros:'0',exit_fee_micros:'0',market:parent.market,side:'YES',policy_hash:'synthetic-policy',fee_fingerprint:'synthetic-fee',
  request:{clientOrderId:'v13p-synthetic-exit',market:parent.market,side:'YES',action:'SELL',reduceOnly:true,timeInForce:'IOC',limitMicros:500000,
   ...(fractional?{quantityVersion:'EXIT_HUNDREDTHS_V1',quantityHundredths:'150'}:{contracts:3})},
  decision:{ownedEvaluation:{source:{evaluated_at:new Date(at-10000).toISOString()}},policy:{maxQuoteAgeMs:5000}}};
 const payload={id:exit.id,reason:'production_prepared_exit_expired',reservationId:markerPresent?'synthetic-reservation':null,
  sourceAtMs:at-10000,maxQuoteAgeMs:5000,evidenceObservedAtMs:at-1000,ownedQuantityHundredths:'300'};
 const receipt:Row={id:'synthetic-receipt',account_id:accountId,kind:'PROVEN_NOT_POSTED',payload,digest:digest(payload)};
 const raw=JSON.stringify({ticker:exit.market,side:'ask',count:fractional?'1.50':'3.00',price:'0.5000',client_order_id:exit.client_order_id,
  time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2});
 const marker:Row={reservation_id:'synthetic-reservation',owner_user_id:owner,execution_account_id:accountId,client_order_id:exit.client_order_id,
  state:'VOID',trading_authorized:false,market_ticker:exit.market,reducing_side:'YES',quantity_hundredths:fractional?'150':'300',
  order_request_json:raw,order_digest:createHash('sha256').update(raw).digest('hex'),row_revision:'1'};
 const f={rows:[parent,exit],observations:[receipt],markers:markerPresent?[marker]:[] as Row[],events:[] as Row[],parent,exit,receipt,marker,
  account:{id:accountId,commissioned:true,policy_state:'APPROVED',diagnostic_held:true,hold_revision:{account:'1'},blocked_reason:null,
   cash_micros:'25000000',reserved_micros:'0',key_fingerprint:'synthetic-fingerprint'},
  refresh(){exit.capability_digest=digest({id:exit.id,request:exit.request,decision:exit.decision,policyHash:exit.policy_hash,fee:exit.fee_fingerprint});receipt.digest=digest(receipt.payload);}};
 f.refresh();return f;
}
function db(f:ReturnType<typeof fixture>){return {async query(sql:string,args?:unknown[]){
 assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|CALL|TRUNCATE|FOR SHARE)\b/i);
 if(sql.includes('v13_production_account')){assert.deepEqual(args,[owner]);return {rows:[f.account]};}
 if(sql.includes('FROM public.v13_production_intent')){assert.deepEqual(args,[accountId]);return {rows:f.rows};}
 if(sql.includes('FROM public.v13_production_observation')){assert.equal(args?.[0],accountId);return {rows:f.observations};}
 if(sql.includes('FROM public.v13_production_event'))return {rows:f.events};
 if(sql.includes('FROM private.strata_emergency_exit_reservations'))return {rows:f.markers};
 throw Error('unexpected synthetic query');
 }};}
const history=(f:ReturnType<typeof fixture>,opt=true)=>readNeverPostedReleaseHistory(db(f),accountId,false,opt?{expiredExitOwnerId:owner}:undefined);

for(const marker of [false,true])for(const fractional of [false,true])test(`excludes proven expired exit: marker=${marker}, fractional=${fractional}`,async()=>{
 const f=fixture(marker,fractional),r=await history(f);
 assert.equal(r.requests.length,2);assert.equal(r.expectedRequests.length,1);assert.equal(r.expectedRequests[0].clientOrderId,f.parent.client_order_id);
 assert.deepEqual(r.neverPosted.map(x=>x.clientOrderId),[f.exit.client_order_id]);
});
test('default shared-helper behavior retains exits for renewal callers',async()=>{
 const f=fixture();f.observations=[];
 const r=await history(f,false);assert.equal(r.expectedRequests.length,2);assert.equal(r.neverPosted.length,0);
});
const invalid:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
 ['missing receipt',f=>{f.observations=[];}],['duplicate receipt',f=>{f.observations.push({...f.receipt});}],
 ['POST_ATTEMPT contradiction',f=>{f.observations.push({...f.receipt,kind:'POST_ATTEMPT'});}],
 ['POST_UNCERTAIN contradiction',f=>{f.observations.push({...f.receipt,kind:'POST_UNCERTAIN'});}],
 ['CANCEL_ATTEMPT contradiction',f=>{f.observations.push({...f.receipt,kind:'CANCEL_ATTEMPT'});}],
 ['financial event',f=>{f.events=[{present:1}];}],['foreign receipt',f=>{f.receipt.account_id='foreign';}],
 ['wrong receipt intent',f=>{f.receipt.payload.id='foreign';f.refresh();}],['bad receipt digest',f=>{f.receipt.digest='bad';}],
 ['bad capability digest',f=>{f.exit.capability_digest='bad';}],['wrong reason',f=>{f.receipt.payload.reason='unverified';f.refresh();}],
 ['dispatch recorded',f=>{f.exit.dispatch_at=new Date(at);}],['exchange order recorded',f=>{f.exit.exchange_order_id='provider';}],
 ['fill recorded',f=>{f.exit.filled_hundredths='1';}],['reserved cash',f=>{f.exit.reserved_micros='1';}],
 ['reserved fee',f=>{f.exit.exit_fee_micros='1';}],['cancel attempted',f=>{f.exit.cancel_attempted=true;}],
 ['not terminal',f=>{f.exit.terminal=false;}],['foreign account',f=>{f.exit.account_id='foreign';}],
 ['wrong client ID',f=>{f.exit.client_order_id='foreign';}],['wrong request market',f=>{f.exit.request.market='KXBTC15M-OTHER';f.refresh();}],
 ['non-reducing',f=>{f.exit.request.reduceOnly=false;f.refresh();}],['BUY exit',f=>{f.exit.request.action='BUY';f.refresh();}],
 ['non IOC',f=>{f.exit.request.timeInForce='GTC';f.refresh();}],['ambiguous quantity',f=>{f.exit.request.quantityHundredths='100';f.refresh();}],
 ['invalid price',f=>{f.exit.request.limitMicros=0;f.refresh();}],['missing parent',f=>{f.rows=[f.exit];}],
 ['foreign parent',f=>{f.parent.account_id='foreign';}],['parent without fills',f=>{f.parent.filled_hundredths='0';}],
 ['wrong parent market',f=>{f.parent.market='KXBTC15M-OTHER';}],['quantity exceeds parent',f=>{f.exit.request.contracts=4;f.refresh();}],
 ['source mismatch',f=>{f.receipt.payload.sourceAtMs--;f.refresh();}],['not expired',f=>{f.receipt.payload.evidenceObservedAtMs=at-5000;f.refresh();}],
 ['TTL mismatch',f=>{f.receipt.payload.maxQuoteAgeMs=4000;f.refresh();}],['unbounded TTL',f=>{f.exit.decision.policy.maxQuoteAgeMs=16000;f.refresh();}],
 ['zero owned quantity',f=>{f.receipt.payload.ownedQuantityHundredths='0';f.refresh();}],
 ['owned quantity exceeds parent',f=>{f.receipt.payload.ownedQuantityHundredths='400';f.refresh();}],
 ['absent marker',f=>{f.markers=[];}],['duplicate marker',f=>{f.markers.push({...f.marker});}],
 ['wrong marker owner',f=>{f.marker.owner_user_id='foreign';}],['wrong marker account',f=>{f.marker.execution_account_id='foreign';}],
 ['dispatched marker',f=>{f.marker.state='DISPATCHED';}],['marker authority',f=>{f.marker.trading_authorized=true;}],
 ['marker digest',f=>{f.marker.order_digest='bad';}],['marker request',f=>{const r=JSON.parse(f.marker.order_request_json);r.subaccount=0;f.marker.order_request_json=JSON.stringify(r);f.marker.order_digest=createHash('sha256').update(f.marker.order_request_json).digest('hex');}],
 ['marker missing from receipt',f=>{f.receipt.payload.reservationId=null;f.refresh();}],
];
for(const [name,mutate] of invalid)test(`fails closed: ${name}`,async()=>{const f=fixture(true);mutate(f);await assert.rejects(history(f));});

test('existing whole-contract blocked ENTRY exclusion remains unchanged',async()=>{
 const f=fixture();const i=f.exit;i.kind='ENTRY';i.parent_id=null;i.request.action='BUY';i.request.reduceOnly=false;
 f.receipt.payload={id:i.id,reason:'production_final_source_changed_or_expired'};f.refresh();
 for(const opt of [false,true]){const r=await history(f,opt);assert.equal(r.expectedRequests.length,1);assert.equal(r.neverPosted.length,1);}
 f.observations=[];await assert.rejects(history(f,false));await assert.rejects(history(f,true));
});

async function diagnostic(f:ReturnType<typeof fixture>,options:{contradiction?:boolean,incomplete?:boolean,openPosition?:boolean,openOrder?:boolean,afterRead?:()=>void}={}){
 const providerOrder=(i:Row)=>({order_id:i===f.parent?'synthetic-provider-order':'contradicting-exit',client_order_id:i.client_order_id,ticker:i.market,
  book_side:i===f.parent?'bid':'ask',action:i.request.action.toLowerCase(),status:options.openOrder?'resting':i===f.parent?'executed':'canceled',initial_count_fp:'3.00',fill_count_fp:i===f.parent?'3.00':'0.00',yes_price_dollars:'0.5000'});
 return inspectOwnerSignedExchangeReleaseProof(owner,{db:db(f),now:()=>at,material:async()=>({keyId:'synthetic',privateKey:'unused'}),
  read:async()=>{options.afterRead?.();return {ok:true,observedAtMs:at,cashMicros:'25000000',historicalCoverageComplete:!options.incomplete,
   orders:[providerOrder(f.parent),...(options.contradiction?[providerOrder(f.exit)]:[])],
   fills:[{order_id:'synthetic-provider-order',trade_id:'synthetic-fill',ticker:f.parent.market,count_fp:'3.00',yes_price_dollars:'0.5000',fee_cost:'0.0500',created_time:new Date(at-20000).toISOString()}],
   positions:options.openPosition?[{ticker:f.parent.market,position_fp:'1.00'}]:[],settlements:options.openPosition||options.openOrder?[]:[{ticker:f.parent.market,yes_count_fp:'3.00',no_count_fp:'0.00',market_result:'yes',revenue:300,settled_time:new Date(at-500).toISOString()}]};},
  feeProbe:async()=>({ok:true}),v4:async()=>({ok:true,checks:{protectiveExitRelease:false,ownerShaApproval:false}})} as never);
}
test('actual diagnostic and mapper exclude no-send exits without granting authority',async()=>{
 const r=await diagnostic(fixture());assert.equal(r.ok,true,JSON.stringify(r));if(!r.ok)return;
 assert.equal(r.authenticatedExchangeFlat,true);assert.equal(r.ordersSubmitted,false);assert.equal(r.recordPersisted,false);
 assert.equal(r.tradingAuthorized,false);assert.equal(r.liveEligible,false);
});
test('signed provider order contradicting receipt stays blocked',async()=>{
 const r=await diagnostic(fixture(),{contradiction:true});assert.equal(r.ok,true,JSON.stringify(r));if(!r.ok)return;
 assert.equal(r.authenticatedExchangeFlat,false);assert.ok(r.blockedReasons.includes('proven_never_posted_provider_record_conflict'));
});
test('incomplete archive history stays blocked',async()=>{
 const r=await diagnostic(fixture(),{incomplete:true});assert.equal(r.ok,true,JSON.stringify(r));if(!r.ok)return;
 assert.equal(r.authenticatedExchangeFlat,false);assert.ok(r.blockedReasons.includes('authenticated_exchange_history_incomplete'));
});
test('receipt and reservation changes after signed read fail final history fence',async()=>{
 for(const markerChange of [false,true]){const f=fixture(true);const r=await diagnostic(f,{afterRead:()=>{
  if(markerChange)f.marker.row_revision='2';else f.receipt.row_revision='2';
 }});assert.equal(r.ok,false);assert.equal(r.reason,'financial_history_changed_during_signed_diagnostic');}
});
test('no-send exclusion cannot hide current positions or nonterminal provider orders',async()=>{
 for(const options of [{openPosition:true},{openOrder:true}]){const r=await diagnostic(fixture(),options);
  assert.equal(r.ok,true,JSON.stringify(r));if(!r.ok)continue;
  assert.equal(r.authenticatedExchangeFlat,false);assert.ok(r.blockedReasons.includes('authenticated_exchange_not_flat'));
 }
});
test('remaining unobserved legitimate ledger request still fails order-count check',async()=>{
 const f=fixture();f.rows.push({...f.parent,id:'synthetic-other',client_order_id:'v13p-synthetic-other',request:{...f.parent.request,clientOrderId:'v13p-synthetic-other'}});
 const r=await diagnostic(f);assert.equal(r.ok,true,JSON.stringify(r));if(!r.ok)return;
 assert.equal(r.authenticatedExchangeFlat,false);assert.ok(r.blockedReasons.includes('exchange_and_ledger_history_incomplete'));
});
test('NO exit marker binds complementary provider price',async()=>{
 const f=fixture(true);f.parent.side=f.parent.request.side=f.exit.side=f.exit.request.side='NO';
 f.exit.request.limitMicros=420000;f.marker.reducing_side='NO';
 const raw=JSON.parse(f.marker.order_request_json);raw.side='bid';raw.price='0.5800';
 f.marker.order_request_json=JSON.stringify(raw);f.marker.order_digest=createHash('sha256').update(f.marker.order_request_json).digest('hex');f.refresh();
 assert.equal((await history(f)).neverPosted.length,1);
});

// The production recovery function runs against an in-memory transaction port.
// Its only allowed write is the synthetic PREPARED -> VOID marker transition.
// No connection, provider transport, production data or control is involved.
function recoveryFixture(markerPresent:boolean,fractional=false){
 const f=fixture(markerPresent,fractional);
 f.exit.state='PREPARED';f.exit.terminal=false;f.observations=[];
 if(markerPresent)f.marker.state='PREPARED';
 const position={market:f.exit.market,side:f.exit.side,quantity_hundredths:fractional?'100':'200',basis_micros:'1000000'};
 const snapshot={authenticated:true,complete:true,cashExact:true,unexplainedCashActivity:false,observedAtMs:at-1000};
 let updates=0,raced=false;
 const tx={async query(sql:string,args:unknown[]){
  if(sql.startsWith('SELECT * FROM v13_production_position')){assert.deepEqual(args,[f.parent.id,accountId]);return {rows:[position]};}
  if(sql.startsWith('SELECT * FROM private.strata_emergency_exit_reservations')){assert.deepEqual(args,[f.exit.client_order_id]);return {rows:f.markers};}
  if(sql.startsWith('UPDATE private.strata_emergency_exit_reservations')){
   assert.deepEqual(args,[f.marker.reservation_id]);assert.equal(f.marker.state,'PREPARED');updates++;
   if(raced)return {rows:[]};f.marker.state='VOID';f.marker.row_revision='2';return {rows:[{reservation_id:f.marker.reservation_id}]};
  }
  throw Error('unexpected recovery query');
 }};
 const run=()=>recoverPreparedOwnedExitIntents(tx as never,{
  ownerId:owner,account:{...f.account,owner_user_id:owner} as never,intents:f.rows as never,snapshot:snapshot as never,
  observe:async(kind,payload)=>{const captured={id:'producer-receipt',account_id:accountId,kind,payload,digest:digest(payload)};
   f.observations.push(captured);Object.assign(f.receipt,captured);},
 });
 return {f,position,snapshot,run,stats:()=>({updates}),race:()=>{raced=true;}};
}
for(const marker of [false,true])for(const fractional of [false,true])test(`producer round trip after partial reduction: marker=${marker}, fractional=${fractional}`,async()=>{
 const p=recoveryFixture(marker,fractional);await p.run();
 assert.equal(p.f.exit.state,'BLOCKED');assert.equal(p.f.exit.terminal,true);
 assert.equal(p.f.observations.length,1);assert.equal(p.f.receipt.payload.ownedQuantityHundredths,fractional?'100':'200');
 assert.equal(p.stats().updates,marker?1:0);if(marker)assert.equal(p.f.marker.state,'VOID');
 const result=await history(p.f);assert.equal(result.neverPosted.length,1);assert.equal(result.expectedRequests.length,1);
 assert.equal(result.requests.length,2,'all requests still map provider contradictions');
 assert.equal((await history(p.f,false)).expectedRequests.length,2,'renewal behavior unchanged');
});
for(const [name,change] of [
 ['zero remaining position',(p:ReturnType<typeof recoveryFixture>)=>{p.position.quantity_hundredths='0';}],
 ['unauthenticated snapshot',(p:ReturnType<typeof recoveryFixture>)=>{p.snapshot.authenticated=false;}],
 ['incomplete snapshot',(p:ReturnType<typeof recoveryFixture>)=>{p.snapshot.complete=false;}],
 ['uncertain reservation',(p:ReturnType<typeof recoveryFixture>)=>{p.f.marker.state='UNKNOWN';}],
 ['foreign reservation',(p:ReturnType<typeof recoveryFixture>)=>{p.f.marker.owner_user_id='foreign';}],
 ['reservation transition race',(p:ReturnType<typeof recoveryFixture>)=>{p.race();}],
] as const)test(`producer emits no exclusion evidence: ${name}`,async()=>{
 const p=recoveryFixture(true);change(p);await assert.rejects(p.run());
 assert.equal(p.f.observations.length,0);assert.equal(p.f.exit.state,'PREPARED');
 assert.equal((await history(p.f)).neverPosted.length,0);
});
test('producer round trip keeps not-yet-expired intent expected',async()=>{
 const p=recoveryFixture(true);p.snapshot.observedAtMs=at-5000;await p.run();
 assert.equal(p.f.observations.length,0);assert.equal(p.stats().updates,0);
 assert.equal((await history(p.f)).expectedRequests.length,2);
});
for(const [name,change] of [
 ['missing receipt',(f:ReturnType<typeof fixture>)=>{f.observations=[];}],
 ['corrupt receipt',(f:ReturnType<typeof fixture>)=>{f.observations[0].digest='corrupt';}],
 ['contradictory send',(f:ReturnType<typeof fixture>)=>{f.observations.push({...f.observations[0],kind:'POST_UNCERTAIN'});}],
 ['marker no longer VOID',(f:ReturnType<typeof fixture>)=>{f.marker.state='UNKNOWN';}],
 ['rebound marker',(f:ReturnType<typeof fixture>)=>{f.marker.execution_account_id='foreign';}],
] as const)test(`producer receipt remains fail-closed after ${name}`,async()=>{
 const p=recoveryFixture(true);await p.run();change(p.f);await assert.rejects(history(p.f));
});
test('producer receipt still loses to contradictory signed provider evidence',async()=>{
 const p=recoveryFixture(true);await p.run();const result=await diagnostic(p.f,{contradiction:true});
 assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)return;
 assert.equal(result.authenticatedExchangeFlat,false);assert.ok(result.blockedReasons.includes('proven_never_posted_provider_record_conflict'));
 assert.equal(result.tradingAuthorized,false);assert.equal(result.ordersSubmitted,false);
});
