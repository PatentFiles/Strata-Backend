import test from 'node:test';
import assert from 'node:assert/strict';
import {CommittedPublicMetadataCoordinator,durablePrepareMetadataClock} from './committedPublicMetadata';
import {FinalPublicMetadataPhases} from './finalPublicMetadataPhases';
import {consumeDurablePhaseMetadata} from './durablePhaseMetadata';
const ticker='KXBTC15M-26NOV021145-00',event='KXBTC15M-26NOV021145',at=Date.parse('2026-11-02T21:00:00Z');
const scope={accountId:'account-a',ownerId:'owner-a',holderId:'holder-a',releaseSha:'a'.repeat(40),fence:'1',policyHash:'b'.repeat(64)};
const durable={owner:scope.ownerId,account:scope.accountId,sha:scope.releaseSha,policyHash:scope.policyHash};
const source={evaluationId:'evaluation-a',marketTicker:ticker,evaluatedAtMs:at-100,btcProviderAgeMs:100,btcReceiveAgeMs:0,marketAgeMs:0};
function fixture(){let wall=at,mono=0,allowed=true,calls=0;const provider=(async()=>{calls++;return Response.json({market:{ticker,event_ticker:event,exchange_index:2},series:{},event:{event_ticker:event},series_fee_change_arr:[],event_fee_changes:[],cursor:''});}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(provider,()=>wall,()=>mono);const p=new FinalPublicMetadataPhases(c,()=>scope,()=>allowed);
 return {c,p,clock:(w:number,m:number)=>{wall=w;mono=m;},stop:()=>{allowed=false;p.discardAll();},calls:()=>calls};}
const complete=async(cap:any)=>{await Promise.all([`/markets/${ticker}`,'/series/KXBTC15M','/series/fee_changes?series_ticker=KXBTC15M&show_historical=false',`/events/${event}`,`/events/fee_changes?event_ticker=${event}&limit=100`].map(path=>cap.read(path)));assert.equal(cap.capture().records.length,5);};
const context=()=>({intentId:'intent-a',invocation:Symbol('dispatch'),source});
test('distinct durable phase capability retains original clocks and cannot satisfy PREPARE, wrong phase, clone or second consumption',async()=>{
 const f=fixture(),ctx=context();await f.p.dispatch(ctx.intentId,ctx.invocation,async()=>{
 f.p.start('WIRE_FEE',ctx);const cap=f.p.consumeDurableWire('v13p-intent-a',ticker)!;
 assert.throws(()=>durablePrepareMetadataClock(cap,durable,ticker),/scope_invalid/);
 assert.throws(()=>consumeDurablePhaseMetadata({...cap},'WIRE_FEE',durable,ticker),/scope_invalid/);
 assert.throws(()=>consumeDurablePhaseMetadata(cap,'FINAL_MARKET',durable,ticker),/scope_invalid/);
 await complete(cap);const clock=consumeDurablePhaseMetadata(cap,'WIRE_FEE',durable,ticker);assert.equal(clock.sourceFresh(),true);assert.equal(clock.startedAtMs,at);
 assert.throws(()=>consumeDurablePhaseMetadata(cap,'WIRE_FEE',durable,ticker),/scope_invalid/);
 f.clock(at+1,4900);assert.equal(clock.sourceFresh(),false);
 });f.p.finish(ctx.intentId,ctx.invocation);
});
test('cross invocation, wrong intent and completed dispatch fail without replacement',async()=>{
 const f=fixture(),ctx=context();let cap:any;
 await f.p.dispatch(ctx.intentId,ctx.invocation,async()=>{
 f.p.start('WIRE_FEE',ctx);
 assert.throws(()=>f.p.consumeDurableWire('v13p-other',ticker),/intent_mismatch/);
 await f.p.dispatch(ctx.intentId,Symbol('other'),async()=>assert.throws(()=>f.p.consumeDurableWire('v13p-intent-a',ticker),/invocation_mismatch/));
 cap=f.p.consumeDurableWire('v13p-intent-a',ticker);
 });assert.throws(()=>consumeDurablePhaseMetadata(cap,'WIRE_FEE',durable,ticker),/scope_invalid/);f.p.finish(ctx.intentId,ctx.invocation);
});
test('stop and clock rollback invalidate fresh phase proof',async()=>{
 for(const mode of ['stop','wall','mono']){const f=fixture(),ctx=context();await f.p.dispatch(ctx.intentId,ctx.invocation,async()=>{
 f.p.start('WIRE_FEE',ctx);const cap=f.p.consumeDurableWire('v13p-intent-a',ticker)!;
 await complete(cap);const proof=consumeDurablePhaseMetadata(cap,'WIRE_FEE',durable,ticker);assert.equal(proof.sourceFresh(),true);
 if(mode==='stop')f.stop();if(mode==='wall')f.clock(at-1,0);if(mode==='mono')f.clock(at,-1);
 assert.equal(proof.sourceFresh(),false);
 });f.p.finish(ctx.intentId,ctx.invocation);}
});
