import test from 'node:test';
import assert from 'node:assert/strict';
import {runHeldExchangeLatencyProbe,startHeldExchangeLatencyProbe,heldSourceDecision,heldReceiptFetch} from './heldExchangeLatencyProbe';
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
 assert.doesNotMatch(JSON.stringify(f.values),/fixture-key|fixture-secret|balance_dollars/);
 for(const value of f.values){const row=value as {paths:unknown[];signedSnapshot:{cashMicros:string;historyCoverage:string}};
  assert.equal(row.paths.length,7);assert.equal(row.signedSnapshot.cashMicros,'25000000');
  assert.equal(row.signedSnapshot.historyCoverage,'INCOMPLETE_OR_UNOBSERVED');}
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

test('held freshness includes original feed age and never grants entry authority',()=>{
 const source={id:'evaluation',evaluatedAtMs:1000,qualifying:true,btcProviderAgeMs:950,btcReceiveAgeMs:0,marketAgeMs:0};
 const stale=heldSourceDecision(source,5632);
 assert.equal(stale.sourceToDecisionAgeMs,5582);assert.equal(stale.freshnessDecision,'STALE');
 assert.equal(stale.maxQuoteAgeMs,5000);assert.equal(stale.tradingEligible,false);
 const edge=heldSourceDecision(source,5050);
 assert.equal(edge.freshnessDecision,'FRESH');assert.equal(edge.tradingEligible,false);
 assert.equal(heldSourceDecision(source,5051).freshnessDecision,'STALE');
 assert.equal(heldSourceDecision({...source,btcReceiveAgeMs:-1},5050).freshnessDecision,'SOURCE_UNAVAILABLE');
 assert.equal(heldSourceDecision({...source,btcProviderAgeMs:NaN},5050).freshnessDecision,'SOURCE_UNAVAILABLE');
 assert.equal(heldSourceDecision(source,999).freshnessDecision,'SOURCE_UNAVAILABLE');
 assert.equal(heldSourceDecision(null,5050).sourceToDecisionAgeMs,null);
});
test('held receipt transport records status, body-inclusive duration and digest without raw data',async()=>{
 const receipts:unknown[]=[];let calls=0;
 const get=heldReceiptFetch(async()=>{calls++;return new Response('{"private":"not-for-logs"}',{status:200})},r=>receipts.push(r));
 const response=await get('https://external-api.kalshi.com/trade-api/v2/portfolio/balance?subaccount=1',{method:'GET'});
 assert.deepEqual(await response.json(),{private:'not-for-logs'});
 const r=receipts[0] as {httpStatus:number;providerRttMs:number;responseSha256:string};
 assert.equal(r.httpStatus,200);assert.ok(r.providerRttMs>=0);assert.match(r.responseSha256,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(receipts),/not-for-logs|subaccount/);
 await assert.rejects(()=>get('https://external-api.kalshi.com/trade-api/v2/portfolio/balance',{method:'POST'}));
 await assert.rejects(()=>get('https://external-api.kalshi.com/unknown',{method:'GET'}));assert.equal(calls,1);
});

test('historical 404 remains explicitly incomplete despite successful empty-current fallback',async()=>{
 const f=fixture();
 const paths=['/trade-api/v2/portfolio/balance','/trade-api/v2/portfolio/orders',
 '/trade-api/v2/historical/orders','/trade-api/v2/portfolio/fills','/trade-api/v2/historical/fills',
 '/trade-api/v2/portfolio/positions','/trade-api/v2/portfolio/settlements'];
 const receipts=(status:number)=>paths.map(path=>({path,httpStatus:path.includes('/historical/')?status:200,
  providerRttMs:1,responseSha256:'a'.repeat(64)}));
 await runHeldExchangeLatencyProbe(scope,{...f.deps,transportReceipts:()=>receipts(404),
  ledgerBalance:async()=>({cashMicros:'25000000',reservedMicros:'0'})});
 const row=f.values[0] as {signedSnapshot:{historyCoverage:string;cashMatchesLedger:boolean}};
 assert.equal(row.signedSnapshot.historyCoverage,'INCOMPLETE_OR_UNOBSERVED');assert.equal(row.signedSnapshot.cashMatchesLedger,true);
 const complete=fixture();await runHeldExchangeLatencyProbe(scope,{...complete.deps,transportReceipts:()=>receipts(200)});
 assert.equal((complete.values[0] as typeof row).signedSnapshot.historyCoverage,'ALL_REQUIRED_PATHS_SUCCEEDED');
});
