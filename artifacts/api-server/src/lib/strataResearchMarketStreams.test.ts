import test from "node:test";
import assert from "node:assert/strict";
import {MarketEventAgeWindow,SequencedKalshiBook,parseCoinbaseRealtimeTicker,evaluateTriangulatedMarket} from "./strataResearchMarketStreams";
const ticker="KXBTC15M-26OCT221530-30";
const marketId="9b0f6b43-5b68-4f9f-9f02-9a2d1b8ac1a1";
const now=Date.parse("2026-10-22T15:20:05.000Z");
const snap=(seq=4,clock=100)=>({type:"orderbook_snapshot",sid:7,seq,sending_ts_ms:now-30,
 msg:{market_ticker:ticker,market_id:marketId,clock,
 yes_dollars_fp:[["0.3800","8.00"]],no_dollars_fp:[["0.5000","4.00"],["0.5100","2.00"]] }});
const delta=(seq=5,clock=101,change="-2.00")=>({type:"orderbook_delta",sid:7,seq,sending_ts_ms:now+100,
 msg:{market_ticker:ticker,market_id:marketId,clock,side:"yes",price_dollars:"0.3800",delta_fp:change,ts_ms:now}});
test("snapshot, consecutive delta, same clock, and jumps in exchange clock are valid",()=>{
 const b=new SequencedKalshiBook(ticker);
 assert.equal(b.get(now).ready,false);
 assert.equal(b.ingest(snap(),now),true);
 assert.equal(b.get(now).yesAskTicks,4900);
 assert.equal(b.get(now).noAskTicks,6200);
 assert.equal(b.simulate("yes","buy",8,5100,now)?.modeledFilledContracts,6);
 assert.equal(b.ingest(delta(),now+130),true);
 assert.equal(b.get(now+150).yesBidContracts,6);
 assert.equal(b.ingest(delta(6,101,"-1.00"),now+160),true);
 assert.equal(b.ingest(delta(7,900,"-1.00"),now+170),true);
 assert.equal(b.get(now+200).yesBidContracts,4);
 assert.equal(b.get(now+7000).ready,false);
 assert.equal(b.simulate("yes","buy",1,5100,now+7000),null);
});
test("sequence gap, clock regression, wrong market ID and impossible quantity fail closed",()=>{
 for(const changed of [
  {...delta(6),seq:6},
  delta(5,90),
  {...delta(),msg:{...delta().msg,market_id:"wrong-market-id"}},
  delta(5,102,"-99.00"),
  {...delta(),msg:{...delta().msg,delta_fp:"nan"}},
 ]){
  const b=new SequencedKalshiBook(ticker);
  assert.equal(b.ingest(snap(),now),true);
  assert.equal(b.ingest(changed,now+130),false);
  assert.equal(b.get(now+150).ready,false);
  assert.equal(b.simulate("yes","sell",1,3800,now+150),null);
  assert.equal(b.ingest(snap(12,120),now+200),true); // authoritative snapshot repair
  assert.equal(b.get(now+201).ready,true);
 }
});
test("no snapshot, stale sending timestamp and malformed book do not produce liquidity",()=>{
 const b=new SequencedKalshiBook(ticker);
 assert.equal(b.ingest(delta(),now+100),false);
 assert.equal(b.ingest(snap(),now+8000),false);
 assert.equal(b.ingest({...snap(),msg:{...snap().msg,yes_dollars_fp:[["0.3800","1.00"],["0.3800","2.00"]]}},now),false);
 assert.equal(b.get(now).ready,false);
});
test("Coinbase real-time ticker validates product, clock, bid/ask and sequence",()=>{
 const raw={type:"ticker",product_id:"BTC-USD",sequence:100,
 time:new Date(now-120).toISOString(),price:"68501.50",
 best_bid:"68501.00",best_ask:"68502.00"};
 const tick=parseCoinbaseRealtimeTicker(raw,now);
 assert.ok(tick);
 assert.equal(tick?.priceUsd,68501.50);
 assert.equal(parseCoinbaseRealtimeTicker({...raw,product_id:"ETH-USD"},now),null);
 assert.equal(parseCoinbaseRealtimeTicker({...raw,best_bid:"68503.00"},now),null);
 assert.equal(parseCoinbaseRealtimeTicker({...raw,time:new Date(now-6000).toISOString()},now),null);
});
test("triangulation refuses to conflate spot correlation, liquidity, settlement or trade authorization",()=>{
 const b=new SequencedKalshiBook(ticker);b.ingest(snap(),now);
 const tickerQuote=parseCoinbaseRealtimeTicker({type:"ticker",product_id:"BTC-USD",
  sequence:10,time:new Date(now-200).toISOString(),
  price:"68501.50",best_bid:"68501.00",best_ask:"68502.00"},now)!;
 const index={indexUsd:"68500.50",sourceAtMs:now-150};
 const fresh=evaluateTriangulatedMarket(index,tickerQuote,b.get(now),now);
 assert.equal(fresh.sourcesFreshAndAligned,true);
 assert.equal(fresh.spotBasisUsd,1);
 assert.equal(fresh.exchangeFillVerified,false);
 assert.equal(fresh.tradingAuthority,false);
 assert.equal(fresh.settlementVerified,false);
 const stale=evaluateTriangulatedMarket(index,tickerQuote,b.get(now+10000),now+10000);
 assert.equal(stale.sourcesFreshAndAligned,false);
 assert.equal(stale.spotBasisUsd,null);
});

test("source event age sample window reports bounded median/p95/p99 and rejects invalid clocks",()=>{
 const ages=new MarketEventAgeWindow();
 assert.equal(ages.summary().samples,0);
 assert.equal(ages.observe(now+100,now),false);
 assert.equal(ages.observe(now,now+15000),false);
 for(let i=1;i<=300;i++)assert.equal(ages.observe(now,now+i),true);
 const stats=ages.summary();
 assert.equal(stats.samples,256);
 assert.equal(stats.lastMs,300);
 assert.ok(stats.medianMs!==null&&stats.p95Ms!==null&&stats.p99Ms!==null);
 assert.ok(stats.medianMs!<=stats.p95Ms!);
 assert.ok(stats.p95Ms!<=stats.p99Ms!);
 assert.ok(stats.p99Ms!<=300);
 assert.equal(stats.timeAuthority,"LOCAL_RECEIPT_MINUS_SOURCE_EVENT_CLOCK");
});
