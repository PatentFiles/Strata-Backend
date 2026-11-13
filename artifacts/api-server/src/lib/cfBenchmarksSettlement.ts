/**
 * Read-only Kalshi KXBTC15M / CF Benchmarks settlement reference.
 *
 * Kalshi's authenticated cfbenchmarks_value WebSocket already publishes
 * last_60s_windowed_average_15min. That field is distinct from avg_60s_data
 * (a *trailing* rolling average) and from Coinbase spot.
 *
 * This module makes no network calls, receives no credentials, never writes
 * trading state, and NEVER authorizes a trade or settlement.
 */
export const BRTI_INDEX_ID = "BRTI" as const;
export const QUARTER_HOUR_MS = 15 * 60_000;
export const SETTLEMENT_WINDOW_MS = 60_000;
export type BrtiWindowFrame = {
  kind: "BRTI_FINAL_MINUTE_ESTIMATE";
  indexId: typeof BRTI_INDEX_ID;
  sourceTimestampMs: number;
  receivedAtMs: number;
  quarterCloseTimestampMs: number;
  windowSize: number;
  windowAverageUsd: string;
  currentIndexUsd: string;
  status: "PROVISIONAL" | "OBSERVED_60_TICKS_NOT_SETTLEMENT";
};
export type BrtiParseResult =
  | { ok: true; frame: BrtiWindowFrame }
  | { ok: false; reason: string };
export type BrtiInstantFrame={
  indexId:typeof BRTI_INDEX_ID;
  sourceTimestampMs:number;
  receivedAtMs:number;
  currentIndexUsd:string;
  settlementAuthority:false;
};
export type BrtiInstantParseResult=
  |{ok:true;tick:BrtiInstantFrame}
  |{ok:false;reason:string};

const record=(x:unknown):x is Record<string,unknown>=>Boolean(x)&&typeof x==="object"&&!Array.isArray(x);
function timestamp(n:unknown):number|null {
  return typeof n==="number"&&Number.isSafeInteger(n)&&n>0?n:null;
}
function decimal(n:unknown):string|null {
  if(typeof n!=="string"||n.length>36||!/^\d{1,12}(?:\.\d{1,12})?$/.test(n))return null;
  if(Number(n)<=0||!Number.isFinite(Number(n)))return null;
  return n;
}
/**
 * Current vendor BRTI spot index — available throughout the quarter-hour.
 * Never treat an instantaneous index as a 60-second settlement average.
 */
export function parseKalshiBrtiInstantFrame(
  input:unknown,
  receivedAtMs:number,
  maxFeedAgeMs=5000,
):BrtiInstantParseResult{
  const refuse=(reason:string):BrtiInstantParseResult=>({ok:false,reason});
  if(!record(input)||input.type!=="cfbenchmarks_value"||!record(input.msg))
    return refuse("not_cfbenchmarks_value");
  const msg=input.msg;
  if(msg.index_id!==BRTI_INDEX_ID)return refuse("wrong_cf_index");
  const received=timestamp(receivedAtMs);
  const ageLimit=timestamp(maxFeedAgeMs);
  if(received===null||ageLimit===null||ageLimit>60_000)
    return refuse("invalid_clock_or_freshness_limit");
  let raw:unknown;
  try{raw=typeof msg.data==="string"?JSON.parse(msg.data):null}catch{
    return refuse("invalid_cf_source_json");
  }
  if(!record(raw)||raw.id!==BRTI_INDEX_ID||raw.type!=="value")
    return refuse("unverified_cf_source_identity");
  const ts=timestamp(raw.time);
  const current=decimal(raw.value);
  if(ts===null||current===null)return refuse("invalid_cf_index_sample");
  if(ts>received+2000||received-ts>ageLimit)
    return refuse("cf_index_stale_or_future_dated");
  return {ok:true,tick:{indexId:BRTI_INDEX_ID,sourceTimestampMs:ts,
    receivedAtMs:received,currentIndexUsd:current,settlementAuthority:false}};
}
/**
 * Parses Kalshi's *authenticated upstream* WebSocket envelope.
 * Untrusted input never substitutes for signed provider provenance.
 * A count of 60 alone does not prove official settlement or price finality.
 */
export function parseKalshiBrtiQuarterHourFrame(
  input:unknown,
  receivedAtMs:number,
  maxFeedAgeMs=5000,
):BrtiParseResult {
  const refuse=(reason:string):BrtiParseResult=>({ok:false,reason});
  const instant=parseKalshiBrtiInstantFrame(input,receivedAtMs,maxFeedAgeMs);
  if(!instant.ok)return refuse(instant.reason);
  if(!record(input)||!record(input.msg))return refuse("not_cfbenchmarks_value");
  const msg=input.msg;
  const ts=instant.tick.sourceTimestampMs;
  const current=instant.tick.currentIndexUsd;
  const received=instant.tick.receivedAtMs;
  if(!record(msg.last_60s_windowed_average_15min))
    return refuse("outside_kalshi_quarter_final_minute");
  const win=msg.last_60s_windowed_average_15min;
  const mean=decimal(win.value);
  const count=win.window_size;
  const start=timestamp(win.window_start_ts_ms);
  const end=timestamp(win.window_end_ts_exclusive);
  if(mean===null||typeof count!=="number"||!Number.isInteger(count)||
     count<1||count>60||start===null||end===null||start>=end)
    return refuse("invalid_quarter_window");
  const quarterClose=Math.ceil(ts/QUARTER_HOUR_MS)*QUARTER_HOUR_MS;
  // Kalshi's 15m accumulator uses (quarterClose - 60s, quarterClose].
  if(ts<=quarterClose-SETTLEMENT_WINDOW_MS||ts>quarterClose)
    return refuse("source_tick_outside_final_minute");
  if(start<quarterClose-SETTLEMENT_WINDOW_MS||start>quarterClose||
     end>quarterClose+2000)
    return refuse("quarter_window_bounds_invalid");
  if(count===60&&ts<quarterClose)
    return refuse("premature_complete_quarter_window");
  return {ok:true,frame:{
    kind:"BRTI_FINAL_MINUTE_ESTIMATE",indexId:BRTI_INDEX_ID,
    sourceTimestampMs:ts,receivedAtMs:received,
    quarterCloseTimestampMs:quarterClose,windowSize:count,
    windowAverageUsd:mean,currentIndexUsd:current,
    status:count===60&&ts===quarterClose
      ?"OBSERVED_60_TICKS_NOT_SETTLEMENT":"PROVISIONAL",
  }};
}
export type BrtiComparison={
  marketTicker:string;
  referenceSource:"CF_BENCHMARKS_BRTI";
  settlementAuthority:false;
  sourcePriceType:"KALSHI_15M_FINAL_MINUTE_WINDOW_AVERAGE";
  status:BrtiWindowFrame["status"];
  marketTargetUsd:string;
  windowAverageUsd:string;
  windowSize:number;
  spreadToStrikeUsd:number;
  coinbaseBasisUsd:number|null;
  observedAtMs:number;
  quarterCloseTimestampMs:number;
};
/** Historical/current Kalshi strike is authoritative; not a Coinbase-derived strike. */
export function compareBrtiToKalshiStrike(
  frame:BrtiWindowFrame,
  market:{ticker:string;target:number;closeAtMs:number;coinbaseSpot?:number|null;
    /** No timestamp means Coinbase/BRTI basis is unverified, not zero. */
    coinbaseProviderTimestampMs?:number|null},
):BrtiComparison|null{
  if(!/^KXBTC15M[A-Za-z0-9._-]+$/.test(market.ticker)||
     !Number.isFinite(market.target)||market.target<=0||
     !Number.isSafeInteger(market.closeAtMs)||
     market.closeAtMs!==frame.quarterCloseTimestampMs) return null;
  const price=Number(frame.windowAverageUsd);
  const basis=market.coinbaseSpot;
  const aligned=typeof market.coinbaseProviderTimestampMs==="number"&&
    Number.isSafeInteger(market.coinbaseProviderTimestampMs)&&
    Math.abs(market.coinbaseProviderTimestampMs-frame.sourceTimestampMs)<=1200;
  return {
    marketTicker:market.ticker,referenceSource:"CF_BENCHMARKS_BRTI",
    settlementAuthority:false,
    sourcePriceType:"KALSHI_15M_FINAL_MINUTE_WINDOW_AVERAGE",
    status:frame.status,
    marketTargetUsd:market.target.toFixed(2),
    windowAverageUsd:frame.windowAverageUsd,
    windowSize:frame.windowSize,
    spreadToStrikeUsd:Math.round((price-market.target)*100)/100,
    coinbaseBasisUsd:aligned&&typeof basis==="number"&&Number.isFinite(basis)&&basis>0
      ?Math.round((basis-price)*100)/100:null,
    observedAtMs:frame.sourceTimestampMs,
    quarterCloseTimestampMs:frame.quarterCloseTimestampMs,
  };
}

/**
 * Optional independent tick-level cross-check for 60 *distinct* second buckets.
 * Never replaces Kalshi's directly published accumulated 15m window.
 * Rejects missing seconds, duplicates or out-of-window ticks instead of
 * interpolating, filling with Coinbase or asserting a settlement.
 */
export function independentlyAverageSixtyBrtiSeconds(
  samples:ReadonlyArray<{sourceTimestampMs:number;indexUsd:string}>,
  quarterCloseMs:number,
):{ok:true;meanUsd:string;count:60}|{ok:false;reason:string}{
  if(!Number.isSafeInteger(quarterCloseMs)||
     quarterCloseMs%QUARTER_HOUR_MS!==0)return {ok:false,reason:"not_quarter_close"};
  if(samples.length!==60)return {ok:false,reason:"not_sixty_samples"};
  const seconds=new Map<number,bigint>();
  for(const sample of samples){
    const ts=timestamp(sample.sourceTimestampMs);
    const price=decimal(sample.indexUsd);
    if(ts===null||price===null||ts<=quarterCloseMs-SETTLEMENT_WINDOW_MS||
       ts>quarterCloseMs)return {ok:false,reason:"sample_outside_exact_window"};
    // Source timestamps are indexed by the second ending at the source tick.
    const second=Math.ceil(ts/1000);
    if(seconds.has(second))return {ok:false,reason:"duplicate_second"};
    const [integer,fraction=""]=price.split(".");
    const scaled=BigInt(integer)*1_000_000_000_000n+
      BigInt((fraction+"000000000000").slice(0,12));
    seconds.set(second,scaled);
  }
  const finalSecond=quarterCloseMs/1000;
  for(let s=finalSecond-59;s<=finalSecond;s++)
    if(!seconds.has(s))return {ok:false,reason:"missing_second"};
  const total=[...seconds.values()].reduce((a,b)=>a+b,0n);
  const mean=(total+30n)/60n; // 12-decimal USD, half-up
  return {ok:true,meanUsd:`${mean/1_000_000_000_000n}.${(mean%1_000_000_000_000n).toString().padStart(12,"0")}`,count:60};
}
