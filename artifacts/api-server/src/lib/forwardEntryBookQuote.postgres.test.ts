import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {eq} from 'drizzle-orm';
import {db,pool,forwardTestEngineTable,forwardTestWindowTable,forwardTestPositionTable,
 forwardTestEvaluationTable,forwardTestBtcPointTable,forwardTestBookSnapshotTable} from '@workspace/db';
import {ensureWorkerEngine,acquireWorkerLease,releaseWorkerLease,WorkerLeaseLostError} from './forwardTestRepository';
import {runForwardTestCycle} from './forwardTestWorker';
import {savePrequalificationPaperBook,readPaperBookCaptureCoverage} from './forwardTestBookCapture';
import {fetchKalshiPublicBook,type ReadonlyResearchBook} from './forwardTestOrderbookDepth';
import type {MarketObservation} from './forwardTestFeeds';
assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL,process.env.V13_DISPOSABLE_DATABASE_URL);
after(()=>pool.end());
let previousEngine:string|null=null;
type Options={detailAsk?:number|null;bookAsk?:number;book?: (b:ReadonlyResearchBook,m:MarketObservation)=>Promise<ReadonlyResearchBook>;
 market?:Partial<MarketObservation>;clock?:(at:number,bookDone:boolean)=>number};
async function fixture(){
 if(previousEngine)await db.update(forwardTestEngineTable).set({enabled:false}).where(eq(forwardTestEngineTable.id,previousEngine));
 const id=randomUUID().toUpperCase(),engineId='BOOK-'+id,ticker='KXBTC15M-BOOK-'+id,owner='owner-'+id;
 await ensureWorkerEngine(engineId);await db.update(forwardTestEngineTable).set({enabled:true}).where(eq(forwardTestEngineTable.id,engineId));
 const lease=(await acquireWorkerLease(owner,engineId))!;previousEngine=engineId;let at=Date.now(),calls=0;
 const start=at-1000,end=at+900000;
 const state=async()=>({window:(await db.select().from(forwardTestWindowTable).where(eq(forwardTestWindowTable.ticker,ticker)))[0],
  positions:await db.select().from(forwardTestPositionTable).where(eq(forwardTestPositionTable.engineId,engineId)),
  evaluations:await db.select().from(forwardTestEvaluationTable).where(eq(forwardTestEvaluationTable.marketTicker,ticker)),
  points:await db.select().from(forwardTestBtcPointTable).where(eq(forwardTestBtcPointTable.engineId,engineId))});
 async function observe(buffer:number,options:Options={}){
  at+=2000;let done=false;
  const selected=options.detailAsk===undefined?.50:options.detailAsk;
  const m:MarketObservation={ticker,target:100000,startsAt:new Date(start),endsAt:new Date(end),
   yesAsk:buffer>=0?selected:.51,noAsk:buffer<0?selected:.51,yesBid:.49,noBid:.48,yesPrice:.50,noPrice:.49,
   status:'open',result:null,fetchedAt:new Date(at),...options.market};
  const selectedBook=options.bookAsk??.50,ya=buffer>=0?selectedBook:1.01-selectedBook,na=buffer<0?selectedBook:1.01-selectedBook;
  const b:ReadonlyResearchBook={ticker,source:'KALSHI_PUBLIC_REST',timestampAuthority:'LOCAL_RECEIPT_ONLY',
   requestStartedAtMs:at,receivedAtMs:at,bodyCompletedAtMs:at,
   yesBids:[{priceTicks:Math.round((1-na)*10000),contractsHundredths:500000}],
   noBids:[{priceTicks:Math.round((1-ya)*10000),contractsHundredths:500000}]};
  return runForwardTestCycle({owner,epoch:lease.leaseEpoch,engineId,now:new Date(at),
   clock:()=>options.clock?.(at,done)??at,
   feeds:{btc:async()=>({price:100000+buffer,providerAt:new Date(at),receivedAt:new Date(at)}),market:async()=>m,
    book:async()=>{calls++;const out=options.book?await options.book(b,m):b;done=true;return out;}}});
 }
 return {engineId,ticker,owner,lease,state,observe,calls:()=>calls};
}
for(const [buffer,detailAsk,bookAsk,signal] of [[10,.99,.52,'SCOUT'],[-10,.007,.25,'SCOUT'],[-10,.39,.43,'SCOUT'],[25,.99,.53,'CONFIRM']] as const){
 test(`canonical ${signal} uses coherent book ${bookAsk} not metadata ${detailAsk}`,async()=>{
  const f=await fixture();await f.observe(buffer>0?-1:1);const r=await f.observe(buffer,{detailAsk,bookAsk});
  assert.equal(r.error,null);assert.equal(r.signal,signal);assert.equal(f.calls(),1);
  const s=await f.state(),e=s.evaluations.find(x=>x.id===r.evaluationId)!;
  assert.equal(e.entryOffer,bookAsk);assert.equal(e.entryOffer,buffer>0?e.upOffer:e.downOffer);
  assert.equal(e.entryQuoteEvidence?.source,'KALSHI_PUBLIC_ORDERBOOK');assert.equal(e.evaluatedAt.getTime(),r.researchEvent!.eventAt.getTime());
  assert.equal(s.positions[0]!.entryBid,buffer>0?e.upBid:e.downBid);assert.equal(s.window.crossingConsumed,true);
  assert.ok(r.researchEvent?.prequalification);
  const receipt=await savePrequalificationPaperBook(r.researchEvent!);assert.equal(receipt?.status,'CAPTURED');assert.equal(f.calls(),1);
  const saved=(await db.select().from(forwardTestBookSnapshotTable).where(eq(forwardTestBookSnapshotTable.id,receipt!.id)))[0]!;
  assert.equal(saved.capacity?.observationPhase,'PRE_QUALIFICATION');assert.equal(saved.capacity?.sourceEvaluationId,r.evaluationId);
  assert.equal(saved.startedAt.getTime(),e.entryQuoteEvidence!.requestStartedAtMs);
  assert.equal((await readPaperBookCaptureCoverage(f.engineId)).proofOfActualExecution,false);
 });
}
test('missing detail ask repaired only by actual valid book, not by fallback',async()=>{
 const f=await fixture();await f.observe(-1);const r=await f.observe(10,{detailAsk:null,bookAsk:.51});
 assert.equal(r.error,null);assert.equal((await f.state()).positions[0]!.entryOffer,.51);assert.equal(f.calls(),1);
});
for(const [buffer,detailAsk,bookAsk] of [[10,.51,.65],[-25,.069,.60],[10,.52,.5201],[25,.53,.5301]] as const){
 test(`valid overpriced ${detailAsk}->${bookAsk} commits observation but never consumes or enters`,async()=>{
  const f=await fixture();await f.observe(buffer>0?-1:1);const r=await f.observe(buffer,{detailAsk,bookAsk});
  assert.equal(r.error,null);assert.equal(r.signal,'PASS');let s=await f.state();
  assert.equal(s.window.firstCrossOccurred,true);assert.equal(s.window.crossingConsumed,false);assert.equal(s.positions.length,0);
  assert.equal(s.evaluations.find(e=>e.id===r.evaluationId)!.qualifyingTrigger,false);assert.equal(f.calls(),1);
  await f.observe(buffer,{bookAsk:.40});s=await f.state();assert.equal(s.positions.length,0);assert.equal(f.calls(),1);
 });
}
test('failed book leaves BTC/window/claim unchanged and a fresh retry reads again',async()=>{
 const f=await fixture();await f.observe(-1);const before=await f.state();
 const r=await f.observe(10,{book:async()=>{throw Error('book_failed');}});assert.equal(r.error,'book_failed');
 const after=await f.state();assert.deepEqual(after.window,before.window);assert.equal(after.points.length,before.points.length);
 assert.equal(after.evaluations.length,before.evaluations.length);assert.equal(after.positions.length,0);
 assert.equal((await f.observe(10)).error,null);assert.equal(f.calls(),2);assert.equal((await f.state()).positions.length,1);
});
test('no provider await holds engine/window locks; changed preview fails final fence',async()=>{
 const f=await fixture();await f.observe(-1);let unlocked=false;
 const r=await f.observe(10,{book:async b=>{
  const c=await pool.connect();try{await c.query('BEGIN');
   await c.query('SELECT id FROM forward_test_engine WHERE id=$1 FOR UPDATE NOWAIT',[f.engineId]);
   await c.query('SELECT ticker FROM forward_test_windows WHERE ticker=$1 FOR UPDATE NOWAIT',[f.ticker]);
   unlocked=true;await c.query('UPDATE forward_test_windows SET previous_buffer=2 WHERE ticker=$1',[f.ticker]);await c.query('COMMIT');
  }finally{c.release();}return b;
 }});
 assert.equal(unlocked,true);assert.equal(r.error,'entry_book_preview_changed');assert.equal((await f.state()).positions.length,0);
});
test('late body, closing market and regressed final clock never create source or consume',async()=>{
 for(const mode of ['late','closed','regressed'] as const){
  const f=await fixture();await f.observe(-1);const before=await f.state();
  const r=await f.observe(10,{book:async(b,m)=>{
   if(mode==='closed')m.endsAt=new Date(b.requestStartedAtMs+1);
   return {...b,bodyCompletedAtMs:mode==='late'?b.requestStartedAtMs+5001:b.bodyCompletedAtMs};
  },clock:(at,done)=>done?(mode==='late'?at+5001:mode==='closed'?at+1:at-1):at});
  assert.ok(r.error);const after=await f.state();assert.equal(after.positions.length,0);assert.deepEqual(after.window,before.window);
  assert.equal(after.evaluations.length,before.evaluations.length);assert.equal(after.points.length,before.points.length);
 }
});
test('actual final transaction clock, not pre-read now, rejects expiry after successful body',async()=>{
 const f=await fixture();await f.observe(-1);const before=await f.state();let bodyDone=false,inFinal=false;
 const original=db.transaction;
 (db as any).transaction=async(...args:any[])=>{if(bodyDone)inFinal=true;return (original as any).apply(db,args);};
 try{const r=await f.observe(10,{book:async b=>{bodyDone=true;return b;},clock:at=>at+(inFinal?5001:0)});
  assert.equal(r.error,'entry_book_source_stale');assert.deepEqual((await f.state()).window,before.window);
  assert.equal((await f.state()).positions.length,0);
 }finally{db.transaction=original;}
});
test('open paper position and consumed flat window never read entry book and keep observations/exits',async()=>{
 const f=await fixture();await f.observe(-1);await f.observe(10);assert.equal(f.calls(),1);
 const forbidden=async()=>{throw Error('entry book must not be called');};
 const exit=await f.observe(-10,{book:forbidden});assert.equal(exit.error,null);assert.equal((await f.state()).positions[0]!.status,'CLOSED');
 const observed=await f.observe(10,{book:forbidden});assert.equal(observed.error,null);assert.ok(observed.evaluationId);
 assert.equal((await f.state()).positions.length,1);assert.equal(f.calls(),1);
});
test('no structural candidate / closed market has zero book reads',async()=>{
 const f=await fixture();for(const buffer of [-1,1,7,16,19])await f.observe(buffer);
 assert.equal(f.calls(),0);const r=await f.observe(-10,{market:{status:'closed'}});assert.ok(r.error);assert.equal(f.calls(),0);
});
test('shared real public transport cooldown suppresses candidate retry and genuine recross, without consumption',async()=>{
 const f=await fixture();await f.observe(-1);const original=globalThis.fetch;let gets=0;
 globalThis.fetch=(async input=>{gets++;const r=new Response('{}',{status:429,headers:{'Retry-After':'60'}});
  Object.defineProperty(r,'url',{value:String(input)});return r;}) as typeof fetch;
 try{
  const read=async()=>fetchKalshiPublicBook(f.ticker);
  assert.match((await f.observe(10,{book:read})).error!,/429/);
  assert.match((await f.observe(10,{book:read})).error!,/cooldown/);
  await f.observe(1); // nonqualifying crossing can be observed without consuming.
  assert.match((await f.observe(-10,{book:read})).error!,/cooldown/);
  assert.equal(gets,1);assert.equal((await f.state()).window.crossingConsumed,false);assert.equal((await f.state()).positions.length,0);
 }finally{globalThis.fetch=original;}
});
test('lease lost while book pending cannot commit; existing duplicate policy remains fenced',async()=>{
 const f=await fixture();await f.observe(-1);
 await assert.rejects(f.observe(10,{book:async b=>{await releaseWorkerLease(f.owner,f.lease.leaseEpoch,f.engineId);return b;}}),WorkerLeaseLostError);
 assert.equal((await f.state()).positions.length,0);
});

test('additive migration is required before runtime; absent-column failure rolls back every strategy write',async()=>{
 const f=await fixture();await f.observe(-1);const before=await f.state();
 await pool.query('ALTER TABLE forward_test_evaluations DROP COLUMN entry_quote_evidence');
 let result;
 try{result=await f.observe(10);}finally{
  const migration=readFileSync(resolve(process.cwd(),'../../sql/strata_forward_entry_book_quote.sql'),'utf8');
  await pool.query(migration);await pool.query(migration);
 }
 assert.ok(result?.error);const after=await f.state();assert.deepEqual(after.window,before.window);
 assert.equal(after.positions.length,0);assert.equal(after.evaluations.length,before.evaluations.length);
 assert.equal(after.points.length,before.points.length);assert.equal(after.evaluations[0]!.entryQuoteEvidence,null);
 assert.equal((await f.observe(10)).error,null);assert.equal((await f.state()).positions.length,1);
});
for(const [quantity,expected] of [[1000,true],[900,false],[999,false],[50,false],[1050,true]] as const){
 test(`same-price whole-contract paper capacity ${quantity}/100 has action eligibility ${expected}`,async()=>{
  const f=await fixture();await f.observe(-1);
  const r=await f.observe(10,{bookAsk:.5,book:async b=>({...b,noBids:[{priceTicks:5000,contractsHundredths:quantity}]})});
  assert.equal(r.error,null);assert.equal(r.signal,'SCOUT');const s=await f.state();
  const e=s.evaluations.find(x=>x.id===r.evaluationId)!;assert.equal(e.qualifyingTrigger,expected);
  assert.equal(s.window.crossingConsumed,expected);assert.equal(s.positions.length,expected?1:0);
  assert.equal(e.entryQuoteEvidence!.capacity.requestedContracts,10);
  assert.equal(e.entryQuoteEvidence!.capacity.modeledFilledContracts,Math.min(10,Math.floor(quantity/100)));
  if(!expected){assert.match(e.reason,/insufficient observed book capacity.*no paper fill/);assert.equal(e.entryOffer,null);
   assert.equal(s.positions.reduce((p,x)=>p+(x.pnl??0),0),0);
   await f.observe(10);assert.equal((await f.state()).positions.length,0);assert.equal(f.calls(),1);
  }
  const sizes=(await pool.query('SELECT pg_column_size(entry_quote_evidence) AS storage_bytes,octet_length(entry_quote_evidence::text) AS json_bytes FROM forward_test_evaluations WHERE id=$1',[e.id])).rows[0];
  assert.ok(sizes.storage_bytes<=2048);assert.ok(sizes.json_bytes<=2048);
  console.info('entry_quote_size',JSON.stringify({qualifying:expected,...sizes}));
 });
}
test('deeper more expensive quantity never raises the reference to make a paper fill',async()=>{
 const f=await fixture();await f.observe(-1);
 const r=await f.observe(10,{bookAsk:.5,book:async b=>({...b,noBids:[
  {priceTicks:5000,contractsHundredths:100},{priceTicks:4900,contractsHundredths:100000}]})});
 const s=await f.state(),e=s.evaluations.find(x=>x.id===r.evaluationId)!;
 assert.equal(e.signal,'SCOUT');assert.equal(e.qualifyingTrigger,false);assert.equal(s.positions.length,0);
 assert.equal(e.entryQuoteEvidence!.capacity.referencePriceTicks,5000);assert.equal(e.entryQuoteEvidence!.capacity.modeledFilledContracts,1);
});

test('final transaction rejects backward clock even above original observation timestamps',async()=>{
 const f=await fixture();await f.observe(-1);let bodyDone=false,inFinal=false;const original=db.transaction;
 (db as any).transaction=async(...args:any[])=>{if(bodyDone)inFinal=true;return (original as any).apply(db,args);};
 try{const r=await f.observe(10,{book:async b=>{bodyDone=true;return b;},clock:at=>at+(inFinal?10:20)});
  assert.equal(r.error,'entry_book_clock_regressed');assert.equal((await f.state()).positions.length,0);
 }finally{db.transaction=original;}
});


test('preview false but final structural candidate cannot fall back to detail offers',async()=>{
 const f=await fixture();await f.observe(1);const before=await f.state();let transactions=0;const original=db.transaction;
 (db as any).transaction=async(...args:any[])=>{
  if(++transactions===2)await pool.query('UPDATE forward_test_windows SET previous_buffer=-1 WHERE ticker=$1',[f.ticker]);
  return (original as any).apply(db,args);
 };
 try{const r=await f.observe(10);assert.equal(r.error,'entry_book_required_after_recheck');
  const after=await f.state();assert.equal(f.calls(),0);assert.equal(after.positions.length,0);
  assert.equal(after.evaluations.length,before.evaluations.length);assert.equal(after.points.length,before.points.length);
 }finally{db.transaction=original;}
});
