/**
 * High-frequency CF Benchmarks BRTI reference, independent of the Kalshi
 * quarter-hour settlement window. Research-only: NO order authorization.
 *
 * Official source: cfbenchmarks_value_5hz on Kalshi authenticated WSS.
 * The raw upstream CF frame must agree with Kalshi's parsed price and time.
 */
export type FastBrtiTick={
 indexId:"BRTI";sourceTimestampMs:number;receivedAtMs:number;
 upstreamReceivedAtMs:number;valueUsd:string;
 source:"KALSHI_CF_BENCHMARKS_5HZ";settlementAuthority:false;tradingAuthority:false;
};
type Result={ok:true;tick:FastBrtiTick}|{ok:false;reason:string};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
function monetary(x:unknown):bigint|null{
 if(typeof x!=="string"||!/^\d{1,10}(?:\.\d{1,8})?$/.test(x))return null;
 const [units,frac=""]=x.split(".");
 const micro=BigInt(units!)*100_000_000n+BigInt(frac.padEnd(8,"0"));
 return micro>0n?micro:null;
}
export function parseKalshiFastBrtiTick(
 frame:unknown,receivedAtMs:number,maxAgeMs=3000,
):Result{
 const reject=(reason:string):Result=>({ok:false,reason});
 if(!object(frame)||frame.type!=="cfbenchmarks_value_5hz"||!object(frame.msg))
  return reject("not_fast_cf_value");
 const msg=frame.msg;
 if(msg.index_id!=="BRTI")return reject("wrong_index");
 if(!Number.isSafeInteger(receivedAtMs)||receivedAtMs<=0||
    !Number.isSafeInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>10_000)
  return reject("invalid_clock");
 const source=msg.source_ts_ms,upstream=msg.received_at;
 if(typeof source!=="number"||!Number.isSafeInteger(source)||source<=0||
    typeof upstream!=="number"||!Number.isSafeInteger(upstream)||upstream<=0)
  return reject("invalid_provider_time");
 if(source>upstream+2000||upstream>receivedAtMs+2000||
    source>receivedAtMs+2000||receivedAtMs-source>maxAgeMs)
  return reject("fast_source_stale_or_future");
 let raw:unknown;
 try{raw=typeof msg.data==="string"&&msg.data.length<8192?JSON.parse(msg.data):null}
 catch{return reject("invalid_raw_cf_payload");}
 if(!object(raw)||raw.id!=="BRTI"||raw.type!=="value"||raw.time!==source)
  return reject("upstream_source_identity_or_time_mismatch");
 const upstreamPrice=monetary(raw.value),publishedPrice=monetary(msg.value_usd);
 if(upstreamPrice===null||publishedPrice===null||upstreamPrice!==publishedPrice)
  return reject("upstream_published_price_mismatch");
 return {ok:true,tick:{
  indexId:"BRTI",sourceTimestampMs:source,receivedAtMs,
  upstreamReceivedAtMs:upstream,valueUsd:msg.value_usd as string,
  source:"KALSHI_CF_BENCHMARKS_5HZ",
  settlementAuthority:false,tradingAuthority:false,
 }};
}
export type ReferenceBasis={
 code:"SYNCHRONIZED_RESEARCH_REFERENCE"|"UNVERIFIED_TEMPORAL_ALIGNMENT";
 readyForExecution:false;
 settlementAuthority:false;
 source:"CF_BENCHMARKS_BRTI_5HZ_VS_COINBASE";
 basisUsd:number|null;
 timestampSkewMs:number|null;
 reason:string;
};
export function compareFastBrtiCoinbase(
 tick:FastBrtiTick|null,coinbase:{
 price:number;providerTimestampMs:number;receivedAtMs:number;
 }|null,nowMs:number,maxSkewMs=1200,
):ReferenceBasis{
 const reject=(reason:string,skew:number|null=null):ReferenceBasis=>({
  code:"UNVERIFIED_TEMPORAL_ALIGNMENT",readyForExecution:false,
  settlementAuthority:false,source:"CF_BENCHMARKS_BRTI_5HZ_VS_COINBASE",
  basisUsd:null,timestampSkewMs:skew,reason,
 });
 if(!tick||!coinbase||!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(maxSkewMs)||
    maxSkewMs<0||maxSkewMs>5000)return reject("missing_or_invalid_reference");
 if(!Number.isFinite(coinbase.price)||coinbase.price<=0||
    !Number.isSafeInteger(coinbase.providerTimestampMs)||!Number.isSafeInteger(coinbase.receivedAtMs))
   return reject("coinbase_quote_invalid");
 const skew=Math.abs(coinbase.providerTimestampMs-tick.sourceTimestampMs);
 if(skew>maxSkewMs)return reject("providers_not_time_aligned",skew);
 if(nowMs-tick.sourceTimestampMs>3000||nowMs-coinbase.providerTimestampMs>3000||
    coinbase.providerTimestampMs>nowMs+2000||tick.sourceTimestampMs>nowMs+2000)
   return reject("reference_stale_or_future",skew);
 return {
  code:"SYNCHRONIZED_RESEARCH_REFERENCE",
  readyForExecution:false,settlementAuthority:false,
  source:"CF_BENCHMARKS_BRTI_5HZ_VS_COINBASE",
  basisUsd:Math.round((coinbase.price-Number(tick.valueUsd))*100)/100,
  timestampSkewMs:skew,
  reason:"relative spot basis only; not Kalshi final 60-second settlement or a fill",
 };
}
