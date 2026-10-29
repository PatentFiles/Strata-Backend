import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

test('inserted discovery retries preserve the original five-second poll deadline',()=>{
 const retry=new BoundaryDiscoveryRecovery();let clock=900000;
 const starts=[clock];
 for(let i=0;i<6;i++){
  const period=retry.periodMs("Kalshi returned no current market",clock);
  const processingMs=150;
  clock+=processingMs+producerDelayMs(period,processingMs);starts.push(clock);
 }
 assert.deepEqual(starts.map(x=>x-starts[0]),[0,1000,2000,3000,5000,10000,15000]);
 for(const availableAt of [500,1500,2500,3500,4500]){
  const actual=starts.find(t=>t-starts[0]>=availableAt)-starts[0];
  assert.ok(actual<=5000,'fast discovery cannot postpone the original +5s poll');
 }
});


test('held optional book capture never blocks another cycle and never builds a backlog',async()=>{
 const lane=new OptionalResearchLane();let release,captures=0,cycles=0,skips=0;
 const held=new Promise(r=>{release=r;});
 const committedCycle=()=>{
   cycles++;
   if(!lane.submit(async()=>{captures++;await held;},()=>{}))skips++;
 };
 committedCycle();await Promise.resolve();
 for(let i=0;i<10;i++)committedCycle();
 assert.equal(cycles,11);assert.equal(captures,1);assert.equal(skips,10);
 release();await lane.drain();committedCycle();await lane.drain();
 assert.equal(captures,2);
});
test('worker wires optional post-action capture only after commit and outside cycle return path',()=>{
 const source=readFileSync(new URL('./forwardTestWorker.ts',import.meta.url),'utf8');
 const cycle=source.slice(source.indexOf('export async function runForwardTestCycle'),source.indexOf('export function startServerForwardTestWorker'));
 assert.ok(cycle.includes('notifyCommittedForwardSignal()'));
 assert.ok(!cycle.includes('savePostActionPaperBook('));
 const scheduler=source.slice(source.indexOf('export function startServerForwardTestWorker'));
 assert.ok(scheduler.indexOf('await runForwardTestCycle(')<scheduler.indexOf('bookCaptureLane.submit('));
 assert.ok(scheduler.indexOf('bookCaptureLane.submit(')<scheduler.indexOf('await processMicroLiveForwardTestCycle('));
 assert.ok(scheduler.includes('Post-action paper book capture skipped: previous capture still pending'));
 assert.ok(!scheduler.includes('await bookCaptureLane.drain()'));
});
