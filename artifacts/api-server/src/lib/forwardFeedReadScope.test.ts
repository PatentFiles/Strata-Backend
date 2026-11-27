import test from "node:test";
import assert from "node:assert/strict";
import {readForwardCycleFeeds,feedAbortCause,FORWARD_FEED_DEADLINE_MS} from "./forwardFeedReadScope";
import {createPublicForwardTestFeeds,type ForwardTestFeeds} from "./forwardTestFeeds";
import {BtcFeedDiagnostics,type BtcFeedDiagnostic,type BtcReadTiming} from "./btcFeedDiagnostics";
import {producerDelayMs} from "./forwardTestCadence";
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const market={ticker:"KXBTC15M-TEST",target:100000};
const btc={price:100001,providerAt:new Date(),receivedAt:new Date()};
const make=(b:Function,m:Function)=>({btc:b,market:m} as unknown as ForwardTestFeeds);
function pending(signal:AbortSignal,done:()=>void=()=>{}) {
 return new Promise<never>((_,reject)=>{signal.addEventListener("abort",()=>{
  queueMicrotask(()=>{done();reject(signal.reason);});
 },{once:true});});
}
test("demonstration: old Promise.all returns while a sibling remains in flight",async()=>{
 const c=new AbortController();let settled=false;
 const sibling=pending(c.signal,()=>{settled=true;});
 await assert.rejects(Promise.all([Promise.reject(Error("market failed")),sibling]));
 assert.equal(settled,false);c.abort();await Promise.allSettled([sibling]);assert.equal(settled,true);
});
test("first feed failure cancels and settles sibling before returning, original error retained",async()=>{
 let settled=false,cause="";
 const feeds=make((signal:AbortSignal)=>{signal.addEventListener("abort",()=>{cause=feedAbortCause(signal);});
  return pending(signal,()=>{settled=true;});},()=>Promise.reject(Error("market failed")));
 await assert.rejects(readForwardCycleFeeds(feeds,undefined),/market failed/);
 assert.equal(settled,true);assert.equal(cause,"sibling_failure");
});
test("two deterministic8s timeouts then fresh recovery retain deadline and serialized retry floor",async()=>{
 assert.equal(FORWARD_FEED_DEADLINE_MS,8000);
 let active=0,maxActive=0,completed=0,attempt=0;
 const feeds=make((signal:AbortSignal)=>{
  attempt++;active++;maxActive=Math.max(maxActive,active);
  if(attempt<=2)return pending(signal,()=>{active--;});
  active--;return Promise.resolve(bc());
 },()=>Promise.resolve(market));
 function bc(){return {...btc,price:100123};}
 for(let i=0;i<2;i++){
  const deadline=new AbortController();
  const read=readForwardCycleFeeds(feeds,undefined,undefined,deadline.signal).then(x=>{completed++;return x;});
  await flush();deadline.abort(new DOMException("budget elapsed","TimeoutError"));
  await assert.rejects(read,{name:"TimeoutError"});
  assert.equal(active,0);assert.equal(completed,0);assert.equal(producerDelayMs(5000,8000),250);
 }
 const fresh=await readForwardCycleFeeds(feeds,undefined);completed++;
 assert.equal(fresh.btc.price,100123);assert.equal(completed,1);assert.equal(maxActive,1);
});
test("shutdown abort settles both readers and an already aborted scope starts no requests",async()=>{
 const parent=new AbortController();let settled=0,calls=0;
 const read=readForwardCycleFeeds(make((s:AbortSignal)=>{calls++;return pending(s,()=>settled++);},
 (s0:unknown,s:AbortSignal)=>{calls++;return pending(s,()=>settled++);}),undefined,parent.signal);
 await flush();parent.abort();await assert.rejects(read,{name:"ForwardFeedShutdown"});
 assert.equal(settled,2);assert.equal(calls,2);
 await assert.rejects(readForwardCycleFeeds(make(()=>{calls++;},()=>{calls++;}),undefined,parent.signal));
 assert.equal(calls,2);
});
test("owned-market read shares the same deadline; late resolved data cannot escape expired scope",async()=>{
 const deadline=new AbortController();let ownedSignal:AbortSignal|undefined;
 const feeds=make(()=>Promise.resolve(btc),(ticker:string|undefined,s:AbortSignal)=>{
  if(!ticker)return Promise.resolve(market);ownedSignal=s;return pending(s);
 });
 const read=readForwardCycleFeeds(feeds,"OWNED",undefined,deadline.signal);
 await flush();assert.ok(ownedSignal);deadline.abort(new DOMException("timeout","TimeoutError"));
 await assert.rejects(read,{name:"TimeoutError"});assert.equal(feedAbortCause(ownedSignal),"timeout");
 const expired=new AbortController();
 await assert.rejects(readForwardCycleFeeds(make(()=>{expired.abort(new DOMException("timeout","TimeoutError"));return btc;},()=>market),undefined,undefined,expired.signal));
});
test("held market remains readable when next-window discovery is unavailable",async()=>{
 const calls:Array<string|undefined>=[];
 const held={...market,ticker:"KXBTC15M-HELD",result:"yes",status:"settled"};
 const feeds=make(()=>Promise.resolve(btc),(ticker:string|undefined)=>{
  calls.push(ticker);
  if(!ticker)throw Error("Kalshi returned no current market");
  assert.equal(ticker,held.ticker);return Promise.resolve(held);
 });
 const result=await readForwardCycleFeeds(feeds,held.ticker);
 assert.equal(result.market,held);assert.deepEqual(calls,[held.ticker]);
});
test("held exact-read failure never falls back to a new current market",async()=>{
 const calls:Array<string|undefined>=[];
 const feeds=make(()=>Promise.resolve(btc),(ticker:string|undefined)=>{
  calls.push(ticker);if(ticker)throw Error("held market unavailable");return Promise.resolve(market);
 });
 await assert.rejects(readForwardCycleFeeds(feeds,"KXBTC15M-HELD"),/held market unavailable/);
 assert.deepEqual(calls,["KXBTC15M-HELD"]);
});
test("after the held position clears the next cycle resumes current-market discovery",async()=>{
 const calls:Array<string|undefined>=[];
 const feeds=make(()=>Promise.resolve(btc),(ticker:string|undefined)=>{
  calls.push(ticker);return Promise.resolve({...market,ticker:ticker??"KXBTC15M-NEW"});
 });
 assert.equal((await readForwardCycleFeeds(feeds,"KXBTC15M-HELD")).market.ticker,"KXBTC15M-HELD");
 assert.equal((await readForwardCycleFeeds(feeds,undefined)).market.ticker,"KXBTC15M-NEW");
 assert.deepEqual(calls,["KXBTC15M-HELD",undefined]);
});
test("BTC failure diagnostics include elapsed timeout cause; valid recovery emits once and failures are bounded",async()=>{
 let clock=0,calls=0;const events:BtcFeedDiagnostic[]=[];
 const fetcher=(async(_url:unknown,init:RequestInit)=>{calls++;
  if(calls<=2)return pending(init.signal as AbortSignal) as Promise<Response>;
  return new Response(JSON.stringify({price:"100123",time:new Date(clock).toISOString()}),{status:200,headers:{"content-type":"application/json"}});
 }) as typeof fetch;
 const api=createPublicForwardTestFeeds(fetcher,()=>new Date(clock),()=>clock,undefined,e=>events.push(e));
 for(let i=0;i<2;i++){
  const deadline=new AbortController();const read=readForwardCycleFeeds(make(api.btc,()=>market),undefined,undefined,deadline.signal);
  await flush();clock+=8000;deadline.abort(new DOMException("timeout","TimeoutError"));await assert.rejects(read);
  clock+=250;
 }
 assert.equal(events.length,1);assert.equal(events[0]!.elapsedMs,8000);assert.equal(events[0]!.abortCause,"timeout");
 assert.equal(events[0]!.phase,"fetch");assert.equal(events[0]!.deadlineMs,8000);
 const fresh=await readForwardCycleFeeds(make(api.btc,()=>market),undefined);
 assert.equal(fresh.btc.price,100123);assert.equal(events.length,2);
 assert.equal(events[1]!.event,"btc_feed_read_recovered");assert.equal(events[1]!.consecutiveFailures,2);
 await api.btc();assert.equal(events.length,2);
});
test("malformed BTC never reports recovery and diagnostic observer exceptions cannot block reads",async()=>{
 let clock=0;const events:BtcFeedDiagnostic[]=[];let valid=false;
 const api=createPublicForwardTestFeeds((async()=>new Response(JSON.stringify(valid?{price:"100000",time:new Date(clock).toISOString()}:{price:"bad"}),{headers:{"content-type":"application/json"}})) as typeof fetch,()=>new Date(clock),()=>clock,undefined,e=>events.push(e));
 await assert.rejects(api.btc());clock+=31000;await assert.rejects(api.btc());
 assert.equal(events.filter(x=>x.event==="btc_feed_read_recovered").length,0);
 valid=true;await api.btc();assert.equal(events.at(-1)!.event,"btc_feed_read_recovered");
 const d=new BtcFeedDiagnostics(()=>{throw Error("observer failed");});assert.doesNotThrow(()=>d.finish(d.begin(),false,null));
});

test("sampled direct BTC timing preserves the reader, signed ages and monotonic HTTP phases",async()=>{
 const start=Date.UTC(2026,10,27);
 for(const providerOffset of [-6500,300]){
  const run=async(enabled:boolean)=>{
   let wall=start,mono=0,calls=0;
   const events:BtcReadTiming[]=[];
   const fetcher:typeof fetch=async(url,init)=>{
    calls++;assert.equal(url,'https://api.exchange.coinbase.com/products/BTC-USD/ticker');
    assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    mono+=20;wall+=20;
    const response=new Response(null,{headers:{Age:'1','Cache-Control':'public,max-age=2','x-secret':'private'}});
    Object.defineProperty(response,'json',{value:async()=>{mono+=5;wall+=5;return {price:'100',time:new Date(start+providerOffset).toISOString(),secret:'private'};}});
    return response;
   };
   const feed=createPublicForwardTestFeeds(fetcher,()=>new Date(wall),()=>mono,undefined,undefined,
    enabled?{observeDirectBtcTiming:event=>{events.push(event);throw Error('ignored sink failure');}}:undefined);
   const result=await feed.btc();
   assert.equal(events.length,0);
   await new Promise<void>(resolve=>setImmediate(resolve));
   return {result,events,calls};
  };
  const plain=await run(false),timed=await run(true);
  assert.deepEqual(timed.result,plain.result);assert.equal(timed.calls,1);assert.equal(plain.calls,1);
  assert.deepEqual(timed.events,[{event:'direct_btc_read_timing',scope:'owned_direct_reader',provider:'coinbase',endpoint:'btc_ticker',
   reader:timed.events[0]!.reader,attempt:1,requestStartMs:start,receiptMs:start+25,ageAtRequestMs:-providerOffset,
   ageAtReceiptMs:25-providerOffset,headersMs:20,bodyMs:5,requestToBodyMs:25,httpAgeSeconds:1,cacheMaxAgeSeconds:2}]);
  assert.ok(timed.events[0]!.reader>0);
 }
});

test("BTC timing samples attempts sparsely and emits nothing for malformed or failed reads",async()=>{
 let count=0;const seen:number[]=[];
 const p=Date.UTC(2026,10,27);
 const feed=createPublicForwardTestFeeds(async()=>{count++;return new Response(JSON.stringify({price:'100',time:new Date(p).toISOString()}));},
  ()=>new Date(p),()=>100,undefined,undefined,{observeDirectBtcTiming:e=>seen.push(e.attempt)});
 for(let i=0;i<66;i++){await feed.btc();await new Promise<void>(r=>setImmediate(r));}
 assert.equal(count,66);assert.deepEqual(seen,[1,65]);
 for(const mode of ['http','json','timestamp','network']){
  const messages:string[]=[];
  for(const enabled of [false,true]){
   let reads=0,emits=0;
   const f=createPublicForwardTestFeeds(async()=>{reads++;if(mode==='network')throw Error('failure');
    if(mode==='http')return new Response(null,{status:429});
    return new Response(mode==='json'?'{':JSON.stringify({price:1,time:'invalid'}));},
    ()=>new Date(p),()=>100,undefined,undefined,enabled?{observeDirectBtcTiming:()=>{emits++;}}:undefined);
   await assert.rejects(f.btc(),(error:Error)=>{messages.push(error.message);return true;});
   await new Promise<void>(r=>setImmediate(r));assert.equal(reads,1);assert.equal(emits,0);
  }
  assert.equal(messages[0],messages[1]);
 }
});
