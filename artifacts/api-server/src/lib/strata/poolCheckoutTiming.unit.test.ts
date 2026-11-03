import assert from 'node:assert/strict';
import test from 'node:test';
import {PoolCheckoutTimingCapture,installPoolCheckoutTiming} from '../../../../../lib/db/src/poolCheckoutTiming';

test('inactive callback and direct Promise connect preserve return, this, arguments and no capture clock work',()=>{
 let clockCalls=0,seenThis:unknown,seenArgs:unknown[]=[];const token={};const callback=()=>{};
 const fake={connect:function(this:unknown,...args:unknown[]){seenThis=this;seenArgs=args;return token;},query:()=>{}};
 const originalQuery=fake.query;installPoolCheckoutTiming(fake as never);const first=fake.connect;installPoolCheckoutTiming(fake as never);assert.equal(first,fake.connect);assert.equal(fake.query,originalQuery);
 assert.equal(fake.connect(callback,'extra'),token);assert.equal(seenThis,fake);assert.deepEqual(seenArgs,[callback,'extra']);
 const c=new PoolCheckoutTimingCapture(()=>{clockCalls++;return 1;});assert.equal(c.run(()=>fake.connect()),token);assert.equal(clockCalls,0);assert.equal(c.snapshot().attempted,0);
});

test('callback preserves all arguments, callback this, return identity and release identity; timing completes once',()=>{
 let wrapped:Function|undefined;const connectReturn={};const fake={connect:function(this:unknown,cb:Function,extra:unknown){assert.equal(this,fake);assert.equal(extra,'extra');wrapped=cb;return connectReturn;}};
 installPoolCheckoutTiming(fake as never);const times=[10,25];const c=new PoolCheckoutTimingCapture(()=>times.shift()!);const release=()=>{},client={},context={},callbackReturn={};let calls=0;
 const callback=function(this:unknown,...args:unknown[]){calls++;assert.equal(this,context);assert.deepEqual(args,[null,client,release,'fourth']);return callbackReturn;};
 assert.equal(c.run(()=>fake.connect(callback,'extra')),connectReturn);assert.equal(c.snapshot().active,1);
 assert.equal(wrapped!.call(context,null,client,release,'fourth'),callbackReturn);assert.equal(wrapped!.call(context,null,client,release,'fourth'),callbackReturn);
 assert.equal(calls,2,'hook does not suppress original callbacks');assert.deepEqual(c.snapshot(),{attempted:1,completed:1,rejected:0,active:0,elapsedMs:15,capped:false});
});

test('original connect throw and callback throw retain exact error identity without double counting',()=>{
 const error=new Error('same-instance');const c=new PoolCheckoutTimingCapture(()=>1);const originalThrow={connect(_cb?:Function){throw error;}};installPoolCheckoutTiming(originalThrow as never);
 assert.throws(()=>c.run(()=>originalThrow.connect(()=>{})),e=>e===error);assert.deepEqual(c.snapshot(),{attempted:1,completed:1,rejected:1,active:0,elapsedMs:0,capped:false});
 const synchronous={connect(cb:Function){return cb(null,{},()=>{});}};installPoolCheckoutTiming(synchronous as never);const d=new PoolCheckoutTimingCapture(()=>1);
 assert.throws(()=>d.run(()=>synchronous.connect(()=>{throw error;})),e=>e===error);assert.equal(d.snapshot().completed,1);assert.equal(d.snapshot().rejected,0,'completed checkout must not be relabeled because user callback throws');
});

test('checkout error identity and release are forwarded unchanged even with throwing diagnostic clock',()=>{
 const error=new Error('driver-error'),release=()=>{};const fake={connect(cb:Function){return cb(error,undefined,release);}};installPoolCheckoutTiming(fake as never);
 const c=new PoolCheckoutTimingCapture(()=>{throw Error('clock');});let seen=false;
 c.run(()=>fake.connect((err:unknown,client:unknown,r:unknown)=>{seen=true;assert.equal(err,error);assert.equal(client,undefined);assert.equal(r,release);}));
 assert.equal(seen,true);assert.deepEqual(c.snapshot(),{attempted:1,completed:1,rejected:1,active:0,elapsedMs:null,capped:false});
});

test('closed synchronous dispatch scope excludes inherited async descendants and unrelated calls',async()=>{
 let clockCalls=0;const fake={connect(cb?:Function){return cb?.(null,{},()=>{});}};installPoolCheckoutTiming(fake as never);const c=new PoolCheckoutTimingCapture(()=>{clockCalls++;return 1;});
 await c.run(async()=>{fake.connect(()=>{});await Promise.resolve();fake.connect(()=>{});});fake.connect(()=>{});
 assert.equal(c.snapshot().attempted,1);assert.equal(clockCalls,2);
});

test('bounded20 capture does not suppress dispatches or release callbacks; invalid clock fails open as null',()=>{
 let dispatched=0,callbacks=0;const fake={connect(cb:Function){dispatched++;return cb(null,{},()=>{});}};installPoolCheckoutTiming(fake as never);const c=new PoolCheckoutTimingCapture(()=>1);
 c.run(()=>{for(let n=0;n<25;n++)fake.connect(()=>{callbacks++;});});
 assert.equal(dispatched,25);assert.equal(callbacks,25);assert.deepEqual(c.snapshot(),{attempted:20,completed:20,rejected:0,active:0,elapsedMs:0,capped:true});
 for(const values of [[2,1],[0,3600001],[NaN,1],[1,Infinity]]){const d=new PoolCheckoutTimingCapture(()=>values.shift()!);d.run(()=>fake.connect(()=>{}));assert.equal(d.snapshot().elapsedMs,null);}
});


test('snapshot serializes only bounded aggregate keys even at maximum cap and rejects cumulative overflow',()=>{
 const fake={connect(cb:Function){return cb(null,{},()=>{});}};installPoolCheckoutTiming(fake as never);let now=0;const c=new PoolCheckoutTimingCapture(()=>{now+=90000;return now;});
 c.run(()=>{for(let n=0;n<1000;n++)fake.connect(()=>{});});const value=c.snapshot();
 assert.deepEqual(Object.keys(value).sort(),['active','attempted','capped','completed','elapsedMs','rejected']);assert.equal(value.attempted,20);assert.equal(value.capped,true);
 assert.ok(JSON.stringify(value).length<160,'aggregate payload remains bounded independently of attempts');assert.ok(Object.isFrozen(value));
 let n=0;const overflow=new PoolCheckoutTimingCapture(()=>n++%2===0?0:3600000);overflow.run(()=>{fake.connect(()=>{});fake.connect(()=>{});});assert.equal(overflow.snapshot().elapsedMs,null);
});
