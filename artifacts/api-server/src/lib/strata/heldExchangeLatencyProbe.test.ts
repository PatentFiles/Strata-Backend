import test from 'node:test';
import assert from 'node:assert/strict';
import {runHeldExchangeLatencyProbe,startHeldExchangeLatencyProbe} from './heldExchangeLatencyProbe';
const scope={ownerId:'11111111-1111-4111-8111-111111111111',
 accountId:'strata-account-'+ 'a'.repeat(24),expectedSha:'b'.repeat(40)};
function fixture(){
 let calls=0,saved=0,loaded=0,held=true;
 const values:unknown[]=[];
 const deps={sha:()=>scope.expectedSha,held:async()=>held,
  credentials:async()=>{loaded++;return {keyId:'fixture-key',privateKey:'fixture-secret'}},
  get:async(_c:unknown,path:string)=>{
   calls++;
   if(path.endsWith('/balance'))return {balance_dollars:'25.0000',subaccount:1,exchange_index:2};
   if(path.endsWith('/orders'))return {orders:[]};
   if(path.endsWith('/fills'))return {fills:[]};
   if(path.endsWith('/positions'))return {market_positions:[]};
   return {settlements:[]};
  },
  save:async(value:unknown)=>{saved++;values.push(value)},pause:async()=>{}};
 return {deps,values,get calls(){return calls},get loaded(){return loaded},get saved(){return saved},hold:(v:boolean)=>{held=v}};
}
test('held probe is opt-in, exact-SHA scoped, and does not load a signer while armed',async()=>{
 startHeldExchangeLatencyProbe({NODE_ENV:'production'});
 const f=fixture();
 assert.equal((await runHeldExchangeLatencyProbe({...scope,expectedSha:'c'.repeat(40)},f.deps)).ok,false);
 assert.equal(f.loaded,0);
 f.hold(false);
 assert.equal((await runHeldExchangeLatencyProbe(scope,f.deps)).ok,false);
 assert.equal(f.loaded,0);assert.equal(f.calls,0);
});
test('five sequential complete signed scans preserve per-path timing without response bodies or secrets',async()=>{
 const f=fixture();
 const result=await runHeldExchangeLatencyProbe(scope,f.deps);
 assert.equal(result.ok,true);assert.equal(result.samples,5);
 assert.equal(f.calls,35);assert.equal(f.saved,5);
 assert.doesNotMatch(JSON.stringify(f.values),/fixture-key|fixture-secret|balance_dollars|25000000/);
 for(const value of f.values){const row=value as {paths:unknown[]};assert.equal(row.paths.length,7)}
});
test('re-arming during a scan prevents its receipt and all subsequent samples',async()=>{
 const f=fixture(),get=f.deps.get;
 f.deps.get=async(c,path)=>{const row=await get(c,path);f.hold(false);return row};
 const result=await runHeldExchangeLatencyProbe(scope,f.deps);
 assert.equal(result.ok,false);assert.equal(f.saved,0);assert.equal(f.calls,7);
});
test('provider failure and malformed scope terminate without retrying or leaking errors',async()=>{
 const f=fixture();let calls=0;
 f.deps.get=async()=>{calls++;throw Error('fixture-secret https://secret.invalid')};
 const result=await runHeldExchangeLatencyProbe(scope,f.deps);
 assert.equal(result.ok,false);assert.equal(calls,1);assert.equal(f.saved,0);
 assert.doesNotMatch(JSON.stringify(result),/fixture-secret|secret.invalid/);
});
