import test from 'node:test';
import assert from 'node:assert/strict';
import {FeeAuthorityTimingCapture,beginFeeAuthorityTiming,withFeeAuthorityTimingPurpose,withoutFeeAuthorityTiming,isFeeAuthorityTiming,type FeeAuthorityTiming} from './feeAuthorityTiming';
const row=(capture:FeeAuthorityTimingCapture,purpose='WIRE_FEE',operation='fee_review_query')=>capture.snapshot()!.stages.find(r=>r.purpose===purpose&&r.operation===operation)!;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};

test('run and purpose return exact original value and promise; rejected promise/error identities are untouched',async()=>{
 const capture=new FeeAuthorityTimingCapture();const promise=Promise.resolve(7),object={value:1};
 assert.equal(capture.run(()=>object),object);assert.equal(capture.run(()=>promise),promise);
 assert.equal(capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',()=>promise)),promise);
 assert.equal(withFeeAuthorityTimingPurpose('WIRE_FEE',()=>promise),promise);
 const error=Error('original');assert.throws(()=>capture.run(()=>{throw error;}),e=>e===error);
 assert.throws(()=>capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',()=>{throw error;})),e=>e===error);
 const rejected=Promise.reject(error);assert.equal(capture.run(()=>rejected),rejected);await assert.rejects(rejected,e=>e===error);
});

test('inline timers preserve attempted/completed/rejected/active and measure monotonic client elapsed',()=>{
 let now=5;const capture=new FeeAuthorityTimingCapture(()=>now);
 capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',()=>{
  const done=beginFeeAuthorityTiming('fee_review_query');assert.equal(row(capture).active,1);now=12;done('rejected');done('fulfilled');
 }));
 assert.deepEqual(row(capture),{purpose:'WIRE_FEE',operation:'fee_review_query',attempted:1,completed:1,rejected:1,active:0,elapsedMs:7,capped:false});
 assert.equal(row(capture,'WIRE_FEE','standing_eligibility_query').attempted,0);
 assert.equal(row(capture,'WIRE_FEE','standing_eligibility_query').elapsedMs,0);
});

test('inactive markers sample no clocks and unknown inherited labels never allocate stages',()=>{
 let clocks=0;const capture=new FeeAuthorityTimingCapture(()=>{clocks++;throw Error('clock');});
 beginFeeAuthorityTiming('fee_review_query')('fulfilled');
 for(const value of ['constructor','toString','__proto__','secret=private',{},null]){
  capture.begin('WIRE_FEE',value as never)('fulfilled');capture.begin(value as never,'fee_review_query')('fulfilled');
  capture.run(()=>withFeeAuthorityTimingPurpose(value as never,()=>beginFeeAuthorityTiming('fee_review_query')('fulfilled')));
 }
 assert.equal(clocks,0);assert.equal(capture.snapshot()!.stages.length,12);assert.ok(capture.snapshot()!.stages.every(r=>r.attempted===0));
});

test('clock exceptions, invalid values, backward time and implausible durations produce null only',()=>{
 for(const times of [[NaN,1],[0,Infinity],[-1,0],[5,4],[0,3_600_001]]){
  let i=0;const capture=new FeeAuthorityTimingCapture(()=>times[i++]!);const done=capture.begin('WIRE_FEE','fee_review_query');done('fulfilled');assert.equal(row(capture).elapsedMs,null);assert.equal(row(capture).completed,1);
 }
 const capture=new FeeAuthorityTimingCapture(()=>{throw Error('unavailable');});assert.doesNotThrow(()=>capture.begin('WIRE_FEE','fee_review_query')('rejected'));assert.equal(row(capture).elapsedMs,null);
});

test('parallel dispatch scopes and nested purposes are isolated after awaits',async()=>{
 let now=0;const a=new FeeAuthorityTimingCapture(()=>++now),b=new FeeAuthorityTimingCapture(()=>++now),gate=deferred();
 const first=a.run(()=>withFeeAuthorityTimingPurpose('FINAL_MARKET',async()=>{
  const outer=beginFeeAuthorityTiming('fee_public_probe');await gate.promise;
  await withFeeAuthorityTimingPurpose('WIRE_FEE',async()=>{const inner=beginFeeAuthorityTiming('fee_review_query');await Promise.resolve();inner('rejected');});
  const again=beginFeeAuthorityTiming('fee_public_probe');again('fulfilled');outer('fulfilled');
 }));
 const second=b.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',async()=>{const done=beginFeeAuthorityTiming('fee_public_probe');await Promise.resolve();done('fulfilled');gate.resolve();}));
 await Promise.all([first,second]);assert.equal(row(a,'FINAL_MARKET','fee_public_probe').attempted,2);assert.equal(row(a).rejected,1);assert.equal(row(b,'WIRE_FEE','fee_public_probe').attempted,1);assert.equal(row(b).attempted,0);
});

test('nested capture restores parent scope and retains exact promise identity',async()=>{
 const a=new FeeAuthorityTimingCapture(()=>1),b=new FeeAuthorityTimingCapture(()=>2);
 await a.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',async()=>{
  await b.run(()=>withFeeAuthorityTimingPurpose('FINAL_MARKET',async()=>{beginFeeAuthorityTiming('fee_review_query')('fulfilled');}));
  beginFeeAuthorityTiming('fee_review_query')('fulfilled');
 }));assert.equal(row(a).attempted,1);assert.equal(row(b,'FINAL_MARKET').attempted,1);assert.equal(row(b).attempted,0);
});

test('bounded counts, active lifetime and immutable branded serialized envelope',()=>{
 let now=0;const capture=new FeeAuthorityTimingCapture(()=>now);const done=[];
 for(let i=0;i<10000;i++)done.push(capture.begin('WIRE_FEE','fee_review_query'));
 let snapshot=capture.snapshot()!;assert.equal(row(capture).attempted,20);assert.equal(row(capture).active,20);assert.equal(row(capture).capped,true);
 now=3_600_000;for(const finish of done)finish('fulfilled');
 const final=capture.snapshot()!;assert.equal(row(capture).active,0);assert.equal(row(capture).completed,20);assert.equal(row(capture).elapsedMs,null);
 assert.equal(snapshot.stages.find(r=>r.purpose==='WIRE_FEE'&&r.operation==='fee_review_query')!.active,20,'old snapshots stay immutable');
 assert.ok(isFeeAuthorityTiming(final));assert.equal(isFeeAuthorityTiming(JSON.parse(JSON.stringify(final))),false);assert.equal(isFeeAuthorityTiming({version:1}),false);
 assert.ok(Object.isFrozen(final)&&Object.isFrozen(final.stages)&&final.stages.every(Object.isFrozen));assert.ok(Buffer.byteLength(JSON.stringify(final))<=4096);assert.equal(final.stages.length,12);
});

test('no observer hook or thenable assimilation is performed by scope entry',()=>{
 let accessed=0;const thenable={get then(){accessed++;throw Error('then_not_for_diagnostics');}};const capture=new FeeAuthorityTimingCapture();
 assert.equal(capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',()=>thenable)),thenable);assert.equal(accessed,0);
 assert.equal('observe' in capture,false);assert.equal('observer' in capture,false);
});


test('explicit inactive nested scope excludes synchronous and awaited descendants without changing the parent',async()=>{
 let clocks=0;const capture=new FeeAuthorityTimingCapture(()=>++clocks),gate=deferred();
 await capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',async()=>{
  const first=beginFeeAuthorityTiming('fee_review_query');first('fulfilled');
  const nested=withoutFeeAuthorityTiming(async()=>{
   beginFeeAuthorityTiming('fee_review_query')('fulfilled');await gate.promise;
   beginFeeAuthorityTiming('fee_public_probe')('rejected');
   await withFeeAuthorityTimingPurpose('FINAL_MARKET',async()=>{beginFeeAuthorityTiming('fee_review_query')('fulfilled');});
  });
  beginFeeAuthorityTiming('standing_history_query')('fulfilled');gate.resolve();await nested;
  beginFeeAuthorityTiming('fee_review_query')('fulfilled');
 }));
 assert.equal(clocks,6);assert.equal(row(capture).attempted,2);assert.equal(row(capture,'WIRE_FEE','standing_history_query').attempted,1);
 assert.equal(row(capture,'WIRE_FEE','fee_public_probe').attempted,0);assert.equal(row(capture,'FINAL_MARKET').attempted,0);
});

test('inactive scope preserves exact promise/value/error identity both alone and nested',async()=>{
 const capture=new FeeAuthorityTimingCapture(),value={fixture:true},promise=Promise.resolve(value),error=Error('original inactive');
 for(const invoke of [<T>(f:()=>T)=>f(),<T>(f:()=>T)=>capture.run(f)]){
  assert.equal(invoke(()=>withoutFeeAuthorityTiming(()=>value)),value);
  assert.equal(invoke(()=>withoutFeeAuthorityTiming(()=>promise)),promise);
  assert.throws(()=>invoke(()=>withoutFeeAuthorityTiming(()=>{throw error;})),e=>e===error);
  const rejected=Promise.reject(error);assert.equal(invoke(()=>withoutFeeAuthorityTiming(()=>rejected)),rejected);await assert.rejects(rejected,e=>e===error);
 }
});

// Pool attribution is optional numeric metadata on the existing dispatch envelope.
import {installPoolCheckoutTiming} from '@workspace/db/pool-checkout-timing';
import {withFinalFeePoolCheckout} from './feeAuthorityTiming';
test('pool attribution is FINAL-only, operation-specific, restores nested scopes and excludes inactive descendants',async()=>{
 const fake={connect(cb:(e:null,c:object,r:()=>void)=>void){cb(null,{},()=>{});return undefined;}};
 installPoolCheckoutTiming(fake as never);
 const checkout=()=>fake.connect(()=>{}),capture=new FeeAuthorityTimingCapture();
 await capture.run(async()=>{
  withFinalFeePoolCheckout('fee_review_query',checkout);
  withFeeAuthorityTimingPurpose('WIRE_FEE',()=>withFinalFeePoolCheckout('fee_review_query',checkout));
  withoutFeeAuthorityTiming(()=>withFinalFeePoolCheckout('fee_review_query',checkout));
  withFinalFeePoolCheckout('fee_standing_renewal_query',()=>{
   withFinalFeePoolCheckout('fee_review_query',checkout);checkout();
  });
  const later=withFinalFeePoolCheckout('fee_review_query',()=>Promise.resolve().then(checkout));await later;
 });
 assert.equal(row(capture,'FINAL_MARKET','fee_review_query').poolCheckout!.attempted,2);
 assert.equal(row(capture,'FINAL_MARKET','fee_standing_renewal_query').poolCheckout!.attempted,1);
 assert.equal(row(capture,'WIRE_FEE','fee_review_query').poolCheckout,undefined);
});
test('pool timing fixed operation allowlist prevents unbounded metadata and preserves exact dispatch result',()=>{
 const c=new FeeAuthorityTimingCapture(()=>{throw Error('clock should not run');}),value={};
 for(const key of ['secret','constructor','__proto__',{},null])assert.equal(c.run(()=>withFinalFeePoolCheckout(key as never,()=>value)),value);
 assert.ok(c.snapshot()!.stages.every(s=>s.poolCheckout===undefined));
});
test('worst bounded existing stages plus both pool groups fit original4096-byte envelope',()=>{
 let now=0;const c=new FeeAuthorityTimingCapture(()=>now);
 const fake={connect(cb:(e:null)=>void){now+=100000.123;cb(null);}};installPoolCheckoutTiming(fake as never);
 const operations=['standing_history_query','standing_eligibility_query','final_account_fence_query','fee_public_probe','fee_review_query','fee_standing_renewal_query'] as const;
 for(const purpose of ['FINAL_MARKET','WIRE_FEE'] as const)for(const op of operations)for(let i=0;i<21;i++){
  const done=c.begin(purpose,op);now+=100000.123;done('rejected');
 }
 c.run(()=>{for(const op of ['fee_review_query','fee_standing_renewal_query'] as const)for(let i=0;i<21;i++)withFinalFeePoolCheckout(op,()=>fake.connect(()=>{}));});
 const snapshot=c.snapshot();assert.ok(snapshot);assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=4096);
 for(const op of ['fee_review_query','fee_standing_renewal_query']){const group=row(c,'FINAL_MARKET',op).poolCheckout!;assert.equal(group.attempted,20);assert.equal(group.capped,true);assert.ok(Object.isFrozen(group));}
});

test('open parent checkout scope cannot attribute nested WIRE, invalid or explicitly inactive work',()=>{
 const c=new FeeAuthorityTimingCapture(),fake={connect(cb:()=>void){cb();}};installPoolCheckoutTiming(fake as never);
 const checkout=()=>fake.connect(()=>{});
 c.run(()=>withFinalFeePoolCheckout('fee_review_query',()=>{
  withoutFeeAuthorityTiming(()=>withFinalFeePoolCheckout('fee_review_query',checkout));
  withFeeAuthorityTimingPurpose('WIRE_FEE',()=>withFinalFeePoolCheckout('fee_review_query',checkout));
  withFeeAuthorityTimingPurpose('invalid' as never,checkout);
  withFinalFeePoolCheckout('invalid' as never,checkout);
  checkout();
 }));
 assert.equal(row(c,'FINAL_MARKET','fee_review_query').poolCheckout!.attempted,1);
});
