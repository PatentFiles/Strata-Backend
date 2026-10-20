import test from "node:test";
import assert from "node:assert/strict";
import {
  QUARTER_HOUR_MS,
  parseKalshiBrtiQuarterHourFrame,
  compareBrtiToKalshiStrike,
  independentlyAverageSixtyBrtiSeconds,
} from "./cfBenchmarksSettlement";

const quarterClose=Date.parse("2026-10-20T20:30:00.000Z");
const tick=quarterClose-15_000;
const websocket=(options:{
  type?:string;index?:string;ts?:number;value?:string;mean?:string;
  count?:number;has15m?:boolean;start?:number;end?:number;
}={})=>({
  type:options.type??"cfbenchmarks_value",sid:1,seq:42,
  msg:{
    index_id:options.index??"BRTI",
    data:JSON.stringify({type:"value",id:options.index??"BRTI",time:options.ts??tick,value:options.value??"68312.34"}),
    avg_60s_data:{value:"70000.00",window_size:60},
    ...(options.has15m===false?{}:{last_60s_windowed_average_15min:{
      value:options.mean??"68311.25000000",
      window_size:options.count??45,
      window_start_ts_ms:options.start??quarterClose-59_000,
      window_end_ts_exclusive:options.end??(options.ts??tick),
    }}),
  },
});
test("uses Kalshi quarter-hour final-minute average, never generic trailing average",()=>{
  const result=parseKalshiBrtiQuarterHourFrame(websocket(),tick+120);
  assert.equal(result.ok,true);
  if(!result.ok)return;
  assert.equal(result.frame.windowAverageUsd,"68311.25000000");
  assert.equal(result.frame.windowSize,45);
  assert.equal(result.frame.quarterCloseTimestampMs,quarterClose);
  assert.equal(result.frame.status,"PROVISIONAL");
  const compare=compareBrtiToKalshiStrike(result.frame,{
    ticker:"KXBTC15M-26OCT202030-30",target:68310.75,closeAtMs:quarterClose,
    coinbaseSpot:68314.25,
  });
  assert.ok(compare);
  assert.equal(compare.settlementAuthority,false);
  assert.equal(compare.spreadToStrikeUsd,0.5);
  assert.equal(compare.coinbaseBasisUsd,3);
  assert.equal(compare.sourcePriceType,"KALSHI_15M_FINAL_MINUTE_WINDOW_AVERAGE");
});
test("never considers 60-sample window authoritative final Kalshi settlement",()=>{
  const result=parseKalshiBrtiQuarterHourFrame(websocket({ts:quarterClose,count:60,end:quarterClose}),quarterClose+60);
  assert.equal(result.ok,true);
  if(result.ok)assert.equal(result.frame.status,"OBSERVED_60_TICKS_NOT_SETTLEMENT");
});
test("rejects incomplete data outside final minute or wrong index",()=>{
  for(const example of [
    websocket({has15m:false}),websocket({index:"ETHUSD_RTI"}),
    websocket({type:"cfbenchmarks_value_5hz"}),
    websocket({ts:quarterClose-75_000}),
    websocket({count:61}),websocket({count:0}),websocket({mean:"NaN"}),
    websocket({count:60,ts:quarterClose-5000}),
    websocket({start:quarterClose-65_000}),
    websocket({end:quarterClose+50_000}),
  ]){
    assert.equal(parseKalshiBrtiQuarterHourFrame(example,tick+100).ok,false);
  }
});
test("rejects stale or future-dated source ticks",()=>{
  assert.equal(parseKalshiBrtiQuarterHourFrame(websocket(),tick+6_000).ok,false);
  assert.equal(parseKalshiBrtiQuarterHourFrame(websocket(),tick-4_000).ok,false);
});
test("never compares one market's BRTI final-minute estimate to a different contract",()=>{
  const result=parseKalshiBrtiQuarterHourFrame(websocket(),tick+100);
  assert.equal(result.ok,true);
  if(!result.ok)return;
  assert.equal(compareBrtiToKalshiStrike(result.frame,{
    ticker:"KXBTC15M-26OCT202015-15",target:68310.75,closeAtMs:quarterClose-QUARTER_HOUR_MS,
  }),null);
});
test("strict 60 second independent BRTI cross-check refuses gaps and duplicates",()=>{
  const ticks=Array.from({length:60},(_,i)=>({
    sourceTimestampMs:quarterClose-59_000+i*1000,
    indexUsd:"68311.250000",
  }));
  const complete=independentlyAverageSixtyBrtiSeconds(ticks,quarterClose);
  assert.deepEqual(complete,{ok:true,meanUsd:"68311.250000000000",count:60});
  assert.equal(independentlyAverageSixtyBrtiSeconds(ticks.slice(1),quarterClose).ok,false);
  assert.equal(independentlyAverageSixtyBrtiSeconds([...ticks.slice(0,59),ticks[58]!],quarterClose).ok,false);
  assert.equal(independentlyAverageSixtyBrtiSeconds(ticks,quarterClose-60000).ok,false);
});
test("invalid sources cannot cause order submission, authorization or settlement",()=>{
  const result=parseKalshiBrtiQuarterHourFrame(websocket(),tick+100);
  assert.equal(result.ok,true);
  if(result.ok){
    assert.equal("ordersSubmitted" in result.frame,false);
    assert.equal("tradeAuthorization" in result.frame,false);
    assert.equal("officialSettlementResult" in result.frame,false);
  }
});
