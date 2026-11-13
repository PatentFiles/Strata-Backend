import test from 'node:test';
import assert from 'node:assert/strict';
import {ForwardCycleDiagnostics,diagnosticWallNow} from './forwardCycleDiagnostics';
const timing={cycleObservedAtMs:100,feedsDecodedObservedAtMs:200,classifierStartedAtMs:220,classifierFinishedAtMs:221,commitReturnedAtMs:240};
const source={evaluationId:'00000000-0000-0000-0000-000000000001',evaluatedAtMs:101,btcProviderAtMs:150,btcReceivedAtMs:190,marketDecodedAtMs:195};
test('preserves actual local boundaries and legacy source clock without clamping',()=>{
 const events:Record<string,unknown>[]=[];
 const d=new ForwardCycleDiagnostics(e=>events.push(e),()=>0,cb=>cb());
 d.observe('paper',150,190);d.committed('paper',timing,source);
 assert.equal(events[0].legacyEvaluatedAtMs,101);assert.equal(events[0].btcReceivedAtMs,190);
 assert.equal(events[0].classifierStartedAtMs,220);assert.equal(events[0].commitReturnedAtMs,240);
 assert.equal(events[0].coverage,'SAMPLED_COMMITTED_CYCLES');assert.equal(events[0].evaluationId,source.evaluationId);
});
test('provider duplicate, regression and receive gaps counted separately without affecting inputs',()=>{
 let at=0;const events:Record<string,unknown>[]=[];const d=new ForwardCycleDiagnostics(e=>events.push(e),()=>at,cb=>cb());
 d.observe('paper',10,100);d.observe('paper',10,101);d.observe('paper',9,30200);d.committed('paper',timing,source);
 assert.equal(events[0].observations,3);assert.equal(events[0].duplicateProviderTimestamps,1);
 assert.equal(events[0].regressedProviderTimestamps,1);assert.equal(events[0].receiveGapsOver30Seconds,1);
 d.committed('paper',timing,source);assert.equal(events.length,1);at=30000;d.committed('paper',timing,source);assert.equal(events.length,2);
});
test('emission deferred and globally bounded to one queued event, observer errors isolated',()=>{
 let at=0;const callbacks:(()=>void)[]=[];let emits=0;
 const d=new ForwardCycleDiagnostics(()=>{emits++;throw Error('sink failed');},()=>at,cb=>{callbacks.push(cb);});
 d.observe('a',1,1);d.committed('a',timing,source);at=31000;d.committed('a',timing,source);
 assert.equal(emits,0);assert.equal(callbacks.length,1);assert.doesNotThrow(callbacks[0]);
 at=62000;d.committed('a',timing,source);assert.equal(callbacks.length,2);
});
test('untrusted extra fields are omitted, invalid observations and timing clocks isolated',()=>{
 const events:Record<string,unknown>[]=[];const d=new ForwardCycleDiagnostics(e=>events.push(e),()=>0,cb=>cb());
 d.observe('a',NaN,2);d.committed('a',timing,source);assert.equal(events.length,0);
 d.observe('a',1,2);d.committed('a',{...timing,secret:'secret'} as typeof timing,{...source,token:'token'} as typeof source);
 assert.equal(JSON.stringify(events).includes('secret'),false);assert.equal(JSON.stringify(events).includes('token'),false);
 for(const n of [NaN,Infinity,-1,1.2])assert.equal(diagnosticWallNow(()=>n),null);
 assert.equal(diagnosticWallNow(()=>{throw Error('clock');}),null);assert.equal(diagnosticWallNow(()=>123),123);
});
test('engine state capped at 32, scheduling and monotonic clock failures are non-authorizing',()=>{
 const events:Record<string,unknown>[]=[];const d=new ForwardCycleDiagnostics(e=>events.push(e),()=>0,cb=>cb());
 for(let i=0;i<33;i++)d.observe(String(i),1,1);
 d.committed('0',timing,source);assert.equal(events.length,0);d.committed('32',timing,source);assert.equal(events.length,1);
 for(const instance of [new ForwardCycleDiagnostics(()=>{},()=>{throw Error('clock');}),new ForwardCycleDiagnostics(()=>{},()=>0,()=>{throw Error('queue');})]){
 instance.observe('a',1,2);assert.doesNotThrow(()=>instance.committed('a',timing,source));
 }
});

test('regressed monotonic time cannot bypass rate limit; default emission is deferred',async()=>{
 let now=100;let count=0;const d=new ForwardCycleDiagnostics(()=>count++,()=>now);
 d.observe('paper',1,1);d.committed('paper',timing,source);assert.equal(count,0);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(count,1);
 now=0;d.committed('paper',timing,source);now=-1;d.committed('paper',timing,source);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(count,1);
});

test('sampled event includes only allowlisted transaction interval fields',()=>{
 const events:Record<string,unknown>[]=[];const d=new ForwardCycleDiagnostics(e=>events.push(e),()=>0,cb=>cb());
 d.observe('paper',1,2);
 const transactionPhases={complete:true,poolAndBeginMs:1,leaseLockMs:2,positionReadMs:3,windowPreparationMs:4,historyPreparationMs:5,classificationPreparationMs:6,strategyPersistenceMs:7,leaseRenewalMs:8,commitAndReleaseMs:9,secret:'not-logged'};
 d.committed('paper',{...timing,transactionPhases},source);
 assert.equal(events[0].schemaVersion,2);assert.equal(JSON.stringify(events).includes('not-logged'),false);
 assert.equal((events[0].transactionPhases as Record<string,unknown>).poolAndBeginMs,1);
});
