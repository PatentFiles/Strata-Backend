import test from "node:test";
import assert from "node:assert/strict";
import { gatherReadOnlyMarketEvidence } from "./gatherReadOnlyMarketEvidence";

test("fee, orderbook and official metadata reads start concurrently but all must finish",async()=>{
 const started:string[]=[];
 let finishFee!:()=>void, finishBook!:()=>void;
 const fee=new Promise<void>(resolve=>{finishFee=resolve;});
 const book=new Promise<string>(resolve=>{finishBook=()=>resolve("signed book");});
 let completed=false;
 const result=gatherReadOnlyMarketEvidence({
  verifyFee:()=>{started.push("fee");return fee;},
  readBook:()=>{started.push("book");return book;},
  readSeries:async()=>{started.push("series");return "series metadata";},
  readMarket:async()=>{started.push("market");return "exact market metadata";},
 }).then(x=>{completed=true;return x;});
 assert.deepEqual(started,["fee","book","series","market"]);
 await Promise.resolve();assert.equal(completed,false);
 finishBook();await Promise.resolve();assert.equal(completed,false);
 finishFee();
 assert.deepEqual(await result,{
  bookPayload:"signed book",seriesPayload:"series metadata",marketPayload:"exact market metadata",
 });
 assert.equal(completed,true);
});

test("failed authoritative fee review prevents market evidence admission",async()=>{
 let completed=false;
 await assert.rejects(
  gatherReadOnlyMarketEvidence({
   verifyFee:async()=>{throw Error("fee_review_unavailable");},
   readBook:async()=>({market:"KXBTC15M"}),
   readSeries:async()=>({series:"KXBTC15M"}),
   readMarket:async()=>({market:"KXBTC15M"}),
  }).then(()=>{completed=true;}),
  /fee_review_unavailable/,
 );
 assert.equal(completed,false);
});

test("missing signed book or exact market metadata is fail closed",async()=>{
 for(const failed of ["book","market"]){
  let completed=false;
  await assert.rejects(gatherReadOnlyMarketEvidence({
   verifyFee:async()=>{},
   readBook:async()=>{if(failed==="book")throw Error("book_unavailable");return "book";},
   readSeries:async()=> "series",
   readMarket:async()=>{if(failed==="market")throw Error("market_unavailable");return "market";},
  }).then(()=>{completed=true;}),/unavailable/);
  assert.equal(completed,false);
 }
});

import { gatherCompleteReadOnlyMarketEvidence } from "./gatherReadOnlyMarketEvidence";
const ticker="KXBTC15M-26OCT310100-00";
const event="KXBTC15M-26OCT310100";
const seriesPath="/series/KXBTC15M";
const marketPath=`/markets/${ticker}`;
const scPath="/series/fee_changes?series_ticker=KXBTC15M&show_historical=false";
const eventPath=`/events/${event}`;
const ecPath=`/events/fee_changes?event_ticker=${event}&limit=100`;
const keys=["fee","book",seriesPath,marketPath,scPath,eventPath,ecPath];
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

// Virtual durations are deterministic synthetic evidence, not provider RTTs.
async function simulate(legacy:boolean, durations:Record<string,number>, failed?:string, failure="read_error") {
 let clock=0;
 const called:{key:string;at:number}[]=[];
 const pending:{at:number;finish:()=>void}[]=[];
 const read=(key:string):Promise<any>=>{
  called.push({key,at:clock});
  return new Promise((resolve,reject)=>pending.push({at:clock+(durations[key]??100),finish:()=>{
   if(key===failed)reject(new Error(failure));
   else resolve(key===marketPath?{market:{ticker,event_ticker:event,exchange_index:2}}:key);
  }}));
 };
 const run=legacy ? (async()=>{
  const first=await gatherReadOnlyMarketEvidence({verifyFee:()=>read("fee"),readBook:()=>read("book"),readSeries:()=>read(seriesPath),readMarket:()=>read(marketPath)});
  const [eventPayload,seriesChangesPayload,eventChangesPayload]=await Promise.all([read(eventPath),read(scPath),read(ecPath)]);
  return {...first,eventPayload,seriesChangesPayload,eventChangesPayload};
 })() : gatherCompleteReadOnlyMarketEvidence({market:ticker,verifyFee:()=>read("fee"),readBook:()=>read("book"),readPublic:read});
 let result:any,error:unknown,finishedAt=-1;
 run.then(value=>{result=value;finishedAt=clock;},e=>{error=e;finishedAt=clock;});
 await flush();
 while(pending.length){
  pending.sort((a,b)=>a.at-b.at);clock=pending[0]!.at;
  const due=pending.filter(p=>p.at===clock);
  for(const item of due){pending.splice(pending.indexOf(item),1);item.finish();}
  await flush();
 }
 return {called,result,error,finishedAt};
}

test("DAG removes only unnecessary dependency waits with same seven bounded branches",async()=>{
 const cases:{name:string;durations:Record<string,number>;old:number;current:number}[]=[
  {name:"slow fee",durations:{fee:1000},old:1100,current:1000},
  {name:"slow book",durations:{book:800},old:900,current:800},
  {name:"slow market",durations:{[marketPath]:800},old:900,current:900},
  {name:"slow series changes",durations:{[scPath]:800},old:900,current:800},
  {name:"slow event",durations:{[eventPath]:800},old:900,current:900},
 ];
 for(const c of cases){
  const old=await simulate(true,c.durations),next=await simulate(false,c.durations);
  assert.equal(old.finishedAt,c.old,c.name);assert.equal(next.finishedAt,c.current,c.name);
  assert.deepEqual(next.result,old.result,c.name);
  assert.deepEqual(next.called.map(c=>c.key).sort(),[...keys].sort());
  assert.equal(next.called.find(c=>c.key===scPath)!.at,0);
  assert.equal(next.called.find(c=>c.key===eventPath)!.at,c.durations[marketPath]??100);
 }
});

test("all failures including 429 and abort remain fail closed without retry storms",async()=>{
 for(const failure of ["read_error","HTTP 429","AbortError"]){
  for(const key of keys){
   const old=await simulate(true,{},key,failure),next=await simulate(false,{},key,failure);
   assert.equal(old.result,undefined);assert.equal(next.result,undefined);
   assert.equal((next.error as Error).message,failure);
   assert.ok(next.called.length<=7);
   assert.equal(new Set(next.called.map(c=>c.key)).size,next.called.length);
   if(key===marketPath)assert.ok(!next.called.some(c=>c.key===eventPath||c.key===ecPath));
  }
 }
});

test("exact market identity is validated before either dependent event GET",async()=>{
 for(const bad of [null,[],{}, {market:{ticker:"OTHER",event_ticker:event,exchange_index:2}},
  {market:{ticker,event_ticker:"https://evil.invalid",exchange_index:2}},
  {market:{ticker,event_ticker:event,exchange_index:1}},
  {market:{ticker,event_ticker:event}}]){
  const calls:string[]=[];
  await assert.rejects(gatherCompleteReadOnlyMarketEvidence({market:ticker,
   verifyFee:async()=>{},readBook:async()=>"book",readPublic:async path=>{calls.push(path);return path===marketPath?bad:{};},
  }),/production_event_fee_evidence_unverified/);
  assert.ok(calls.every(path=>!path.startsWith("/events/")));
 }
});

test("every invocation rereads evidence; synchronous adapters fail closed",async()=>{
 const calls:string[]=[];
 const sources={market:ticker,verifyFee:async()=>{calls.push("fee");},readBook:async()=>{calls.push("book");return "book";},
  readPublic:async(path:string)=>{calls.push(path);return path===marketPath?{market:{ticker,event_ticker:event,exchange_index:2}}:{};}};
 await gatherCompleteReadOnlyMarketEvidence(sources);
 await gatherCompleteReadOnlyMarketEvidence(sources);
 assert.equal(calls.length,14);
 for(const key of keys)assert.equal(calls.filter(c=>c===key).length,2);
 await assert.rejects(gatherCompleteReadOnlyMarketEvidence({...sources,verifyFee:()=>{throw new Error("sync_error");}}),/sync_error/);
});

import {getMarketEvidenceReadTiming} from "./marketEvidenceReadTiming";
test("completed bundle carries all bounded measured reads without modifying payload serialization",async()=>{
 const result=await gatherCompleteReadOnlyMarketEvidence({market:ticker,verifyFee:async()=>{},readBook:async()=>"book",
  readPublic:async path=>path===marketPath?{market:{ticker,event_ticker:event,exchange_index:2}}:{} });
 const timing=getMarketEvidenceReadTiming(result)!;
 assert.deepEqual(Object.keys(timing.reads).sort(),["fee","book","market","series","seriesChanges","event","eventChanges"].sort());
 for(const read of Object.values(timing.reads)){
  assert.equal(read.outcome,"completed");assert.ok(read.elapsedMs!==null&&read.elapsedMs>=0);
  assert.ok(read.startOffsetMs!==null&&read.startOffsetMs>=0);
 }
 assert.ok(!JSON.stringify(result).includes("elapsedMs"));
 assert.equal(timing.semantics,"full_read_elapsed_including_local_work");
});

test("known fee failure fences late dependent fanout and drains started reads before returning",async()=>{
 let resolveMarket!:(v:unknown)=>void,resolveBook!:(v:string)=>void;
 const market=new Promise<unknown>(resolve=>{resolveMarket=resolve;});
 const book=new Promise<string>(resolve=>{resolveBook=resolve;});
 const calls:string[]=[];const error=Error("fee failed");let finished=false;
 const result=gatherCompleteReadOnlyMarketEvidence({market:ticker,verifyFee:async()=>{throw error;},
  readBook:()=>book,readPublic:async path=>{calls.push(path);return path===marketPath?market:{};}});
 const checked=assert.rejects(result,e=>e===error).then(()=>{finished=true;});
 await flush();assert.equal(finished,false);
 resolveMarket({market:{ticker,event_ticker:event,exchange_index:2}});
 await flush();assert.equal(finished,false);
 assert.ok(!calls.some(path=>path.startsWith("/events/")));
 resolveBook("book");await checked;await flush();
 assert.ok(!calls.some(path=>path.startsWith("/events/")));
});

test("failed event read drains the sibling event response before returning",async()=>{
 let finish!:(value:unknown)=>void;const changes=new Promise<unknown>(resolve=>{finish=resolve;});
 const calls:string[]=[];const error=Error("event failed");let finished=false;
 const result=gatherCompleteReadOnlyMarketEvidence({market:ticker,verifyFee:async()=>{},readBook:async()=>"book",
  readPublic:async path=>{calls.push(path);if(path===marketPath)return {market:{ticker,event_ticker:event,exchange_index:2}};
   if(path===eventPath)throw error;if(path===ecPath)return changes;return {};}});
 const checked=assert.rejects(result,e=>e===error).then(()=>{finished=true;});
 await flush();assert.equal(finished,false);assert.ok(calls.includes(ecPath));
 finish({event_fee_changes:[],cursor:""});await checked;
 const count=calls.length;await flush();assert.equal(calls.length,count);
});
