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
