import assert from "node:assert/strict";
import test from "node:test";
import {createPublicForwardTestFeeds} from "./forwardTestFeeds";
import {getSourceQuoteProvenance} from "./sourceQuoteProvenance";

const OPEN=Date.parse("2026-11-25T12:00:00Z"), TICKER="KXBTC15M-TEST-15", EVENT="KXBTC15M-TEST";
const market=()=>({ticker:TICKER,event_ticker:EVENT,exchange_index:2,status:"active",
 market_type:"binary",strike_type:"greater_or_equal",open_time:new Date(OPEN).toISOString(),
 close_time:new Date(OPEN+900_000).toISOString(),floor_strike:null as number|null,
 yes_ask_dollars:"0.4200",no_ask_dollars:"0.5900"});
const nested=()=>({event:{event_ticker:EVENT,series_ticker:"KXBTC15M",markets:[{
 ...market(),floor_strike:80_000,yes_ask_dollars:"0.9900",no_ask_dollars:"0.0200"}]}});
function fixture(opts:{disable?:boolean;market?:Record<string,unknown>;response?:unknown;
 age?:string;date?:string;advance?:number;code?:number}={}){
 let now=OPEN+2000, mono=2000;
 const calls:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push(url.pathname+url.search);
  assert.equal(url.hostname,"external-api.kalshi.com");
  assert.equal(init?.method,undefined);
  assert.equal(init?.credentials,"omit");
  if(url.pathname.endsWith("/markets"))return Response.json({markets:[market()]});
  if(url.pathname.includes("/events/")){
   assert.equal(url.searchParams.get("with_nested_markets"),"true");
   assert.equal(url.pathname.split("/").at(-1),EVENT);
   const advance=opts.advance??100;now+=advance;mono+=advance;
   return Response.json(opts.response??nested(),{status:opts.code??200,
    headers:{Date:opts.date??new Date(now).toUTCString(),Age:opts.age??"0","Retry-After":"3"}});
  }
  return Response.json({market:opts.market??market()});
 };
 const feeds=createPublicForwardTestFeeds(fetcher,()=>new Date(now),()=>mono,undefined,undefined,
  opts.disable?undefined:{rolloverEventStrike:"verified_recovery"});
 return {feeds,calls,advance:(steps:number)=>{now+=steps;mono+=steps}};
}
test("uses only matched nested-event strike and preserves exact quote, provenance and timestamp",async()=>{
 const f=fixture(),snapshot=await f.feeds.market();
 assert.equal(snapshot.target,80_000);assert.equal(snapshot.strikeSource,"kalshi_nested_event_metadata");
 assert.equal(snapshot.yesAsk,0.42);assert.equal(snapshot.noAsk,0.59);
 assert.equal(snapshot.fetchedAt.getTime(),OPEN+2000);
 assert.equal(getSourceQuoteProvenance(snapshot)?.parsedDetailReceivedAtMs,OPEN+2000);
 assert.equal(f.calls.length,3);
});
test("default off, valid exact strike and held reads never query nested event metadata",async()=>{
 const disabled=fixture({disable:true});assert.equal((await disabled.feeds.market()).target,null);assert.equal(disabled.calls.length,2);
 const exact=fixture({market:{...market(),floor_strike:81_000}});assert.equal((await exact.feeds.market()).target,81_000);assert.equal(exact.calls.length,2);
 const held=fixture();assert.equal((await held.feeds.market(TICKER)).target,null);assert.equal(held.calls.length,1);
});
test("does not repair malformed or contradictory exact metadata",async()=>{
 for(const change of [{floor_strike:"bad"},{floor_strike:0},{market_type:"scalar"},{exchange_index:0},
  {strike_type:"greater"},{event_ticker:"OTHER"},{cap_strike:80_000}]){
  const f=fixture({market:{...market(),...change}});assert.notEqual((await f.feeds.market()).strikeSource,"kalshi_nested_event_metadata");
  assert.equal(f.calls.length,2);
 }
});
test("rejects wrong scopes, duplicate markets, wrong forms, and unsupported nested fields",async()=>{
 const changes=[
  (x:ReturnType<typeof nested>)=>{x.event.event_ticker="KXBTC15M-WRONG"},
  (x:ReturnType<typeof nested>)=>{x.event.series_ticker="WRONG"},
  (x:ReturnType<typeof nested>)=>{x.event.markets.push(x.event.markets[0]!)},
  (x:ReturnType<typeof nested>)=>{x.event.markets[0]!.exchange_index=0},
  (x:ReturnType<typeof nested>)=>{x.event.markets[0]!.ticker="KXBTC15M-WRONG"},
  (x:ReturnType<typeof nested>)=>{x.event.markets[0]!.open_time=new Date(OPEN-900000).toISOString()},
  (x:ReturnType<typeof nested>)=>{x.event.markets[0]!.strike_type="between"},
  (x:ReturnType<typeof nested>)=>{Object.assign(x.event.markets[0]!,{cap_strike:80_500})},
  (x:ReturnType<typeof nested>)=>{Object.assign(x.event.markets[0]!,{floor_strike:"80000"})},
 ];
 for(const change of changes){const response=nested();change(response);const f=fixture({response});assert.equal((await f.feeds.market()).target,null);}
});
test("rejects stale headers, timeout, HTTP throttling and outside the rollover window",async()=>{
 for(const opts of [{age:"1"},{date:new Date(OPEN-1000).toUTCString()},{advance:751},{code:429}]){
  assert.equal((await fixture(opts).feeds.market()).target,null);
 }
 const f=fixture();f.advance(28_000);assert.equal((await f.feeds.market()).target,null);assert.equal(f.calls.length,2);
});
test("bounds repeated reads to 3 per window and 2500 ms spacing",async()=>{
 const f=fixture({response:{}});await f.feeds.market();await f.feeds.market();
 for(let i=0;i<6;i++){f.advance(2500);await f.feeds.market();}
 assert.equal(f.calls.filter(s=>s.includes("/events/")).length,3);
});
