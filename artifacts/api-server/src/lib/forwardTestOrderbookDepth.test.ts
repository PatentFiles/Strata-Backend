import assert from "node:assert/strict";
import test from "node:test";
import {parseKalshiResearchOrderbook,simulateBookCapacity} from "./forwardTestOrderbookDepth";
const ticker="KXBTC15M-26OCT221530-30",start=1792700000000;
const book=()=>parseKalshiResearchOrderbook({orderbook_fp:{
 yes_dollars:[["0.3000","3.00"],["0.4000","1.00"]],
 no_dollars:[["0.4500","2.00"],["0.5000","3.00"],["0.5200","1.50"]],
}},ticker,start,start+80);

test("Kalshi returns bids only; buying YES consumes complementary NO bids from best ask up",()=>{
 const q=simulateBookCapacity(book(),"yes","buy",6,5500);
 assert.equal(q.modeledFilledContracts,6);
 // 1 at 0.48 + 3 at 0.50 + 2 at 0.55
 assert.equal(q.modeledCashMicros,"3080000");
 assert.equal(q.modeledAveragePriceTicks,5133);
 assert.equal(q.modeledUnfilledContracts,0);
 assert.equal(q.usedPriceLevels,3);
 assert.equal(q.interpretation,"BOOK_CAPACITY_ONLY_NOT_EXECUTION");
});
test("Sell YES consumes descending YES bids; zero and partial capacity remain explicit",()=>{
 const b=book();
 const p=simulateBookCapacity(b,"yes","sell",5,3000);
 assert.equal(p.modeledFilledContracts,4);
 assert.equal(p.modeledUnfilledContracts,1);
 assert.equal(p.modeledCashMicros,"1300000");
 const zero=simulateBookCapacity(b,"yes","sell",5,4100);
 assert.equal(zero.modeledFilledContracts,0);
 assert.equal(zero.modeledUnfilledContracts,5);
 const noBuy=simulateBookCapacity(b,"no","buy",4,7000);
 assert.equal(noBuy.modeledFilledContracts,4);
});
test("whole-contract capacity floors fractional levels; price-only cash budget limits size",()=>{
 const b=book();
 const p=simulateBookCapacity(b,"yes","buy",30,5500,1_000_000n);
 assert.equal(p.modeledFilledContracts,2);
 assert.equal(p.modeledUnfilledContracts,28);
});
test("malformed, missing, duplicate, stale and nonfixedpoint evidence fail closed",()=>{
 const wrong=[
  {orderbook_fp:{yes_dollars:[["0.3000","1.00"]]}},
  {orderbook_fp:{yes_dollars:[["0.3000","1.00"],["0.3000","2.00"]],no_dollars:[]}},
  {orderbook_fp:{yes_dollars:[["0.30","bad"]],no_dollars:[]}},
  {orderbook_fp:{yes_dollars:[[0.30,2]],no_dollars:[]}},
 ];
 for(const raw of wrong) assert.throws(()=>parseKalshiResearchOrderbook(raw,ticker,start,start+100));
 assert.throws(()=>parseKalshiResearchOrderbook({orderbook_fp:{yes_dollars:[],no_dollars:[]}},ticker,start,start+5001));
 assert.throws(()=>parseKalshiResearchOrderbook({orderbook_fp:{yes_dollars:[],no_dollars:[]}},"NOT-BTC",start,start));
 assert.throws(()=>simulateBookCapacity(book(),"yes","buy",0,10000));
});

test("research book reports provider429 and suppresses later public requests without stale fallback",async()=>{
 const {fetchKalshiPublicBook}=await import("./forwardTestOrderbookDepth");
 const original=globalThis.fetch;let sent=0;
 const originalWarn=console.warn;const logs:string[]=[];console.warn=(line)=>{logs.push(String(line));};
 globalThis.fetch=(async (input)=>{
  sent++;
  const response=new Response("{}",{status:429,headers:{"Retry-After":"60"}});
  Object.defineProperty(response,"url",{value:String(input)});
  return response;
 }) as typeof fetch;
 try{
  await assert.rejects(fetchKalshiPublicBook(ticker),/provider=kalshi endpoint=research_orderbook HTTP 429 retryAfterMs=60000/);
  await assert.rejects(fetchKalshiPublicBook(ticker),/provider=kalshi endpoint=research_orderbook cooldown/);
  assert.equal(sent,1);
  assert.equal(logs.length,2);
  const rows=logs.map(line=>JSON.parse(line));
  assert.deepEqual(rows.map(r=>r.occurrence),["provider_response","local_cooldown"]);
  assert.ok(rows.every(r=>r.endpoint==="research_orderbook"));
  const {db}=await import("@workspace/db");
  const {savePostActionPaperBook}=await import("./forwardTestBookCapture");
  const oldInsert=db.insert;let saved:any;
  (db as any).insert=()=>({values:(row:any)=>{saved=row;return {onConflictDoNothing:()=>({returning:async()=>[{id:row.id}]})};}});
  try{
    const receipt=await savePostActionPaperBook({positionId:"test",engineId:"test",marketTicker:ticker,
      phase:"ENTRY",direction:"UP",contracts:1,quotePrice:0.5,eventAt:new Date()});
    assert.equal(receipt?.status,"UNAVAILABLE");
    assert.equal(saved.errorCode,"research_book_unavailable");
    assert.equal(JSON.parse(logs.at(-1)!).occurrence,"local_cooldown");
    assert.equal(sent,1);
  }finally{db.insert=oldInsert;}
 }finally{globalThis.fetch=original;console.warn=originalWarn;}
});
