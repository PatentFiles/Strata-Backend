import test from 'node:test';
import assert from 'node:assert/strict';
import {CommittedPublicMetadataCoordinator,type MetadataPrefetchScope,type PreparedMetadataSource,type MetadataPhaseBinding} from './committedPublicMetadata';
const market='KXBTC15M-26NOV021145-00',event='KXBTC15M-26NOV021145';
const paths=[`/markets/${market}`,'/series/KXBTC15M','/series/fee_changes?series_ticker=KXBTC15M&show_historical=false',`/events/${event}`,`/events/fee_changes?event_ticker=${event}&limit=100`];
const bodies:Record<string,unknown>={[paths[0]!]:{market:{ticker:market,event_ticker:event,exchange_index:2}},[paths[1]!]:{series:{}},[paths[2]!]:{series_fee_change_arr:[]},[paths[3]!]:{event:{event_ticker:event}},[paths[4]!]:{event_fee_changes:[],cursor:''}};
const at=Date.parse('2026-11-02T21:00:00Z');
const scope:MetadataPrefetchScope={accountId:'account-a',ownerId:'owner-a',holderId:'holder-a',releaseSha:'a'.repeat(40),fence:'1',policyHash:'b'.repeat(64)};
const source:PreparedMetadataSource={evaluationId:'evaluation-a',marketTicker:market,evaluatedAtMs:at-100,btcProviderAgeMs:100,btcReceiveAgeMs:0,marketAgeMs:0};
const final:MetadataPhaseBinding={phase:'FINAL_MARKET',intentId:'intent-a'},wire:MetadataPhaseBinding={phase:'WIRE_FEE',intentId:'intent-a'};
const turn=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};};
const provider=(calls:string[]):typeof fetch=>(async(input,init)=>{const path=String(input).replace('https://external-api.kalshi.com/trade-api/v2','');calls.push(path);assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');assert.deepEqual(init?.headers,{Accept:'application/json'});assert.ok(Object.hasOwn(bodies,path));return Response.json(bodies[path]);}) as typeof fetch;

test('FINAL_MARKET and WIRE_FEE capture two independent five-GET scopes without a fabricated committed timestamp',async()=>{
 let now=at;const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>now,()=>now-at);
 const a=c.startPhase(scope,source,final)!;assert.ok(a);assert.equal(Object.hasOwn(a.source,'committedAtMs'),false);await a.drained;
 const consumed=a.consume(scope,source,final);await Promise.all(paths.map(consumed.read));const first=consumed.capture();assert.equal(calls.length,5);
 now+=200;assert.equal(c.startPhase(scope,source,wire),null);a.discard();
 const b=c.startPhase(scope,source,wire)!;assert.ok(b);await b.drained;const second=b.consume(scope,source,wire);await Promise.all(paths.map(second.read));const manifest=second.capture();
 assert.equal(calls.length,10);assert.deepEqual(calls.slice(0,5).sort(),calls.slice(5).sort());assert.ok(first.records.every(x=>x.capturedAtMs===at));assert.ok(manifest.records.every(x=>x.capturedAtMs===at+200));assert.notEqual(first,manifest);assert.deepEqual(a.source,source);assert.deepEqual(b.source,source);b.discard();
 assert.equal(c.startPhase(scope,source,final),null);assert.equal(c.startPhase(scope,source,wire),null);
});

test('phase, intent and every source/scope mismatch fail at consumption without replacement reads',async()=>{
 const cases:Array<{s?:Partial<MetadataPrefetchScope>;src?:Partial<PreparedMetadataSource>;binding?:MetadataPhaseBinding}>=[
  {binding:wire},{binding:{...final,intentId:'other-intent'}},
  ...[{accountId:'other'},{ownerId:'other'},{holderId:'other'},{releaseSha:'c'.repeat(40)},{fence:'2'},{policyHash:'c'.repeat(64)}].map(s=>({s})),
  ...[{evaluationId:'other'},{marketTicker:'KXBTC15M-OTHER'},{evaluatedAtMs:at},{btcProviderAgeMs:101},{btcReceiveAgeMs:1},{marketAgeMs:1}].map(src=>({src})),
 ];
 for(const change of cases){const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>at,()=>0),a=c.startPhase(scope,source,final)!;await a.drained;const p=a.consume({...scope,...change.s},{...source,...change.src},change.binding??final);await assert.rejects(p.read(paths[0]!),/scope_changed/);assert.equal(calls.length,5);assert.throws(()=>a.consume(scope,source,final),/already_consumed/);}
});

test('phase binding is copied and one-consumption only; PREPARE cannot consume a phase capability',async()=>{
 const c=new CommittedPublicMetadataCoordinator(provider([]),()=>at,()=>0),binding={...final};const a=c.startPhase(scope,source,binding)!;binding.phase='WIRE_FEE';await a.drained;await a.consume(scope,source,final).read(paths[0]!);assert.throws(()=>a.consume(scope,source,final),/already_consumed/);a.discard();
 const b=c.start(scope,{...source,committedAtMs:at,qualifyingTrigger:true})!;await b.drained;await assert.rejects(b.consume(scope,source,wire).read(paths[0]!),/scope_changed/);
});

test('same global request/account slots cover PREPARE and phases; cancelled ignored work cannot release early',async()=>{
 const response=deferred<Response>(),signals:AbortSignal[]=[];let calls=0;
 const f=(async(_input,init)=>{calls++;signals.push(init!.signal!);return response.promise;}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(f,()=>at,()=>0),a=c.start(scope,{...source,committedAtMs:at,qualifyingTrigger:true})!;
 const b=c.startPhase({...scope,accountId:'account-b'},source,final)!;await turn();assert.equal(c.diagnostics().activeRequests,3);assert.equal(c.diagnostics().accounts,2);
 assert.equal(c.startPhase(scope,source,wire),null);assert.equal(c.startPhase({...scope,accountId:'account-c'},source,wire),null);
 a.discard('entry_metadata_stopped');b.discard('entry_metadata_stopped');await turn();assert.equal(c.diagnostics().activeRequests,3);assert.ok(signals.every(s=>s.aborted));assert.equal(c.startPhase(scope,source,final),null);
 response.resolve(Response.json({}));await Promise.all([a.drained,b.drained]);await turn();assert.equal(calls,3);assert.equal(c.diagnostics().activeRequests,0);assert.equal(c.diagnostics().accounts,0);
});

test('body cancellation promises retain phase resource slots while consumers fail promptly',async()=>{
 const cancellation=deferred<void>();let cancels=0;
 const f=(async()=>new Response(new ReadableStream({cancel(){cancels++;return cancellation.promise;}}),{headers:{'content-type':'application/json'}})) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(f,()=>at,()=>0),a=c.startPhase(scope,source,final)!;await turn();a.discard('entry_metadata_stopped');await turn();
 await assert.rejects(a.consume(scope,source,final).read(paths[0]!),/stopped/);assert.equal(c.diagnostics().activeRequests,3);assert.equal(c.startPhase(scope,source,wire),null);assert.equal(cancels,3);
 cancellation.resolve();await a.drained;await turn();assert.equal(c.diagnostics().activeRequests,0);assert.equal(c.diagnostics().accounts,0);
});

test('429 is retained in its exact phase; no fallback or retry and later phase shares provider cooldown',async()=>{
 let calls=0;const f=(async()=>{calls++;return new Response('{}',{status:429,headers:{'content-type':'application/json','retry-after':'60'}});}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(f,()=>at,()=>0),a=c.startPhase(scope,source,final)!;await a.drained;const p=a.consume(scope,source,final);await assert.rejects(p.read(paths[0]!));await assert.rejects(p.read(paths[0]!));assert.equal(calls,3);a.discard();assert.equal(c.startPhase(scope,source,final),null);
 const b=c.startPhase(scope,source,wire)!;await b.drained;await assert.rejects(b.consume(scope,source,wire).read(paths[0]!));assert.equal(calls,3);b.discard();
});

test('invalid identities, future source and expired original source decline without requests',async()=>{
 const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>at,()=>0);
 for(const binding of [{phase:'prepare',intentId:'x'},{phase:'WIRE_FEE',intentId:''},{phase:'WIRE_FEE',intentId:'a'.repeat(129)}])assert.equal(c.startPhase(scope,source,binding as MetadataPhaseBinding),null);
 for(const patch of [{evaluatedAtMs:at+1},{evaluatedAtMs:at-5000},{btcProviderAgeMs:5000},{btcReceiveAgeMs:-1},{marketAgeMs:NaN}])assert.equal(c.startPhase(scope,{...source,...patch},final),null);
 assert.equal(calls.length,0);
});

test('wall-clock regression or monotonic expiry never restamps existing capture into validity',async()=>{
 for(const which of ['wall','monotonic']){let wall=at,mono=0;const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>wall,()=>mono),a=c.startPhase(scope,source,wire)!;await a.drained;const p=a.consume(scope,source,wire);const captured=p.capture();if(which==='wall')wall=at-1;else mono=5000;await assert.rejects(p.read(paths[0]!),/expired/);assert.ok(captured.records.every(x=>x.capturedAtMs===at));assert.equal(calls.length,5);}
});

test('phase monotonic clock must be finite/nonnegative initially and cannot become NaN after capture',async()=>{
 for(const mono of [NaN,Infinity,-1]){const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>at,()=>mono);assert.equal(c.startPhase(scope,source,final),null);assert.equal(calls.length,0);}
 let mono=0;const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>at,()=>mono),a=c.startPhase(scope,source,wire)!;await a.drained;const p=a.consume(scope,source,wire);mono=NaN;await assert.rejects(p.read(paths[0]!),/expired/);assert.equal(calls.length,5);
});
