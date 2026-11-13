import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import type {Pool,PoolClient} from '@workspace/db';
import {pool as admin,poolConfig,PoolCheckoutTimingCapture,installPoolCheckoutTiming} from '@workspace/db';
const pg=createRequire(resolve(process.cwd(),'../../lib/db/package.json'))('pg') as {Pool:new(config:ReturnType<typeof poolConfig>)=>Pool};
const url=process.env.V13_DISPOSABLE_DATABASE_URL??'';
assert.match(url,/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
after(()=>admin.end());
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(f:()=>boolean){const end=performance.now()+2000;while(!f()){assert.ok(performance.now()<end,'condition timeout');await sleep(2);}}
function fixture(observed=true){
 const config=poolConfig(url);assert.equal(config.max,10);assert.equal(config.connectionTimeoutMillis,10000);
 const p=new pg.Pool(config);let dispatches=0;
 p.on('connect',(client:PoolClient)=>{const query=client.query;client.query=function(this:PoolClient,...args:unknown[]){dispatches++;return Reflect.apply(query,this,args);} as typeof client.query;});
 const originalQuery=p.query;if(observed)installPoolCheckoutTiming(p);assert.equal(p.query,originalQuery,'pool.query itself remains untouched');
 return {p,count:()=>dispatches};
}
async function hold(p:Pool,n:number){const clients:PoolClient[]=[];for(let i=0;i<n;i++)clients.push(await p.connect());return clients;}
async function setup(){await admin.query('CREATE TABLE IF NOT EXISTS checkout_timing_marker(id text PRIMARY KEY,revision integer NOT NULL DEFAULT 0)');await admin.query("INSERT INTO checkout_timing_marker(id) VALUES('fee') ON CONFLICT(id) DO UPDATE SET revision=0");}
function emit(name:string,result:unknown){console.log('POOL_CHECKOUT_TIMING_RESULT',JSON.stringify({name,result,scope:'local controlled harness; not production latency or executed order evidence'}));}

test('passive checkout capture preserves low/high occupancy and independent autocommit across outer rollback',async()=>{
 for(const occupied of [1,5,9]){
  await setup();const f=fixture(),held=await hold(f.p,occupied);const capture=new PoolCheckoutTimingCapture();
  try{
   await held[0].query('BEGIN');const before=f.count();
   const start=performance.now();await capture.run(()=>f.p.query("UPDATE checkout_timing_marker SET revision=revision+1 WHERE id='fee'"));const total=performance.now()-start;
   const sampled=capture.snapshot();assert.equal(sampled.attempted,1);assert.equal(sampled.completed,1);assert.equal(sampled.rejected,0);assert.equal(sampled.active,0);assert.equal(sampled.capped,false);
   assert.ok(sampled.elapsedMs!==null);assert.ok(sampled.elapsedMs>=0&&sampled.elapsedMs<=total);assert.equal(f.count()-before,1);assert.equal(f.p.waitingCount,0);
   assert.equal((await admin.query("SELECT revision FROM checkout_timing_marker WHERE id='fee'")).rows[0].revision,1);
   await held[0].query('ROLLBACK');assert.equal((await admin.query("SELECT revision FROM checkout_timing_marker WHERE id='fee'")).rows[0].revision,1);
   emit('occupancy_autocommit',{occupied,maximum:10,totalMs:total,checkout:sampled,statementDispatches:f.count()-before-1});
  }finally{held.forEach(c=>c.release());await f.p.end();}
 }
});

test('controlled120ms pool queue is separate from40ms statement execution',async()=>{
 const f=fixture(),held=await hold(f.p,10);let released=false;const capture=new PoolCheckoutTimingCapture();
 try{
  const before=f.count(),start=performance.now();const pending=capture.run(()=>f.p.query('SELECT pg_sleep(0.040)'));
  await until(()=>f.p.waitingCount===1);assert.equal(capture.snapshot().active,1);await sleep(120);held[9].release();released=true;await pending;
  const total=performance.now()-start,s=capture.snapshot();assert.equal(s.attempted,1);assert.equal(s.completed,1);assert.equal(s.rejected,0);assert.equal(s.active,0);assert.ok(s.elapsedMs!==null);assert.ok(s.elapsedMs>=115);assert.ok(total-s.elapsedMs>=35);
  assert.equal(f.count()-before,1);emit('queue_vs_statement',{totalMs:total,afterCheckoutMs:total-s.elapsedMs,checkout:s,driverDispatches:f.count()-before});
 }finally{held.forEach((c,i)=>{if(i!==9||!released)c.release();});await f.p.end();}
});

test('real configured10s checkout timeout rejects without dispatch and releases waiter',async()=>{
 const f=fixture(),held=await hold(f.p,10);const capture=new PoolCheckoutTimingCapture(),before=f.count();
 try{
  await assert.rejects(capture.run(()=>f.p.query('SELECT 1')),/timeout exceeded when trying to connect/);
  const s=capture.snapshot();assert.equal(s.attempted,1);assert.equal(s.completed,1);assert.equal(s.rejected,1);assert.equal(s.active,0);assert.ok(s.elapsedMs!==null);assert.ok(s.elapsedMs>=9500);assert.equal(f.count()-before,0);assert.equal(f.p.waitingCount,0);
  emit('checkout_timeout',{checkout:s,driverDispatches:f.count()-before,connectionTimeoutMillis:10000});
 }finally{held.forEach(c=>c.release());await f.p.end();}
});

test('statement error remains statement error, failed client release and next query behave unchanged',async()=>{
 await setup();const f=fixture(),capture=new PoolCheckoutTimingCapture(),before=f.count();
 try{
  await assert.rejects(capture.run(()=>f.p.query("INSERT INTO checkout_timing_marker(id) VALUES('fee')")),e=>(e as {code?:string}).code==='23505');
  const failedDispatches=f.count()-before;assert.equal(failedDispatches,1);await until(()=>f.p.totalCount===0);
  const failed=capture.snapshot();assert.equal(failed.completed,1);assert.equal(failed.rejected,0,'SQL errors are not checkout rejection');assert.equal(failed.active,0);
  const recoveryBefore=f.count();await capture.run(()=>f.p.query("UPDATE checkout_timing_marker SET revision=revision+1 WHERE id='fee'"));
  const recoveryDispatches=f.count()-recoveryBefore;assert.equal(recoveryDispatches,1);assert.equal(capture.snapshot().completed,2);
  emit('sql_error_release',{failedDispatches,recoveryDispatches,repeatedFailedDispatches:Math.max(0,failedDispatches-1),checkout:capture.snapshot()});
 }finally{await f.p.end();}
});

test('caller Promise.race deadline does not cancel queued work or release its checkout',async()=>{
 await setup();const f=fixture(),held=await hold(f.p,10);let released=false;const capture=new PoolCheckoutTimingCapture(),before=f.count();
 try{
  const pending=capture.run(()=>f.p.query("UPDATE checkout_timing_marker SET revision=revision+1 WHERE id='fee'"));
  await assert.rejects(Promise.race([pending,sleep(25).then(()=>{throw Error('caller_deadline');})]),/caller_deadline/);
  assert.equal(f.p.waitingCount,1);assert.equal(capture.snapshot().active,1);assert.equal(f.count()-before,0);
  held[9].release();released=true;await pending;
  assert.equal(f.count()-before,1);assert.equal(capture.snapshot().completed,1);assert.equal(capture.snapshot().active,0);
  assert.equal((await admin.query("SELECT revision FROM checkout_timing_marker WHERE id='fee'")).rows[0].revision,1);
  emit('caller_deadline_not_cancellation',{checkout:capture.snapshot(),driverDispatches:f.count()-before,lateAutocommit:true});
 }finally{held.forEach((c,i)=>{if(i!==9||!released)c.release();});await f.p.end();}
});

test('alternating warmed baseline/capture samples report controlled harness overhead without performance guarantee',async()=>{
 const base=fixture(false),observed=fixture(true);const rows:{baselineMs:number;observedMs:number;checkoutMs:number|null}[]=[];
 try{
  await base.p.query('SELECT 1');await observed.p.query('SELECT 1');const baseBefore=base.count(),observedBefore=observed.count();
  for(let i=0;i<40;i++){
   let baselineMs=0,observedMs=0;const capture=new PoolCheckoutTimingCapture();
   const baseline=async()=>{const start=performance.now();await base.p.query('SELECT 1');baselineMs=performance.now()-start;};
   const measured=async()=>{const start=performance.now();await capture.run(()=>observed.p.query('SELECT 1'));observedMs=performance.now()-start;};
   if(i%2){await measured();await baseline();}else{await baseline();await measured();}
   assert.equal(capture.snapshot().completed,1);rows.push({baselineMs,observedMs,checkoutMs:capture.snapshot().elapsedMs});
  }
  assert.equal(base.count()-baseBefore,40);assert.equal(observed.count()-observedBefore,40);
  const median=(xs:number[])=>xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)];
  emit('alternating_harness_overhead',{iterations:40,baselineMedianMs:median(rows.map(x=>x.baselineMs)),observedMedianMs:median(rows.map(x=>x.observedMs)),pairedDeltaMedianMs:median(rows.map(x=>x.observedMs-x.baselineMs)),baselineDriverDispatches:base.count()-baseBefore,observedDriverDispatches:observed.count()-observedBefore,rows});
 }finally{await base.p.end();await observed.p.end();}
});

test('concurrent captures on one saturated pool remain isolated after synchronous dispatch scopes close',async()=>{
 const f=fixture(),held=await hold(f.p,10),blocker=await admin.connect();let released9=false,released8=false;
 const first=new PoolCheckoutTimingCapture(),second=new PoolCheckoutTimingCapture();let pendingFirst:Promise<unknown>|undefined,pendingSecond:Promise<unknown>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(2147483000)');
  const before=f.count();pendingFirst=first.run(()=>f.p.query('SELECT pg_advisory_xact_lock(2147483000)'));pendingSecond=second.run(()=>f.p.query('SELECT 1'));
  await until(()=>f.p.waitingCount===2);assert.equal(first.snapshot().active,1);assert.equal(second.snapshot().active,1);
  await sleep(30);held[9].release();released9=true;await until(()=>first.snapshot().completed===1);
  // First query holds its own checked-out client behind a local advisory lock,
  // so second checkout cannot be satisfied by first query completion.
  assert.equal(second.snapshot().completed,0);assert.equal(second.snapshot().active,1);await sleep(30);
  held[8].release();released8=true;await pendingSecond;
  const a=first.snapshot(),b=second.snapshot();for(const s of [a,b]){assert.equal(s.attempted,1);assert.equal(s.completed,1);assert.equal(s.rejected,0);assert.equal(s.active,0);assert.equal(s.capped,false);assert.ok(s.elapsedMs!==null);}
  assert.ok(b.elapsedMs!-a.elapsedMs!>=25);assert.equal(f.count()-before,2);
  await blocker.query('ROLLBACK');await pendingFirst;
  assert.deepEqual(first.snapshot(),a);assert.deepEqual(second.snapshot(),b);
  emit('concurrent_scope_isolation',{first:a,second:b,driverDispatches:f.count()-before});
 }finally{
  await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await pendingFirst?.catch(()=>{});await pendingSecond?.catch(()=>{});
  held.forEach((c,i)=>{if((i!==9||!released9)&&(i!==8||!released8))c.release();});await f.p.end();
 }
});
