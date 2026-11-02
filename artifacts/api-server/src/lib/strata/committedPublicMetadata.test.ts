import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {CommittedPublicMetadataCoordinator,type MetadataPrefetchScope,type PreparedMetadataSource} from "./committedPublicMetadata";
import {createEntryMetadataSnapshot} from "./entryMetadataSnapshot";
import {gatherCompleteReadOnlyMarketEvidence} from "./gatherReadOnlyMarketEvidence";
import type {CommittedForwardSourceHint} from "../forwardTestSignalWake";
const market="KXBTC15M-26NOV021145-00",event="KXBTC15M-26NOV021145";
const mp=`/markets/${market}`,ep=`/events/${event}`,sp="/series/KXBTC15M";
const sc="/series/fee_changes?series_ticker=KXBTC15M&show_historical=false",ec=`/events/fee_changes?event_ticker=${event}&limit=100`;
const at=Date.parse("2026-11-02T11:31:00Z");
const pages:Record<string,unknown>={[mp]:{market:{ticker:market,event_ticker:event,exchange_index:2}},[ep]:{event:{event_ticker:event}},[sp]:{series:{}},[sc]:{series_fee_change_arr:[]},[ec]:{event_fee_changes:[],cursor:""}};
const scope:MetadataPrefetchScope={accountId:"account-a",ownerId:"owner-a",holderId:"holder-a",releaseSha:"a".repeat(40),fence:"1",policyHash:"b".repeat(64)};
const hint=(id="evaluation-a"):CommittedForwardSourceHint=>({evaluationId:id,marketTicker:market,evaluatedAtMs:at-100,committedAtMs:at,btcProviderAgeMs:100,btcReceiveAgeMs:0,marketAgeMs:0,qualifyingTrigger:true});
const source=(h=hint()):PreparedMetadataSource=>({...h});
const turn=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const deferred=<T>()=>{let resolve!:(x:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function provider(calls:string[],pause?:Promise<void>):typeof fetch{return (async(input,init)=>{const path=String(input).replace("https://external-api.kalshi.com/trade-api/v2","");calls.push(path);assert.ok(path in pages);assert.equal(init?.method,"GET");assert.equal(init?.credentials,"omit");assert.deepEqual(init?.headers,{Accept:"application/json"});if(pause)await pause;return Response.json(pages[path]);}) as typeof fetch;}
async function readFive(read:(path:string)=>Promise<unknown>){return Promise.all([mp,ep,sp,sc,ec].map(read));}

test("public reads overlap held reconciliation; exactly five unique GETs, original capture time/digests and no eligibility-clock reads",async()=>{
 let now=at,eligibilityReads=0,reconciled=false,signed=0;const eligibilityClock=()=>{eligibilityReads++;return now;};
 const calls:string[]=[],held=deferred<void>();const c=new CommittedPublicMetadataCoordinator(provider(calls),()=>now,()=>0);
 const a=c.start(scope,hint())!;
 const reconciliation=held.promise.then(()=>{reconciled=true;});
 await a.drained;assert.equal(reconciled,false);assert.equal(calls.length,5);assert.equal(new Set(calls).size,5);assert.equal(signed,0);
 now+=400;held.resolve();await reconciliation;
 const prepared=a.consume(scope,source());const result=await readFive(prepared.read);
 assert.equal(result.length,5);assert.equal(calls.length,5);assert.equal(eligibilityReads,0);void eligibilityClock;
 const manifest=prepared.capture();assert.equal(manifest.records.length,5);assert.ok(Object.isFrozen(manifest));
 for(const capture of manifest.records){assert.equal(capture.requestStartedAtMs,at);assert.equal(capture.capturedAtMs,at);assert.equal(capture.rawSha256,createHash("sha256").update(JSON.stringify(pages[capture.path])).digest("hex"));assert.equal(capture.normalizedSha256,capture.rawSha256);}
 assert.throws(()=>a.consume(scope,source()),/already_consumed/);a.discard();await a.drained;
});

test("same-market distinct evaluation is not suppressed; a source cannot start a second speculative attempt",async()=>{
 const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>at,()=>0);
 const a=c.start(scope,hint())!;assert.equal(c.start(scope,hint("different")),null);await a.drained;a.discard();
 assert.equal(c.start(scope,hint()),null);
 const b=c.start(scope,hint("different"))!;assert.ok(b);await b.drained;assert.equal(calls.length,10);b.discard();
});

test("all source/account/release/holder/fence/policy mismatches refuse without a replacement read",async()=>{
 for(const patch of [{accountId:"foreign"},{ownerId:"foreign"},{releaseSha:"c".repeat(40)},{holderId:"foreign"},{fence:"2"},{policyHash:"c".repeat(64)}]){
  const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>at,()=>0),a=c.start(scope,hint())!;await a.drained;
  await assert.rejects(a.consume({...scope,...patch},source()).read(mp),/scope_changed/);assert.equal(calls.length,5);
 }
 for(const patch of [{evaluationId:"other"},{marketTicker:"KXBTC15M-OTHER"},{evaluatedAtMs:at},{btcProviderAgeMs:0},{btcReceiveAgeMs:1},{marketAgeMs:1}]){
  const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>at,()=>0),a=c.start(scope,hint())!;await a.drained;
  await assert.rejects(a.consume(scope,{...source(),...patch}).read(mp),/scope_changed/);assert.equal(calls.length,5);
 }
});

test("global request and account budgets remain bounded while an adapter ignores cancellation; mandatory reads are independent",async()=>{
 const headers=deferred<Response>(),signals:AbortSignal[]=[],calls:string[]=[];
 const fetchImpl=(async(input,init)=>{calls.push(String(input));signals.push(init!.signal!);return headers.promise;}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0);
 const a=c.start(scope,hint())!,b=c.start({...scope,accountId:"account-b"},hint())!;
 await turn();assert.deepEqual(c.diagnostics(),{activeRequests:3,queuedRequests:3,accounts:2,seen:2});
 for(let n=0;n<100;n++)assert.equal(c.start({...scope,accountId:"extra-"+n},hint(String(n))),null);
 let signed=0;await (async()=>{signed++;})();assert.equal(signed,1);
 a.discard("entry_metadata_stopped");b.discard("entry_metadata_stopped");await turn();
 assert.equal(signals.every(s=>s.aborted),true);assert.equal(c.diagnostics().activeRequests,3);assert.equal(c.diagnostics().queuedRequests,0);assert.equal(c.diagnostics().accounts,1);
 let drained=false;void a.drained.then(()=>{drained=true;});await turn();assert.equal(drained,false);
 headers.resolve(Response.json({}));await Promise.all([a.drained,b.drained]);await turn();
 assert.equal(calls.length,3);assert.equal(c.diagnostics().activeRequests,0);assert.equal(c.diagnostics().accounts,0);
});

test("STOP cancels streaming bodies and does not abort a mandatory request signal",async()=>{
 const signals:AbortSignal[]=[],mandatory=new AbortController();let cancelled=0;
 const fetchImpl=(async(_input,init)=>{signals.push(init!.signal!);return new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{"content-type":"application/json"}});}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0),a=c.start(scope,hint())!;
 await turn();a.discard("entry_metadata_stopped");await a.drained;assert.equal(cancelled,3);assert.equal(signals.every(s=>s.aborted),true);assert.equal(mandatory.signal.aborted,false);
 await assert.rejects(a.consume(scope,source()).read(mp),/stopped/);
});

test("429 failure is retained, provider cooldown applies to later distinct sources, no retry or arbitrary event reads",async()=>{
 let calls=0;const fetchImpl=(async()=>{calls++;return new Response("{}",{status:429,headers:{"content-type":"application/json","retry-after":"60"}});}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0),a=c.start(scope,hint())!;await a.drained;
 const p=a.consume(scope,source());await assert.rejects(p.read(mp));await assert.rejects(p.read(mp));assert.equal(calls,3);a.discard();
 const b=c.start(scope,hint("other"))!;await b.drained;await assert.rejects(b.consume(scope,source(hint("other"))).read(mp));assert.equal(calls,3);b.discard();
});

test("effective original BTC age consumes the unchanged five-second budget and never refreshes at consumption",async()=>{
 let now=at;const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>now,()=>0);
 const a=c.start(scope,hint())!;await a.drained;now=at+4800;
 await assert.rejects(a.consume(scope,source()).read(mp),/expired/);assert.equal(calls.length,5);assert.equal(c.start(scope,hint()),null);
 for(const invalid of [{...hint(),qualifyingTrigger:false},{...hint(),marketTicker:"OTHER"},{...hint(),committedAtMs:at+1},{...hint(),evaluatedAtMs:at+1},{...hint(),btcProviderAgeMs:5000}])assert.equal(c.start({...scope,accountId:"next"},invalid as never),null);
});

test("final dispatch uses a wholly fresh invocation: no prefetch book, fee renewal, signed account or final read reuse",async()=>{
 const calls:string[]=[],fetchImpl=provider(calls),c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0),a=c.start(scope,hint())!;await a.drained;
 const initial=a.consume(scope,source());let book=0,fees=0;
 const gather=(read:(path:string)=>Promise<unknown>)=>gatherCompleteReadOnlyMarketEvidence({market,readPublic:read,readBook:async()=>{book++;return {};},verifyFee:async()=>{fees++;await readFive(read);}});
 await gather(initial.read);assert.equal(calls.length,5);assert.equal(book,1);assert.equal(fees,1);
 const final=createEntryMetadataSnapshot(market,fetchImpl);await gather(final.read);
 assert.equal(calls.length,10);assert.equal(book,2);assert.equal(fees,2);for(const path of [mp,ep,sp,sc,ec])assert.equal(calls.filter(p=>p===path).length,2);a.discard();
});

test("metadata timeout aborts all admitted requests and cannot spawn event requests later",async()=>{
 let calls=0;const fetchImpl=(async(_input,init)=>{calls++;return new Promise<Response>((_r,reject)=>init!.signal!.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0,{requests:3,accounts:2,seen:32,timeoutMs:5}),a=c.start(scope,hint())!;
 const keepAlive=setTimeout(()=>{},100);await assert.rejects(a.consume(scope,source()).read(mp),/expired/);await a.drained;clearTimeout(keepAlive);assert.equal(calls,3);assert.equal(c.diagnostics().activeRequests,0);
});

test("queued event work pauses when reconcile finishes and resumes only for exact prepare consumption",async()=>{
 const held=deferred<void>(),calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls,held.promise),()=>at,()=>0),a=c.start(scope,hint())!;
 await turn();assert.equal(calls.length,3);a.pause();held.resolve();await turn();assert.equal(calls.length,3);assert.equal(c.diagnostics().queuedRequests,2);
 const prepared=a.consume(scope,source());await readFive(prepared.read);assert.equal(calls.length,5);a.discard();await a.drained;
});

test("malformed/status/redirect/oversized responses are refusals and never unlock arbitrary events",async()=>{
 for(const mode of ["wrong-market","wrong-index","wrong-event","status","type","redirect","json","size"]){
  const calls:string[]=[];const f=(async(input)=>{const path=String(input).replace("https://external-api.kalshi.com/trade-api/v2","");calls.push(path);
   const payload=path===mp?{market:{ticker:mode==="wrong-market"?"KXBTC15M-OTHER":market,event_ticker:mode==="wrong-event"?"OTHER":event,exchange_index:mode==="wrong-index"?1:2}}:pages[path];
   const response=new Response(mode==="json"?"{":JSON.stringify(payload),{status:mode==="status"?503:200,headers:{"content-type":mode==="type"?"text/plain":"application/json",...(mode==="size"?{"content-length":"256001"}:{})}});
   if(mode==="redirect")Object.defineProperty(response,"url",{value:"https://evil.invalid"});return response;}) as typeof fetch;
  const c=new CommittedPublicMetadataCoordinator(f,()=>at,()=>0),a=c.start(scope,hint())!;await a.drained;
  const p=a.consume(scope,source());await assert.rejects(readFive(p.read),{name:"Error"},mode);assert.equal(calls.length,3,mode);a.discard();
 }
});

test("a successful exact-market response is not replaced by an unrelated later public failure",async()=>{
 const f=(async(input)=>{const path=String(input).replace("https://external-api.kalshi.com/trade-api/v2","");if(path===ep)throw Error("event_unavailable");return Response.json(pages[path]);}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(f,()=>at,()=>0),a=c.start(scope,hint())!;await a.drained;
 const p=a.consume(scope,source());assert.deepEqual(await p.read(mp),pages[mp]);await assert.rejects(p.read(ep));a.discard();
});

test("recorded 02:31 effective 6987ms age is still refused; original 1163ms BTC and 787ms commit clock cannot be restamped",async()=>{
 const evaluatedAt=Date.parse("2026-11-02T02:31:10.446Z");let now=evaluatedAt+787;
 const committed={...hint(),evaluatedAtMs:evaluatedAt,committedAtMs:now,btcProviderAgeMs:1163};
 const calls:string[]=[],c=new CommittedPublicMetadataCoordinator(provider(calls),()=>now,()=>0),a=c.start(scope,committed)!;
 await a.drained;assert.equal(calls.length,5);now=evaluatedAt+5824;
 assert.equal(now-committed.evaluatedAtMs+committed.btcProviderAgeMs,6987);
 await assert.rejects(a.consume(scope,source(committed)).read(mp),/expired/);
 assert.equal(a.source.evaluatedAtMs,evaluatedAt);assert.equal(a.source.btcProviderAgeMs,1163);assert.equal(a.source.committedAtMs,evaluatedAt+787);
 assert.equal(c.start(scope,committed),null);assert.equal(calls.length,5);
});

test("closed reads do not free budget while owned stream cancellation is unsettled",async()=>{
 const cleanup=deferred<void>();let calls=0,cancels=0;
 const fetchImpl=(async()=>{calls++;return new Response(new ReadableStream({cancel(){cancels++;return cleanup.promise;}}),{headers:{"content-type":"application/json"}});}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0),a=c.start(scope,hint())!;
 await turn();a.discard("entry_metadata_stopped");await turn();
 await assert.rejects(a.consume(scope,source()).read(mp),/stopped/);
 let drained=false;void a.drained.then(()=>{drained=true;});await turn();
 assert.equal(cancels,3);assert.equal(calls,3);assert.equal(drained,false);assert.equal(c.diagnostics().activeRequests,3);assert.equal(c.diagnostics().accounts,1);
 for(let n=0;n<100;n++)assert.equal(c.start(scope,hint("new-"+n)),null);
 assert.equal(calls,3);cleanup.resolve();await a.drained;await turn();
 assert.equal(c.diagnostics().activeRequests,0);assert.equal(c.diagnostics().accounts,0);
});

test("late headers retain every response-body cancellation slot until cancellation settles",async()=>{
 const headers:Array<ReturnType<typeof deferred<Response>>>=[],cleanup=deferred<void>();let cancels=0;
 const fetchImpl=(()=>{const d=deferred<Response>();headers.push(d);return d.promise;}) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0),a=c.start(scope,hint())!;
 await turn();assert.equal(headers.length,3);a.discard("entry_metadata_stopped");
 for(const h of headers)h.resolve(new Response(new ReadableStream({cancel(){cancels++;return cleanup.promise;}}),{headers:{"content-type":"application/json"}}));
 await turn();let drained=false;void a.drained.then(()=>{drained=true;});await turn();
 assert.equal(cancels,3);assert.equal(drained,false);assert.equal(c.diagnostics().activeRequests,3);assert.equal(c.diagnostics().accounts,1);
 cleanup.resolve();await a.drained;await turn();assert.equal(c.diagnostics().activeRequests,0);assert.equal(c.diagnostics().accounts,0);
});

test("provider refusal is reported without awaiting a slow body cancellation, but resources remain accounted",async()=>{
 const cleanup=deferred<void>();let cancels=0;
 const fetchImpl=(async()=>new Response(new ReadableStream({cancel(){cancels++;return cleanup.promise;}}),{status:503,headers:{"content-type":"application/json"}})) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0),a=c.start(scope,hint())!;
 await assert.rejects(a.consume(scope,source()).read(mp),/production_market_metadata_unavailable/);
 assert.equal(cancels,3);assert.equal(c.diagnostics().activeRequests,3);
 let drained=false;void a.drained.then(()=>{drained=true;});await turn();assert.equal(drained,false);
 a.discard();cleanup.resolve();await a.drained;await turn();assert.equal(c.diagnostics().activeRequests,0);
});
