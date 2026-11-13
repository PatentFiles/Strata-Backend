import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {ProductionLedger} from './ledger';
import {transactionConnectionFence} from './transactionConnectionFence';
import {createEntryWireClockFetch,isEntryWireClockRefusal} from '../strata/entryWireClock';
class Client extends EventEmitter {
 _queryable=true;_ending=false;_ended=false;connection={stream:{destroyed:false}};
 sql:string[]=[];releases:unknown[]=[];failCommit:Error|null=null;failRollback:Error|null=null;failRelease:Error|null=null;
 onQuery:((sql:string)=>void)|null=null;
 async query(sql:string){this.sql.push(sql);this.onQuery?.(sql);if(sql==='COMMIT'&&this.failCommit)throw this.failCommit;if(sql==='ROLLBACK'&&this.failRollback)throw this.failRollback;return sql.startsWith('BEGIN;')?[{command:'BEGIN',rows:[]},{command:'SELECT',rows:[{id:'account'}]}]:{rows:[]};}
 release(error?:unknown){this.releases.push(error);if(error)this._ending=true;if(this.failRelease)throw this.failRelease;}
 end(){this._ended=true;this.emit('end');}
}
const fixture=()=>{const tx=new Client();const ledger=new ProductionLedger({connect:async()=>tx} as never,'account');return {tx,ledger};};
const order='v13p-00000000-0000-0000-0000-000000000001';
const init={method:'POST',body:JSON.stringify({reduce_only:false,client_order_id:order})};
const url='https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders';
for(const failure of ['error','end','ending','ended','not-queryable','socket'] as const)test(`known ${failure} refuses before original clock/raw POST`,async()=>{
 const {tx,ledger}=fixture();let clock=0,post=0;
 const wire=createEntryWireClockFetch(()=>ledger.assertFinalWireClock(),async()=>{post++;return new Response('{}');});
 await ledger.transaction(async()=>{
  ledger.setFinalWireClock(()=>{clock++;});
  // Models a completed final fee await, followed by an observed loss before
  // delivery of the verifier's successful result to the caller.
  await Promise.resolve();
  if(failure==='error')tx.emit('error',new Error('lost'));
  if(failure==='end')tx.end();if(failure==='ending')tx._ending=true;
  if(failure==='ended')tx._ended=true;if(failure==='not-queryable')tx._queryable=false;
  if(failure==='socket')tx.connection.stream.destroyed=true;
  assert.throws(()=>wire(url,init),e=>isEntryWireClockRefusal(e,order));
 }).then(()=>assert.fail('must not commit'),()=>{});
 assert.equal(clock,0);assert.equal(post,0);assert.equal(tx.sql.includes('COMMIT'),false);
 assert.equal(tx.releases.length,1);assert.ok(tx.releases[0]);tx.end();
 assert.equal(tx.listenerCount('error'),0);assert.equal(tx.listenerCount('end'),0);
});
test('success keeps exact SQL and original source clock LAST',async()=>{
 const {tx,ledger}=fixture();const events:string[]=[];
 const wire=createEntryWireClockFetch(()=>ledger.assertFinalWireClock(),async()=>{events.push('POST');return new Response('{}');});
 await ledger.transaction(async()=>{ledger.setFinalWireClock(()=>events.push('clock'));await wire(url,init);});
 assert.deepEqual(events,['clock','POST']);assert.deepEqual(tx.sql,["BEGIN; SELECT * FROM v13_production_account WHERE id='account' FOR UPDATE",'COMMIT']);
 assert.deepEqual(tx.releases,[undefined]);assert.equal(tx.listenerCount('error'),0);assert.equal(tx.listenerCount('end'),0);
});
for(const where of ['body','commit','rollback','release'] as const)test(`preserves initiating failure with ${where} failure`,async()=>{
 const {tx,ledger}=fixture();const original=new Error('original');
 if(where==='commit')tx.failCommit=original;
 if(where==='rollback')tx.failRollback=new Error('rollback');
 if(where==='release')tx.failRelease=new Error('release');
 await assert.rejects(ledger.transaction(async()=>{if(where!=='commit')throw original;}),e=>e===original);
 assert.equal(tx.releases.length,1);
 if(where==='commit'||where==='rollback')assert.ok(tx.releases[0]);
 tx.end();assert.equal(tx.listenerCount('error'),0);
});
test('release failure after commit is surfaced and retains error handling until end',async()=>{
 const {tx,ledger}=fixture();const error=new Error('release');tx.failRelease=error;
 await assert.rejects(ledger.transaction(async()=>1),e=>e===error);
 assert.equal(tx.releases.length,1);assert.equal(tx.listenerCount('error'),1);
 tx.emit('error',new Error('late close'));tx.end();assert.equal(tx.listenerCount('error'),0);
});
test('scope closed before COMMIT/ROLLBACK callback; late descendants cannot revive',async()=>{
 const {tx,ledger}=fixture();let late!:Promise<void>,go!:()=>void;const wait=new Promise<void>(resolve=>{go=resolve;});
 await ledger.transaction(async()=>{
  ledger.setFinalWireClock(()=>{});
  late=wait.then(()=>assert.throws(()=>ledger.assertFinalWireClock(),/clock_missing/));
  tx.onQuery=sql=>{if(sql==='COMMIT')assert.throws(()=>ledger.assertFinalWireClock(),/clock_missing/);};
 });
 tx.onQuery=null;
 await ledger.transaction(async()=>{ledger.setFinalWireClock(()=>{});go();await late;ledger.assertFinalWireClock();});
 assert.equal(tx.listenerCount('error'),0);
});
test('old listener closure cannot poison new checkout and old scope cannot resurrect',()=>{
 const tx=new Client();const first=transactionConnectionFence(tx as never);
 const stale=tx.listeners('error')[0]!;first.close();first.cleanup(false);
 const second=transactionConnectionFence(tx as never);stale();second.assertLive();
 assert.throws(()=>first.assertLive(),/connection_unavailable/);second.close();second.cleanup(false);
 assert.equal(tx.listenerCount('error'),0);
});
test('loss stays sticky even if native flags subsequently appear healthy',()=>{
 const tx=new Client();const fence=transactionConnectionFence(tx as never);
 tx.emit('error',Error('lost'));tx._queryable=true;tx._ending=false;tx._ended=false;
 assert.throws(()=>fence.assertLive(),/connection_unavailable/);fence.close();fence.cleanup(true);
 tx.emit('error',Error('late'));tx.end();assert.equal(tx.listenerCount('error'),0);
});
test('query-only fake ports preserve off-path transactions but refuse raw ENTRY',async()=>{
 const native=new Client();const tx={query:native.query.bind(native),release:native.release.bind(native)};
 const ledger=new ProductionLedger({connect:async()=>tx} as never,'account');
 await ledger.transaction(async()=>{ledger.setFinalWireClock(()=>{});assert.throws(()=>ledger.assertFinalWireClock(),/connection_unavailable/);});
 assert.deepEqual(native.releases,[undefined]);
});
test('event-only unknown topology also refuses ENTRY, not ordinary recovery',async()=>{
 const {tx,ledger}=fixture();delete (tx as Partial<Client>)._queryable;
 await ledger.transaction(async()=>{ledger.setFinalWireClock(()=>{});assert.throws(()=>ledger.assertFinalWireClock(),/connection_unavailable/);});
 assert.equal(tx.listenerCount('error'),0);
});
test('EXIT/read/cancellation transport does not require ENTRY clock',async()=>{
 let posts=0;const wire=createEntryWireClockFetch(()=>{throw Error('must_not_check');},async()=>{posts++;return new Response('{}');});
 await wire(url,{method:'POST',body:JSON.stringify({reduce_only:true})});await wire(url,{method:'GET'});await wire(url+'/id',{method:'DELETE'});assert.equal(posts,3);
});
test('successful pool release that starts destructive close retains listener through end',()=>{
 const tx=new Client();const fence=transactionConnectionFence(tx as never);fence.close();tx._ending=true;fence.cleanup(false);
 tx.emit('error',Error('late'));tx.end();assert.equal(tx.listenerCount('error'),0);assert.equal(tx.listenerCount('end'),0);
});
