import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readOwnedKalshiFeeds,getOwnedProductionKalshiJson} from './personalExchangeRead';
import {KalshiApiError} from '../kalshiAccountClient';
import {historyLaneCredentialKey,inBoundedHistoryReadLane} from './boundedHistoryReadLane';
const paths=['/portfolio/balance','/portfolio/orders','/historical/orders','/portfolio/fills','/historical/fills','/portfolio/positions','/portfolio/settlements'].map(p=>'/trade-api/v2'+p);
const creds={keyId:'bounded-test',privateKey:'unused'},at=1793828749033,options={mode:'bounded_history_reads_v1'} as const;
const good=(p:string):any=>p===paths[0]?{subaccount:1,exchange_index:2,balance_dollars:'25.0000'}:{[p===paths[5]?'market_positions':p.split('/').at(-1)!]:[]};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise<void>(r=>setImmediate(r));
test('default serial route order and enabled complete proof preserve original observation clock',async()=>{
 for(const enabled of [false,true]){const calls:string[]=[];let active=0,peak=0;
 const result=await readOwnedKalshiFeeds(creds,at,async(_c,p,_q,_f,_h,_o,signal)=>{calls.push(p);active++;peak=Math.max(peak,active);await turn();active--;if(enabled)assert.ok(signal);return good(p);},enabled?options:undefined);
 assert.equal(result.ok,true);if(result.ok){assert.equal(result.observedAtMs,at);assert.equal(result.historicalCoverageComplete,true);}
 assert.equal(calls[0],paths[0]);assert.deepEqual([...calls].sort(),[...paths].sort());assert.equal(peak,enabled?2:1);if(!enabled)assert.deepEqual(calls,paths);
 }
});
test('invalid balance or initial429 launches no history',async()=>{
 for(const mode of ['429','scope','cash']){const calls:string[]=[];const result=await readOwnedKalshiFeeds(creds,at,async(_c,p)=>{calls.push(p);if(mode==='429')throw new KalshiApiError('HTTP_ERROR',429);return mode==='scope'?{...good(p),exchange_index:0}:{...good(p),balance_dollars:'bad'};},options);assert.equal(result.ok,false);assert.deepEqual(calls,[paths[0]]);}
});
for(const target of paths.slice(1))for(const second of [false,true])for(const failure of ['429','401','403','503','network','malformed','cycle','cap'])test(`bounded ${target} ${second?'later':'first'} ${failure}`,async()=>{
 const counts=new Map<string,number>();let aborted=false,afterAbort=0;
 const result=await readOwnedKalshiFeeds(creds,at,async(_c,p,_q,_f,_h,_o,signal)=>{
  if(aborted)afterAbort++;signal!.addEventListener('abort',()=>{aborted=true;},{once:true});const n=(counts.get(p)??0)+1;counts.set(p,n);await turn();
  if(p!==target)return good(p);
  if(second&&n===1)return {...good(p),cursor:'next'};
  if(failure==='malformed')return {...good(p),cursor:42};
  if(failure==='cycle')return {...good(p),cursor:'next'};
  if(failure==='cap')return {...good(p),cursor:'page'+n};
  if(failure==='network')throw new KalshiApiError('NETWORK_ERROR');
  throw new KalshiApiError('HTTP_ERROR',Number(failure));
 },options);
 assert.equal(result.ok,false);assert.equal(afterAbort,0);assert.ok((counts.get(target)??0)<=20);if(failure==='429'&&!result.ok)assert.equal(result.reason,'kalshi_read_rate_limited');
});
test('first429 drains abort-ignoring admitted sibling before returning, without masked failure',async()=>{
 const sibling=deferred(),started=deferred(),failed=deferred();let settled=false;const calls:string[]=[];
 const pending=readOwnedKalshiFeeds(creds,at,async(_c,p,_q,_f,_h,_o,signal)=>{
  calls.push(p);if(p===paths[1]){await started.promise;failed.resolve();throw new KalshiApiError('HTTP_ERROR',429);}
  if(p===paths[2]){started.resolve();await sibling.promise;assert.equal(signal!.aborted,true);}
  return good(p);
 },options).then(r=>{settled=true;return r;});
 await failed.promise;await turn();assert.equal(settled,false);assert.deepEqual(calls,paths.slice(0,3));sibling.resolve();assert.deepEqual(await pending,{ok:false,reason:'kalshi_read_rate_limited'});
});
test('external cancellation drains active work and never admits queued groups',async()=>{
 const controller=new AbortController(),release=deferred(),started=deferred();let active=0,settled=false;const calls:string[]=[];
 const pending=readOwnedKalshiFeeds(creds,at,async(_c,p,_q,_f,_h,_o,signal)=>{calls.push(p);if(p!==paths[0]){if(++active===2)started.resolve();await release.promise;assert.equal(signal!.aborted,true);}return good(p);},{...options,signal:controller.signal}).then(r=>{settled=true;return r;});
 await started.promise;controller.abort();await turn();assert.equal(settled,false);assert.deepEqual(calls,paths.slice(0,3));release.resolve();assert.deepEqual(await pending,{ok:false,reason:'kalshi_read_canceled'});
});
test('shared lane caps simultaneous same/different credential scans at two total GETs',async()=>{
 let active=0,peak=0;const scans=[creds,creds,{...creds,keyId:'different'}].map(c=>readOwnedKalshiFeeds(c,at,async(_c,p)=>{active++;peak=Math.max(peak,active);await turn();active--;return good(p);},options));
 assert.ok((await Promise.all(scans)).every(r=>r.ok));assert.equal(peak,2);
});
test('canceled queued scan never invokes signer or transport',async()=>{
 const a=deferred(),b=deferred(),started=deferred();let running=0;
 const op=(barrier:ReturnType<typeof deferred>)=>inBoundedHistoryReadLane(historyLaneCredentialKey('occupier'),new AbortController().signal,async()=>{if(++running===2)started.resolve();await barrier.promise;});
 const x=op(a),y=op(b);await started.promise;const controller=new AbortController();let calls=0;
 const scan=readOwnedKalshiFeeds(creds,at,async()=>{calls++;return {};},{...options,signal:controller.signal});controller.abort();assert.deepEqual(await scan,{ok:false,reason:'kalshi_read_canceled'});assert.equal(calls,0);a.resolve();b.resolve();await Promise.all([x,y]);
});
test('enabled pagination preserves every page and archive404 remains explicitly incomplete',async()=>{
 for(const missing of [false,true]){let pages=0;const row={order_id:'order',subaccount:1,exchange_index:2};
 const result=await readOwnedKalshiFeeds(creds,at,async(_c,p,q)=>{if(p===paths[1])return ++pages===1?{orders:[],cursor:'a b'}:{orders:missing?[]:[row]};if(p===paths[2]){if(missing)throw new KalshiApiError('HTTP_ERROR',404);return {orders:[row]};}return good(p);},options);
 assert.equal(result.ok,true);if(result.ok){assert.deepEqual(result.orders,missing?[]:[row]);assert.equal(result.historicalCoverageComplete,!missing);}assert.equal(pages,2);
 }
});
test('actual signed GET transport preserves host pair signal and all seven paths',async()=>{
 const key=generateKeyPairSync('rsa',{modulusLength:2048});const material={keyId:'synthetic-key',privateKey:key.privateKey.export({type:'pkcs1',format:'pem'}).toString()};const calls:string[]=[];
 const fetcher:typeof fetch=async(url,init)=>{const u=new URL(String(url));assert.equal(u.origin,'https://external-api.kalshi.com');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.ok(init?.signal);assert.ok((init!.headers as Record<string,string>)['KALSHI-ACCESS-SIGNATURE']);assert.equal(u.searchParams.get('subaccount'),'1');assert.equal(u.searchParams.get('exchange_index'),'2');calls.push(u.pathname);await turn();return Response.json(good(u.pathname));};
 const result=await readOwnedKalshiFeeds(material,at,(c,p,q,_f,_h,o,s)=>getOwnedProductionKalshiJson(c,p,q,fetcher,undefined,o,s),options);assert.equal(result.ok,true);assert.deepEqual(calls.slice().sort(),paths.slice().sort());
});

test('pre-aborted scan sends nothing',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 assert.deepEqual(await readOwnedKalshiFeeds(creds,at,async()=>{calls++;return {};},{...options,signal:controller.signal}),{ok:false,reason:'kalshi_read_canceled'});assert.equal(calls,0);
});
test('actual transport older success cannot clear a concurrently observed429 cooldown',async()=>{
 const {getScopedKalshiJson}=await import('../kalshiAccountClient');const key=generateKeyPairSync('rsa',{modulusLength:2048});
 const material={keyId:'cooldown-test',privateKey:key.privateKey.export({type:'pkcs1',format:'pem'}).toString()},first=deferred(),both=deferred();let calls=0;
 const fetcher:typeof fetch=async()=>{const n=++calls;if(n===1){await first.promise;return Response.json(good(paths[1]));}both.resolve();return new Response('{}',{status:429,headers:{'retry-after':'1'}});};
 const old=getScopedKalshiJson(material,paths[1],'?subaccount=1&exchange_index=2',fetcher,'https://external-api.kalshi.com');
 const limited=getScopedKalshiJson(material,paths[1],'?subaccount=1&exchange_index=2',fetcher,'https://external-api.kalshi.com');
 await both.promise;await assert.rejects(limited,(e:any)=>e instanceof KalshiApiError&&e.status===429);first.resolve();await old;
 await assert.rejects(getScopedKalshiJson(material,paths[1],'?subaccount=1&exchange_index=2',fetcher,'https://external-api.kalshi.com'),(e:any)=>e instanceof KalshiApiError&&e.status===429);assert.equal(calls,2);
});
test('supervisor composes held recovery abort and scan abort without replacing either',async()=>{
 const {readFileSync}=await import('node:fs');const source=readFileSync('src/lib/strata/personalExecutionSupervisor.ts','utf8');
 assert.ok(source.includes('abort&&signal?AbortSignal.any([abort,signal]):abort??signal'));
 for(const which of ['held','scan']){const held=new AbortController(),scan=new AbortController();const composed=AbortSignal.any([held.signal,scan.signal]);(which==='held'?held:scan).abort();assert.equal(composed.aborted,true);}
});

test('queue saturation refuses admission and aborted queue listeners are removed',async()=>{
 const {getEventListeners}=await import('node:events');const release=deferred(),started=deferred();let active=0;
 const occupier=()=>inBoundedHistoryReadLane('occupied',new AbortController().signal,async()=>{if(++active===2)started.resolve();await release.promise;});
 const a=occupier(),b=occupier();await started.promise;
 const controllers=Array.from({length:64},()=>new AbortController());let invoked=0;
 const queued=controllers.map(c=>inBoundedHistoryReadLane('queued',c.signal,async()=>{invoked++;}).catch(()=>undefined));
 const saturated=new AbortController();await assert.rejects(inBoundedHistoryReadLane('overflow',saturated.signal,async()=>{invoked++;}),/bounded_history_lane_busy/);
 assert.equal(getEventListeners(saturated.signal,'abort').length,0);
 for(const c of controllers)c.abort();await Promise.all(queued);assert.equal(invoked,0);
 for(const c of controllers)assert.equal(getEventListeners(c.signal,'abort').length,0);
 release.resolve();await Promise.all([a,b]);
 const admitted=new AbortController();await inBoundedHistoryReadLane('next',admitted.signal,async()=>undefined);assert.equal(getEventListeners(admitted.signal,'abort').length,0);
});
test('abort-ignoring last-page response cannot turn a canceled scan into success',async()=>{
 const controller=new AbortController(),last=deferred(),release=deferred();let settlementPages=0,finished=false;
 const scan=readOwnedKalshiFeeds(creds,at,async(_c,p)=>{if(p===paths[6]){if(++settlementPages===1)return {...good(p),cursor:'last'};last.resolve();await release.promise;}return good(p);},{...options,signal:controller.signal}).then(r=>{finished=true;return r;});
 await last.promise;controller.abort();await turn();assert.equal(finished,false);release.resolve();assert.deepEqual(await scan,{ok:false,reason:'kalshi_read_canceled'});assert.equal(settlementPages,2);
});

test('queued lane operations retain enqueue ALS invocation, not releasing job context',async()=>{
 const {AsyncLocalStorage}=await import('node:async_hooks');const context=new AsyncLocalStorage<string>();
 const release=deferred(),started=deferred();let running=0;
 const held=()=>inBoundedHistoryReadLane('context-a',new AbortController().signal,async()=>{if(++running===2)started.resolve();await release.promise;return context.getStore();});
 const first=context.run('first-scan',()=>[held(),held()]);await started.promise;
 const second=context.run('second-scan',()=>inBoundedHistoryReadLane('context-b',new AbortController().signal,async()=>context.getStore()));
 release.resolve();assert.deepEqual(await Promise.all(first),['first-scan','first-scan']);assert.equal(await second,'second-scan');
});

test('guarded experimental six shares global cap, preserves legacy two and runnable FIFO',async()=>{
 const {withMemberHistoryCredits}=await import('./kalshiMemberReadBudget');
 const prior={...process.env};process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';process.env.STRATA_MEMBER_BUDGET_OWNER_ID='11111111-1111-1111-1111-111111111111';process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID='account';process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID='22222222-2222-2222-2222-222222222222';
 const yes=async()=>({rows:[{admitted:true,binding_token:'row:restricted_execution'}]});
 const holds=Array.from({length:6},()=>deferred()),allStarted=deferred(),legacyStarted=deferred();let active=0,peak=0,starts=0;const order:string[]=[];
 const first=withMemberHistoryCredits('a'.repeat(64),new AbortController().signal,async()=>Promise.all(holds.map((hold,i)=>inBoundedHistoryReadLane('same',new AbortController().signal,async()=>{peak=Math.max(peak,++active);if(++starts===6)allStarted.resolve();await hold.promise;active--;return i;}))),yes);
 await allStarted.promise;assert.equal(active,6);
 const legacyHold=deferred();const legacy=inBoundedHistoryReadLane('same',new AbortController().signal,async()=>{order.push('legacy');peak=Math.max(peak,++active);legacyStarted.resolve();await legacyHold.promise;active--;});
 const next=withMemberHistoryCredits('a'.repeat(64),new AbortController().signal,async()=>Promise.all(Array.from({length:6},()=>inBoundedHistoryReadLane('same',new AbortController().signal,async()=>{order.push('experimental');peak=Math.max(peak,++active);await turn();active--;}))),yes);
 holds[0].resolve();await legacyStarted.promise;assert.equal(order[0],'legacy');assert.equal(active,6);legacyHold.resolve();holds.forEach(h=>h.resolve());await Promise.all([first,legacy,next]);assert.ok(peak<=6);assert.equal(active,0);
 // No prepaid context: enabled flag alone still grants only legacy two.
 let legacyActive=0,legacyPeak=0;await Promise.all(Array.from({length:8},()=>inBoundedHistoryReadLane('unprivileged',new AbortController().signal,async()=>{legacyPeak=Math.max(legacyPeak,++legacyActive);await turn();legacyActive--;})));assert.equal(legacyPeak,2);
 for(const key of ['STRATA_MEMBER_READ_BUDGET','STRATA_MEMBER_BUDGET_OWNER_ID','STRATA_MEMBER_BUDGET_ACCOUNT_ID','STRATA_MEMBER_BUDGET_CONNECTION_ID']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
});

test('queued prepaid jobs reject expired, closed, aborted and mode-drift contexts without fallback',async()=>{
 const {withMemberHistoryCredits}=await import('./kalshiMemberReadBudget');
 const prior={...process.env};process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';process.env.STRATA_MEMBER_BUDGET_OWNER_ID='11111111-1111-1111-1111-111111111111';process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID='account';process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID='22222222-2222-2222-2222-222222222222';
 const yes=async()=>({rows:[{admitted:true,binding_token:'row:restricted_execution'}]});
 for(const failure of ['expired','closed','aborted','aborted-different-signal','off','invalid']){
  process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';const release=deferred(),started=deferred();let starts=0,unexpected=0;
  const occupiers=withMemberHistoryCredits('a'.repeat(64),new AbortController().signal,async()=>Promise.all(Array.from({length:6},()=>inBoundedHistoryReadLane('occupier',new AbortController().signal,async()=>{if(++starts===6)started.resolve();await release.promise;}))),yes);await started.promise;
  const controller=new AbortController();let queued:Promise<unknown>[]=[];
  const batch=withMemberHistoryCredits('b'.repeat(64),controller.signal,async()=>{queued=Array.from({length:6},()=>inBoundedHistoryReadLane('queued',failure==='aborted-different-signal'?new AbortController().signal:controller.signal,async()=>{unexpected++;}));const drained=Promise.allSettled(queued);if(failure==='closed')return;return drained;},yes);
  await turn();if(failure==='closed')await batch;
  if(failure==='expired')await new Promise(r=>setTimeout(r,510));
  if(failure.startsWith('aborted'))controller.abort();
  if(failure==='off')process.env.STRATA_MEMBER_READ_BUDGET='off';
  if(failure==='invalid')process.env.STRATA_MEMBER_READ_BUDGET='invalid';
  release.resolve();await occupiers;await batch;const settled=await Promise.allSettled(queued);assert.equal(unexpected,0,failure);assert.ok(settled.every(r=>r.status==='rejected'),failure);
 }
 process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';
 await withMemberHistoryCredits('a'.repeat(64),new AbortController().signal,async()=>{const jobs=Array.from({length:7},()=>inBoundedHistoryReadLane('key',new AbortController().signal,async()=>turn()));const results=await Promise.allSettled(jobs);assert.equal(results.filter(r=>r.status==='rejected').length,1,'only six opaque permits issued');},yes);
 for(const key of ['STRATA_MEMBER_READ_BUDGET','STRATA_MEMBER_BUDGET_OWNER_ID','STRATA_MEMBER_BUDGET_ACCOUNT_ID','STRATA_MEMBER_BUDGET_CONNECTION_ID']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
});
