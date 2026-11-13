import test from "node:test";
import assert from "node:assert/strict";
import {createEntryMetadataSnapshot} from "./entryMetadataSnapshot";
import {gatherCompleteReadOnlyMarketEvidence} from "./gatherReadOnlyMarketEvidence";
import {probeCurrentKalshiFeeApi,KALSHI_API_ORIGIN} from "./twoSourceFeeEvidence";
import {verifyOwnedFeeMetadata} from "./ownedMarketFeeMetadata";
const market="KXBTC15M-26OCT310100-00",event="KXBTC15M-26OCT310100";
const at=Date.parse("2026-10-31T04:47:00Z"),end="2026-10-31T05:00:00Z";
const mp=`/markets/${market}`,ep=`/events/${event}`;
const sp="/series/KXBTC15M",sc="/series/fee_changes?series_ticker=KXBTC15M&show_historical=false";
const ec=`/events/fee_changes?event_ticker=${event}&limit=100`;
const listing="/markets?series_ticker=KXBTC15M&status=open&limit=100";
function fixture():Record<string,any>{return {
 [listing]:{markets:[{ticker:market,event_ticker:event,status:"active",close_time:end,exchange_index:2}],cursor:""},
 [mp]:{market:{ticker:market,event_ticker:event,exchange_index:2,status:"active",open_time:"2026-10-31T04:45:00Z",close_time:end,expiration_time:end,latest_expiration_time:end,expected_expiration_time:end}},
 [ep]:{event:{event_ticker:event,series_ticker:"KXBTC15M",exchange_index:2,fee_type_override:null,fee_multiplier_override:null}},
 [sp]:{series:{ticker:"KXBTC15M",exchange_index:2,fee_type:"quadratic",fee_multiplier:1}},
 [sc]:{series_fee_change_arr:[]},[ec]:{event_fee_changes:[],cursor:""},
 [`/markets/${market}/orderbook`]:{orderbook_fp:{}},
};}
function fetcher(pages:Record<string,unknown>,calls:string[]):typeof fetch {
 return (async(input,init)=>{const path=String(input).slice(KALSHI_API_ORIGIN.length);calls.push(path);
  assert.equal(init?.method,"GET");assert.equal(init?.redirect,"error");assert.equal(init?.cache,"no-store");
  assert.ok(path in pages,"unexpected request "+path);
  return Response.json(pages[path]);}) as typeof fetch;
}
async function bundle(shared:boolean,pages=fixture()){
 const calls:string[]=[];const fetchImpl=fetcher(pages,calls);
 const snapshot=createEntryMetadataSnapshot(market,fetchImpl);
 const read=shared?snapshot.read:async(path:string)=>await (await fetchImpl(KALSHI_API_ORIGIN+path,{method:"GET",redirect:"error",cache:"no-store"})).json();
 const result=await gatherCompleteReadOnlyMarketEvidence({market,verifyFee:async()=>{
  const proof=await probeCurrentKalshiFeeApi(fetchImpl,()=>at,market,shared?snapshot.read:undefined);
  if(!proof.ok)throw Error(proof.reason);
 },readBook:async()=>await (await fetchImpl(KALSHI_API_ORIGIN+`/markets/${market}/orderbook`,{method:"GET",redirect:"error",cache:"no-store"})).json(),readPublic:read});
 const proof=verifyOwnedFeeMetadata({marketTicker:market,...result,observedAtMs:at,nowMs:at+100});
 return {calls,result,proof};
}
test("actual fee probe and outer validator share five snapshots:11 to6 GETs without discovery listing, identical proof",async()=>{
 const old=await bundle(false),next=await bundle(true);
 assert.equal(old.calls.length,11);assert.equal(next.calls.length,6);
 assert.deepEqual(next.result,old.result);assert.deepEqual(next.proof,old.proof);assert.equal(next.proof.ok,true);
 for(const path of [mp,ep,sp,sc,ec])assert.equal(next.calls.filter(c=>c===path).length,1);
 assert.equal(next.calls.filter(c=>c===listing).length,0);
});
test("both validators still reject changed fees and incomplete event cursors",async()=>{
 for(const mutate of [(p:any)=>p[sp].series.fee_multiplier=2,(p:any)=>p[ec].cursor="more",(p:any)=>delete p[ec].cursor]){
  const pages=fixture();mutate(pages);await assert.rejects(bundle(true,pages));
  const proof=verifyOwnedFeeMetadata({marketTicker:market,marketPayload:pages[mp],seriesPayload:pages[sp],eventPayload:pages[ep],seriesChangesPayload:pages[sc],eventChangesPayload:pages[ec],observedAtMs:at,nowMs:at+100});
  assert.equal(proof.ok,false);
 }
});
test("same-invocation concurrent reads reuse immutable object; new prepare/final bundles fetch again",async()=>{
 const calls:string[]=[];const fetchImpl=fetcher(fixture(),calls);
 const one=createEntryMetadataSnapshot(market,fetchImpl),two=createEntryMetadataSnapshot(market,fetchImpl);
 const [a,b]=await Promise.all([one.read(mp),one.read(mp)]);assert.equal(a,b);assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.market));
 assert.throws(()=>{(a.market as any).ticker="OTHER";});
 await two.read(mp);assert.equal(calls.length,2);
});
test("unapproved routes/query variants never fetch; wrong exact event cannot expand key budget",async()=>{
 const calls:string[]=[];const snapshot=createEntryMetadataSnapshot(market,fetcher(fixture(),calls));
 for(const path of [listing,mp+"?x=1",sc+"&limit=100",ec+"&show_historical=false","https://evil.invalid","/markets/OTHER","/events/KXBTC15M-OTHER"])
  await assert.rejects(snapshot.read(path),/scope_invalid/);
 assert.deepEqual(calls,[mp]);
});
test("429 and rejected reads are shared failures with no per-invocation retry",async()=>{
 for(const mode of ["429","throw","json","type","size","redirect"]){
  let calls=0;let cancelled=0;
  const fetchImpl=(async()=>{calls++;if(mode==="throw")throw Error("secret failure");
   const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(mode==="json"?"{":'{"series":{}}'));c.close();},cancel(){cancelled++;}}),
    {status:mode==="429"?429:200,headers:{"content-type":mode==="type"?"text/plain":"application/json","content-length":mode==="size"?"256001":"0","retry-after":"60"}});
   if(mode==="redirect")Object.defineProperty(response,"url",{value:"https://evil.invalid"});return response;}) as typeof fetch;
  const snapshot=createEntryMetadataSnapshot(market,fetchImpl);
  await assert.rejects(snapshot.read(sp),/metadata_unavailable/);await assert.rejects(snapshot.read(sp),/metadata_unavailable/);
  assert.equal(calls,1,mode);
 }
});
test("header and streaming-body timeouts abort and fail closed without retries",async()=>{
 for(const mode of ["headers","body"]){let calls=0;let signal:AbortSignal|undefined;let cancelled=false;
  const fetchImpl=(async(_input,init)=>{calls++;signal=init?.signal as AbortSignal;
   if(mode==="headers")return new Promise<Response>((_resolve,reject)=>signal!.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));
   return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-type":"application/json"}});
  }) as typeof fetch;
  const snapshot=createEntryMetadataSnapshot(market,fetchImpl,{timeoutMs:5});
  await assert.rejects(snapshot.read(sp),/metadata_unavailable/);await assert.rejects(snapshot.read(sp),/metadata_unavailable/);
  assert.equal(calls,1);assert.equal(signal!.aborted,true);if(mode==="body")assert.equal(cancelled,true);
 }
});

test("streaming size limit cancels body even without content-length",async()=>{
 let cancelled=false,calls=0;
 const fetchImpl=(async()=>{calls++;return new Response(new ReadableStream({
  start(c){c.enqueue(new Uint8Array(256_001));},cancel(){cancelled=true;}
 }),{headers:{"content-type":"application/json"}});}) as typeof fetch;
 const snapshot=createEntryMetadataSnapshot(market,fetchImpl);
 await assert.rejects(snapshot.read(sp),/metadata_unavailable/);
 assert.equal(cancelled,true);await assert.rejects(snapshot.read(sp));assert.equal(calls,1);
});
test("late headers from an abort-ignoring adapter are cancelled without parsing or retry",async()=>{
 let resolve!:(r:Response)=>void;let cancelled=false;
 const fetchImpl=(()=>new Promise<Response>(r=>{resolve=r;})) as typeof fetch;
 const snapshot=createEntryMetadataSnapshot(market,fetchImpl,{timeoutMs:5});
 await assert.rejects(snapshot.read(sp),/metadata_unavailable/);
 resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-type":"application/json"}}));
 for(let i=0;i<10;i++)await Promise.resolve();assert.equal(cancelled,true);
 await assert.rejects(snapshot.read(sp),/metadata_unavailable/);
});

test("shared series failure fences fee-probe event waiters behind delayed market and drains invocation",async()=>{
 const pages=fixture(),calls:string[]=[];let finishMarket!:(response:Response)=>void;
 const delayed=new Promise<Response>(resolve=>{finishMarket=resolve;});
 const fetchImpl=(async(input)=>{
  const path=String(input).slice(KALSHI_API_ORIGIN.length);calls.push(path);
  if(path===mp)return delayed;if(path===sp)throw Error("series failed");
  return Response.json(pages[path]);
 }) as typeof fetch;
 const snapshot=createEntryMetadataSnapshot(market,fetchImpl);let finished=false;
 const run=gatherCompleteReadOnlyMarketEvidence({market,readBook:async()=>({}),readPublic:snapshot.read,
  verifyFee:async()=>{const proof=await probeCurrentKalshiFeeApi(fetchImpl,()=>at,market,snapshot.read);if(!proof.ok)throw Error(proof.reason);}});
 const checked=assert.rejects(run).then(()=>{finished=true;});
 for(let i=0;i<30;i++)await Promise.resolve();
 assert.equal(finished,false);assert.ok(!calls.includes(ep));assert.ok(!calls.includes(ec));
 finishMarket(Response.json(pages[mp]));await checked;
 const count=calls.length;for(let i=0;i<30;i++)await Promise.resolve();
 assert.equal(calls.length,count);assert.ok(!calls.includes(ep));assert.ok(!calls.includes(ec));
});

test("exact-target snapshots ignore unrelated stale/paginated discovery inventory",async()=>{
 const pages=fixture();pages[listing].cursor="next-page";
 pages[listing+"&cursor=next-page"]={markets:[],cursor:""};
 const next=await bundle(true,pages);assert.equal(next.proof.ok,true);assert.equal(next.calls.length,6);
 assert.equal(next.calls.filter(p=>p.startsWith("/markets?")).length,0);
});
