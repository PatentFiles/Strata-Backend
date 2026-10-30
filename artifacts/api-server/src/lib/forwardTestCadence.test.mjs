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

test('rollover discovery has one shared ten-retry budget and resets only next quarter',()=>{
 const retry=new BoundaryDiscoveryRecovery(),t=900000;
 for(let i=0;i<10;i++)assert.equal(retry.periodMs(i%2?
   'Kalshi returned no current market':'Kalshi exact market strike is missing or invalid',t+i*1000),1000);
 for(let i=10;i<40;i++)assert.equal(retry.periodMs('Kalshi returned no current market',t+i*1000),5000);
 assert.equal(retry.periodMs('Kalshi returned no current market',t-1),5000);
 assert.equal(retry.periodMs('Kalshi returned no current market',t+900000),1000);
 assert.equal(retry.periodMs('Kalshi returned no current market',t+899999),5000);
 assert.equal(producerDelayMs(1000,1500),250,'slow cycles stay sequential with an overrun pause');
});

test('ten fast discovery retries preserve original regular poll and cover observed late strike',()=>{
 const retry=new BoundaryDiscoveryRecovery();let clock=900000;
 const starts=[clock];
 for(let i=0;i<13;i++){
  const period=retry.periodMs('Kalshi exact market strike is missing or invalid',clock);
  const processingMs=150;
  clock+=processingMs+producerDelayMs(period,processingMs);starts.push(clock);
 }
 assert.deepEqual(starts.map(x=>x-starts[0]),[0,1000,2000,3000,4000,5000,6000,7000,8000,9000,10000,15000,20000,25000]);
 // Scenario replay: a valid response known observable by +7.940s. This is
 // not a claim that the provider first published it at that exact instant.
 const firstAfterObservedValid=starts.find(t=>t-starts[0]>=7940)-starts[0];
 assert.equal(firstAfterObservedValid,8000);
 assert.ok(starts.includes(starts[0]+5000),'do not postpone original +5s poll');
});

test('success, throttling, unrelated failures and elapsed boundary close fast lane',()=>{
 const t=900000,missing='Kalshi exact market strike is missing or invalid';
 for(const reason of [null,'Public market feed returned HTTP 429','Public market feed returned HTTP 503',
   'Kalshi market snapshot is missing or stale','Kalshi market ticker is invalid',
   'Kalshi market end time is missing or invalid','Coinbase BTC feed is missing, malformed, or stale']){
  const retry=new BoundaryDiscoveryRecovery();
  assert.equal(retry.periodMs(missing,t),1000);
  assert.equal(retry.periodMs(reason,t+1000),5000);
  assert.equal(retry.periodMs(missing,t+2000),5000,'no fast restart after refusal/success');
  assert.equal(retry.periodMs(missing,t+900000),1000);
 }
 for(const reason of [missing,'Kalshi returned no current market']){
  assert.equal(new BoundaryDiscoveryRecovery().periodMs(reason,t+30000),5000);
  const retry=new BoundaryDiscoveryRecovery();
  assert.equal(retry.periodMs(reason,t+29999),1000);
  assert.equal(retry.periodMs(reason,t+30000),5000);
 }
});

test('clock regression or invalid clock closes fast retries including coincident throttles',()=>{
 const t=900000,missing='Kalshi returned no current market';
 for(const bad of [t,NaN,Infinity,-1,t+1000.5])for(const error of [missing,null,'Public market feed returned HTTP 429']){
  const retry=new BoundaryDiscoveryRecovery();
  assert.equal(retry.periodMs(missing,t+1000),1000);
  assert.equal(retry.periodMs(error,bad),5000);
  assert.equal(retry.periodMs(missing,t+2000),5000,'same window remains closed');
  assert.equal(retry.periodMs(missing,t+900000),1000,'only next valid window resets');
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

test('worker remains one awaited cycle with ordinary five-second successful cadence',()=>{
 const source=readFileSync(new URL('./forwardTestWorker.ts',import.meta.url),'utf8');
 const scheduler=source.slice(source.indexOf('export function startServerForwardTestWorker'));
 assert.ok(scheduler.includes('while (!stopped)'));
 assert.ok(scheduler.includes('const cycle = await runForwardTestCycle('));
 assert.ok(scheduler.includes('periodMs=discoveryRecovery.periodMs(cycle.error,cycleClock)'));
 assert.ok(scheduler.includes('await pause('));
 const retry=new BoundaryDiscoveryRecovery();
 for(let i=0;i<20;i++)assert.equal(retry.periodMs(null,900000+i*5000),5000);
});
