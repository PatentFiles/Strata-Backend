import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {eq, sql} from 'drizzle-orm';
import {db, pool, forwardTestEngineTable, forwardTestEvaluationTable} from '@workspace/db';
import {ensureWorkerEngine, acquireWorkerLease, renewWorkerLease, WorkerLeaseLostError} from './forwardTestRepository';
import {runForwardTestCycle} from './forwardTestWorker';
import {onCommittedForwardSignal} from './forwardTestSignalWake';
import type {ForwardTestFeeds, MarketObservation} from './forwardTestFeeds';

assert.match(process.env.DATABASE_URL ?? '', /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL, process.env.V13_DISPOSABLE_DATABASE_URL);
after(() => pool.end());
let previousEngine: string | null = null;
async function fixture() {
  if (previousEngine) await db.update(forwardTestEngineTable).set({enabled:false})
    .where(eq(forwardTestEngineTable.id, previousEngine));
  const id = randomUUID(), engineId = 'PRODUCER-ATTEMPT-' + id, owner = 'owner-' + id;
  const ticker = 'KXBTC15M-ATTEMPT-' + id.toUpperCase();
  await ensureWorkerEngine(engineId);
  await db.update(forwardTestEngineTable).set({enabled:true}).where(eq(forwardTestEngineTable.id, engineId));
  const lease = (await acquireWorkerLease(owner, engineId))!;
  previousEngine = engineId;
  const at = new Date(), market: MarketObservation = {
    ticker, target:100000, startsAt:new Date(at.getTime()-1000), endsAt:new Date(at.getTime()+900000),
    yesAsk:.50, noAsk:.51, yesBid:.49, noBid:.48, yesPrice:.50, noPrice:.49,
    status:'open', result:null, fetchedAt:at,
  };
  const feeds: ForwardTestFeeds = {
    btc:async()=>({price:99999, providerAt:at, receivedAt:at}),
    market:async()=>market,
  };
  const row = async () => (await db.select().from(forwardTestEngineTable).where(eq(forwardTestEngineTable.id,engineId)))[0]!;
  return {engineId, owner, ticker, lease, at, feeds, row};
}

test('attempt marker and renewal are one guarded statement; legacy renewals preserve marker', async()=>{
  const f = await fixture();
  const at = new Date(f.at.getTime()-321);
  const renewed = (await renewWorkerLease(f.owner,f.lease.leaseEpoch,f.engineId,20,at))!;
  assert.equal(renewed.lastAttemptedCycleAt?.getTime(),at.getTime());
  assert.equal(renewed.leaseOwner,f.owner);
  assert.equal(renewed.leaseEpoch,f.lease.leaseEpoch);
  assert.ok(renewed.leaseExpiresAt!.getTime()>Date.now());
  await renewWorkerLease(f.owner,f.lease.leaseEpoch,f.engineId);
  assert.equal((await f.row()).lastAttemptedCycleAt?.getTime(),at.getTime());
});

for (const failure of ['owner','epoch','disabled','expired'] as const) {
  test(`${failure} fence failure cannot change attempt marker or reach public feeds`, async()=>{
    const f = await fixture(), before = new Date(f.at.getTime()-1111);
    await db.update(forwardTestEngineTable).set({lastAttemptedCycleAt:before,
      ...(failure==='disabled'?{enabled:false}:{}),
      ...(failure==='expired'?{leaseExpiresAt:sql`clock_timestamp()-interval '1 second'`}:{}),
    }).where(eq(forwardTestEngineTable.id,f.engineId));
    let reads = 0;
    await assert.rejects(runForwardTestCycle({owner:failure==='owner'?'wrong':f.owner,
      epoch:f.lease.leaseEpoch-(failure==='epoch'?1:0),engineId:f.engineId,now:f.at,
      feeds:{btc:async()=>{reads++;return f.feeds.btc();},market:async()=>{reads++;return f.feeds.market();}},
    }),WorkerLeaseLostError);
    assert.equal(reads,0);
    assert.equal((await f.row()).lastAttemptedCycleAt?.getTime(),before.getTime());
  });
}

for(const loss of ['takeover','disabled'] as const){
 test(`concurrent ${loss} winning a row lock prevents the merged renewal and marker`,async()=>{
  const f=await fixture(),c=await pool.connect(),before=(await f.row()).lastAttemptedCycleAt;
  let pending:ReturnType<typeof renewWorkerLease>|undefined;
  try{
   await c.query('BEGIN');await c.query('SELECT id FROM forward_test_engine WHERE id=$1 FOR UPDATE',[f.engineId]);
   let settled=false;pending=renewWorkerLease(f.owner,f.lease.leaseEpoch,f.engineId,20,f.at);
   pending.then(()=>{settled=true;},()=>{settled=true;});await delay(25);assert.equal(settled,false);
   if(loss==='takeover')await c.query('UPDATE forward_test_engine SET lease_owner=$2,lease_epoch=lease_epoch+1 WHERE id=$1',[f.engineId,'new-owner']);
   else await c.query('UPDATE forward_test_engine SET enabled=false WHERE id=$1',[f.engineId]);
   await c.query('COMMIT');assert.equal(await pending,null);
   assert.equal((await f.row()).lastAttemptedCycleAt?.getTime(),before?.getTime());
  }finally{await c.query('ROLLBACK');c.release();if(pending)await pending;}
 });
}

test('pre-feed path contains exactly renewal-with-marker and open-position SELECT, with no transaction', async()=>{
  const f = await fixture(), c = await pool.connect();
  const prototype = Object.getPrototypeOf(c), original = prototype.query;
  c.release();
  const calls: string[] = [];
  prototype.query = function (...args: unknown[]) {
    const q = args[0] as string|{text:string};calls.push(typeof q==='string'?q:q.text);
    return original.apply(this,args);
  };
  let beforeFeeds: string[] = [];
  try {
    const r = await runForwardTestCycle({owner:f.owner,epoch:f.lease.leaseEpoch,engineId:f.engineId,now:f.at,
      clock:()=>f.at.getTime(),feeds:{...f.feeds,btc:async()=>{
        beforeFeeds=calls.slice();return f.feeds.btc();
      }}});
    assert.equal(r.error,null);
  } finally {prototype.query=original;}
  assert.equal(beforeFeeds.length,2,JSON.stringify(beforeFeeds));
  assert.match(beforeFeeds[0],/^update "forward_test_engine"/i);
  assert.match(beforeFeeds[0],/last_attempted_cycle_at/);
  assert.match(beforeFeeds[0],/lease_owner/);assert.match(beforeFeeds[0],/lease_epoch/);
  assert.match(beforeFeeds[0],/lease_expires_at.*clock_timestamp/);
  assert.match(beforeFeeds[1],/^select.*forward_test_positions/i);
  assert.equal((await f.row()).lastEvaluationAt?.getTime(),f.at.getTime());
});

for (const loss of ['takeover','disabled'] as const) {
  test(`${loss} after renewal remains fenced by the unchanged atomic publication transaction`,async()=>{
    const f = await fixture();let wakes=0;const off=onCommittedForwardSignal(()=>wakes++);
    try{await assert.rejects(runForwardTestCycle({owner:f.owner,epoch:f.lease.leaseEpoch,engineId:f.engineId,now:f.at,
      clock:()=>f.at.getTime(),feeds:{...f.feeds,btc:async()=>{
        await db.update(forwardTestEngineTable).set(loss==='takeover'
          ?{leaseOwner:'new-owner',leaseEpoch:f.lease.leaseEpoch+1}:{enabled:false})
          .where(eq(forwardTestEngineTable.id,f.engineId));return f.feeds.btc();
      }}}),WorkerLeaseLostError);}finally{off();}
    assert.equal((await db.select().from(forwardTestEvaluationTable)
      .where(eq(forwardTestEvaluationTable.marketTicker,f.ticker))).length,0);
    assert.equal(wakes,0);
  });
}

// Advance the deterministic app clock only AFTER PostgreSQL returns the initial
// lease UPDATE. This verifies the preserved strategy-clock boundary, unlike options.now.
async function afterInitialRenewal<T>(advance:()=>void,work:()=>Promise<T>):Promise<T>{
  const c=await pool.connect(),prototype=Object.getPrototypeOf(c),original=prototype.query;c.release();
  let initial=true;
  prototype.query=function(...args:unknown[]){
    const q=args[0] as string|{text:string},text=typeof q==='string'?q:q.text;
    const matched=initial&&/^update "forward_test_engine"/i.test(text)&&
      text.includes('last_attempted_cycle_at')&&text.includes('lease_renewed_at');
    if(matched){initial=false;
      if(typeof args.at(-1)==='function'){
        const callback=args.at(-1) as (...values:unknown[])=>void;
        args[args.length-1]=(...values:unknown[])=>{advance();callback(...values);};
        return original.apply(this,args);
      }
      return original.apply(this,args).then((value:unknown)=>{advance();return value;});
    }
    return original.apply(this,args);
  };
  try{return await work();}finally{prototype.query=original;}
}

for(const finalAge of [4999,5000,5001]){
 test(`advancing initial-renewal clock retains original provider deadline at ${finalAge} ms`,async()=>{
  const f=await fixture();
  await runForwardTestCycle({owner:f.owner,epoch:f.lease.leaseEpoch,engineId:f.engineId,now:f.at,
    clock:()=>f.at.getTime(),feeds:f.feeds});
  const cycleAt=f.at.getTime()+2000,initialAge=finalAge-200;let current=cycleAt,wakes=0;
  const off=onCommittedForwardSignal(()=>wakes++);
  const feeds:ForwardTestFeeds={
    btc:async()=>({price:100010,providerAt:new Date(cycleAt-initialAge),receivedAt:new Date(cycleAt)}),
    market:async()=>({...await f.feeds.market(),fetchedAt:new Date(current)}),
    book:async()=>({ticker:f.ticker,source:'KALSHI_PUBLIC_REST',timestampAuthority:'LOCAL_RECEIPT_ONLY',
      requestStartedAtMs:current,receivedAtMs:current,bodyCompletedAtMs:current,
      yesBids:[{priceTicks:4900,contractsHundredths:100000}],noBids:[{priceTicks:5000,contractsHundredths:100000}]}),
  };
  let r;
  try{r=await afterInitialRenewal(()=>{current+=200;},()=>runForwardTestCycle({
    owner:f.owner,epoch:f.lease.leaseEpoch,engineId:f.engineId,clock:()=>current,feeds}));}finally{off();}
  assert.equal(current,cycleAt+200);
  // Starting a new book request requires positive time remaining. At exactly
  // 5,000 ms the unchanged reader rejects; its later final check permits 5,000.
  if(finalAge<5000){
    assert.equal(r.error,null);assert.equal(r.signal,'SCOUT');assert.equal(wakes,1);
    const e=(await db.select().from(forwardTestEvaluationTable).where(eq(forwardTestEvaluationTable.id,r.evaluationId!)))[0]!;
    assert.equal(e.evaluatedAt.getTime(),cycleAt+200);assert.equal(e.btcProviderAgeMs,finalAge);
    assert.equal(current-e.evaluatedAt.getTime()+e.btcProviderAgeMs,finalAge);
  }else{assert.equal(r.error,'entry_book_source_stale');assert.equal(r.evaluationId,null);assert.equal(wakes,0);}
 });
}

test('rollover during initial renewal keeps the original post-renewal strategy clock',async()=>{
  const f=await fixture(),cycleAt=f.at.getTime();let current=cycleAt,books=0;
  const r=await afterInitialRenewal(()=>{current+=200;},()=>runForwardTestCycle({
    owner:f.owner,epoch:f.lease.leaseEpoch,engineId:f.engineId,clock:()=>current,
    feeds:{...f.feeds,market:async()=>({...await f.feeds.market(),startsAt:new Date(cycleAt+100),fetchedAt:new Date(current)}),
      book:async()=>{books++;throw Error('unexpected book');}},
  }));
  assert.equal(r.error,null);assert.ok(r.evaluationId);assert.equal(books,0);
  assert.equal((await f.row()).lastSuccessfulCycleAt?.getTime(),cycleAt+200);
});

test('diagnostic attempt precedes renewal while original strategy clock follows it',()=>{
  const source=readFileSync(resolve('src/lib/forwardTestWorker.ts'),'utf8');
  const start=source.indexOf('export async function runForwardTestCycle');
  const clock=source.indexOf('const now = options.now ?? new Date(clock());',start);
  const attempt=source.indexOf('const attemptedAt = options.now ?? new Date(clock());',start);
  const renew=source.indexOf('await renewWorkerLease(owner, epoch, engineId, LEASE_SECONDS, attemptedAt)',start);
  const finalTransaction=source.indexOf('const result = await withWorkerLeaseTransaction',start);
  const wake=source.indexOf('notifyCommittedForwardSignal(result.',finalTransaction);
  assert.ok(start<attempt&&attempt<renew&&renew<clock&&clock<finalTransaction&&finalTransaction<wake);
  assert.equal(source.slice(renew,source.indexOf('let btc:',renew)).includes('withWorkerLeaseTransaction'),false);
  assert.match(source,/if\(entryQuote\)\{signal\?\.throwIfAborted\(\);assertEntrySourceFresh\(btc,detailMarket,now\.getTime\(\),entryClock\(\)\);\}/);
  for(const originalAge of ['now.getTime() - btc.providerAt.getTime()','now.getTime() - btc.receivedAt.getTime()'])
    assert.ok(source.includes(originalAge));
});
