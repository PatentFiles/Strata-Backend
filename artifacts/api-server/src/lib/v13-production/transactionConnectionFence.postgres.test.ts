import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {pool as importedPool} from '@workspace/db';
import {ProductionLedger} from './ledger';
import {createEntryWireClockFetch,isEntryWireClockRefusal} from '../strata/entryWireClock';
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),'explicit disposable database required');
after(()=>importedPool.end());
const Pool=importedPool.constructor as new(config:{connectionString:string;max:number})=>typeof importedPool;
const order='v13p-00000000-0000-0000-0000-000000000001';
const endpoint='https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders';
const init={method:'POST',body:JSON.stringify({reduce_only:false,client_order_id:order})};
for(const loss of ['terminate','graceful','success'] as const)test(`real native pg ${loss} at final verifier completion`,async()=>{
 const owner=new Pool({connectionString:url!,max:1});const control=new Pool({connectionString:url!,max:1});
 const tx=await owner.connect();const ended=new Promise<void>(resolve=>tx.once('end',()=>resolve()));let releases=0,releaseError:unknown;
 owner.on('release',(error,client)=>{assert.equal(client,tx);releases++;releaseError=error;});
 owner.on('error',()=>{});
 await tx.query('CREATE TEMP TABLE v13_production_account(id text); INSERT INTO v13_production_account VALUES (\'account\')');
 const pid=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 // Port does not wrap the Client or its query. The ledger owns native release.
 const ledger=new ProductionLedger({connect:async()=>tx} as never,'account');let clocks=0,posts=0;
 const wire=createEntryWireClockFetch(()=>ledger.assertFinalWireClock(),async()=>{posts++;return new Response('{}');});
 let captured:unknown;
 try{
  const operation=ledger.transaction(async()=>{
   ledger.setFinalWireClock(()=>{clocks++;});
   await (async()=>{
    // Successful final fee query's result delivery is intentionally held until
    // the driver has observed termination. No new runtime query is introduced.
    await tx.query('SELECT 1');
    if(loss==='terminate'){
     const seen=new Promise<void>(resolve=>tx.once('error',()=>resolve()));
     assert.equal((await control.query('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0].terminated,true);
     await seen;
    }else if(loss==='graceful'){await tx.end();}
    return {ok:true};
   })();
   try{await wire(endpoint,init);}catch(error){captured=error;throw error;}
  });
  if(loss==='success')await operation;else await assert.rejects(operation,error=>error===captured&&isEntryWireClockRefusal(error,order));
  assert.equal(posts,loss==='success'?1:0);assert.equal(clocks,loss==='success'?1:0);assert.equal(releases,1);
  assert.equal(Boolean(releaseError),loss!=='success');
  if(loss==='success'){
   const next=await owner.connect();assert.equal(next,tx);assert.equal(next.listenerCount('error'),0);
   next.release();
  }
 }finally{await owner.end();await control.end();await ended;}
 assert.equal(tx.listenerCount('end'),0);
});
