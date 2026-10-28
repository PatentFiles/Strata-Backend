import test from 'node:test';
import assert from 'node:assert/strict';
import {producerDelayMs,OptionalResearchLane} from './forwardTestCadence.ts';
test('start-to-start delay removes processing overhead and prevents overrun hot loops',()=>{
 for(const [elapsed,expected] of [[0,5000],[2300,2700],[4750,250],[6000,250]])
  assert.equal(producerDelayMs(5000,elapsed),expected);
 for(const period of [1000,2500,5000])for(let elapsed=0;elapsed<10000;elapsed+=37)
  assert.ok(producerDelayMs(period,elapsed)>=250);
 assert.throws(()=>producerDelayMs(5000,NaN));
});
test('optional research has one task and no backlog, failures release the lane',async()=>{
 const lane=new OptionalResearchLane();let release;let calls=0,reports=0;
 const held=new Promise(r=>{release=r;});
 assert.equal(lane.submit(async()=>{calls++;await held;},()=>reports++),true);
 for(let n=0;n<100;n++)assert.equal(lane.submit(async()=>{calls++;},()=>reports++),false);
 await Promise.resolve();assert.equal(calls,1);release();await lane.drain();
 assert.equal(lane.submit(async()=>{throw Error('offline');},()=>reports++),true);
 await lane.drain();assert.equal(reports,1);
 assert.equal(lane.submit(async()=>{calls++;},()=>reports++),true);await lane.drain();assert.equal(calls,2);
});
