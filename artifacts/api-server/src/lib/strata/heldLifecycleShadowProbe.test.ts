import test from 'node:test';import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {startHeldLifecycleShadowProbe} from './heldLifecycleShadowProbe';
test('disabled and malformed explicit probe never touch DB or credentials',async()=>{
 const original=pool.connect;let calls=0;
 pool.connect=(()=>{calls++;throw Error('no database permitted')}) as typeof pool.connect;
 try{
  startHeldLifecycleShadowProbe({NODE_ENV:'production'});
  startHeldLifecycleShadowProbe({NODE_ENV:'test',STRATA_HELD_LIFECYCLE_PROBE_ENABLED:'true'});
  startHeldLifecycleShadowProbe({NODE_ENV:'production',STRATA_HELD_LIFECYCLE_PROBE_ENABLED:'true'});
  await Promise.resolve();await Promise.resolve();assert.equal(calls,0);
 }finally{pool.connect=original;}
});
