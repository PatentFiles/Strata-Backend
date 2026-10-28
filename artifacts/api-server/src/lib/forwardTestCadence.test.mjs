import test from 'node:test';
import assert from 'node:assert/strict';
import {producerDelayMs,OptionalResearchLane,BoundaryDiscoveryRecovery} from './forwardTestCadence.ts';
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

test('empty-listing recovery is bounded without accelerating valid evaluations or other errors',()=>{
 const retry=new BoundaryDiscoveryRecovery(),t=900000;
 assert.equal(retry.periodMs(null,t),5000);
 assert.equal(retry.periodMs("Public market feed returned HTTP 429",t),5000);
 for(let i=0;i<3;i++)assert.equal(retry.periodMs("Kalshi returned no current market",t+i*1000),1000);
 assert.equal(retry.periodMs(null,t+4000),5000);
 for(let i=0;i<20;i++)assert.equal(retry.periodMs("Kalshi returned no current market",t+5000+i*5000),5000);
 assert.equal(retry.periodMs("Kalshi returned no current market",t-1),5000,'clock regression cannot refresh budget');
 assert.equal(retry.periodMs("Kalshi returned no current market",t+900000),1000,'next market window gets a bounded discovery budget');
 assert.equal(producerDelayMs(1000,1500),250,'slow discovery stays sequential with an overrun floor');
});
