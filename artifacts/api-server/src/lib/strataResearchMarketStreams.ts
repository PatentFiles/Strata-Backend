/**
 * Read-only, in-process research book reconstruction.
 * Kalshi exchange clock may skip and same-clock deltas are valid.
 * Only per-subscription seq is strictly consecutive after a snapshot.
 * No trading authority; book liquidity is NOT a guarantee of execution.
 */
import {simulateBookCapacity,type ReadonlyResearchBook,type ResearchBookLevel} from "./forwardTestOrderbookDepth";

type Side="yes"|"no";
export type MarketDepthState={
  ready:boolean;reason:string;ticker:string;sid:number|null;seq:number|null;
  clock:number|null;marketId:string|null;exchangeSendingAtMs:number|null;
  receivedAtMs:number|null;gaps:number;invalidFrames:number;
  yesBidTicks:number|null;yesBidContracts:number|null;
  noBidTicks:number|null;noBidContracts:number|null;
  yesAskTicks:number|null;noAskTicks:number|null;
  snapshotSource:"KALSHI_SEQUENCED_WEBSOCKET";executionVerified:false;
};
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
function ticks(x:unknown):number|null{
 if(typeof x!=="string"||! /^(?:0|1)\.\d{1,4}$/.test(x))return null;
 const [a,b]=x.split(".");
 const n=Number(a)*10000+Number(b!.padEnd(4,"0"));
 return n>0&&n<10000&&Number.isSafeInteger(n)?n:null;
}
function hundredths(x:unknown,signed=false):number|null{
 if(typeof x!=="string"||!new RegExp(`^${signed?"-?":""}(?:0|[1-9]\\d{0,8})(?:\\.\\d{1,2})?$`).test(x))return null;
 const neg=x.startsWith("-");
 const [int,dec=""]=(neg?x.slice(1):x).split(".");
 const n=Number(int)*100+Number(dec.padEnd(2,"0"));
 return Number.isSafeInteger(n)&&n<=1_000_000_000?(neg?-n:n):null;
}
function parseLevels(raw:unknown):Map<number,number>|null{
 if(!Array.isArray(raw)||raw.length>1000)return null;
 const result=new Map<number,number>();
 for(const row of raw){
  if(!Array.isArray(row)||row.length!==2)return null;
  const p=ticks(row[0]),q=hundredths(row[1]);
  if(p===null||q===null||q<=0||result.has(p))return null;
  result.set(p,q);
 }
 return result;
}
function best(x:Map<number,number>){return x.size?Math.max(...x.keys()):null;}
export class SequencedKalshiBook{
 private yes=new Map<number,number>();
 private no=new Map<number,number>();
 private sid:number|null=null;private seq:number|null=null;
 private clock:number|null=null;private marketId:string|null=null;
 private send:number|null=null;private received:number|null=null;
 private reason="WAITING_FOR_SNAPSHOT";private ok=false;
 private gaps=0;private invalid=0;
 constructor(readonly ticker:string){
  if(!/^KXBTC15M-[A-Z0-9-]{5,90}$/.test(ticker))throw Error("invalid_book_ticker");
 }
 reset(reason="AWAITING_FRESH_SNAPSHOT"){
  this.ok=false;this.yes.clear();this.no.clear();this.seq=null;
  this.clock=null;this.received=null;this.send=null;
  this.reason=reason;this.sid=null;this.marketId=null;
 }
 ingest(frame:unknown,recvMs:number):boolean{
  if(!record(frame)||!record(frame.msg)||!Number.isSafeInteger(recvMs)||recvMs<=0)return this.fail("INVALID_ENVELOPE");
  const m=frame.msg;
  if(m.market_ticker!==this.ticker)return false; // unrelated subscription
  const snap=frame.type==="orderbook_snapshot";
  if(!snap&&frame.type!=="orderbook_delta")return false;
  if(!Number.isSafeInteger(frame.seq)||Number(frame.seq)<0||
     !Number.isSafeInteger(frame.sid)||Number(frame.sid)<0||
     !Number.isSafeInteger(m.clock)||Number(m.clock)<0||
     typeof m.market_id!=="string"||m.market_id.length<8||m.market_id.length>128||
     !Number.isSafeInteger(frame.sending_ts_ms)||
     Number(frame.sending_ts_ms)>recvMs+2000||
     recvMs-Number(frame.sending_ts_ms)>5000)return this.fail("INVALID_OR_STALE_EXCHANGE_TIME");
  const sid=Number(frame.sid),seq=Number(frame.seq),clock=Number(m.clock);
  if(snap){
    const y=parseLevels(m.yes_dollars_fp),n=parseLevels(m.no_dollars_fp);
    if(!y||!n)return this.fail("INVALID_SNAPSHOT");
    this.yes=y;this.no=n;this.sid=sid;this.seq=seq;this.clock=clock;
    this.marketId=m.market_id;this.send=Number(frame.sending_ts_ms);
    this.received=recvMs;this.ok=true;this.reason="VALID_SEQUENCED_BOOK";
    return true;
  }
  if(!this.ok||sid!==this.sid||m.market_id!==this.marketId)
   return this.fail("SNAPSHOT_REQUIRED");
  if(seq!==this.seq!+1){this.gaps++;return this.fail("SEQUENCE_GAP_REQUIRES_SNAPSHOT");}
  // Deltas may share clocks or skip clocks. Clock regression needs a new
  // snapshot because it may indicate exchange maintenance/reset.
  if(clock<this.clock!)return this.fail("EXCHANGE_CLOCK_REGRESSION");
  if(m.side!=="yes"&&m.side!=="no")return this.fail("INVALID_DELTA_SIDE");
  const p=ticks(m.price_dollars),delta=hundredths(m.delta_fp,true);
  if(p===null||delta===null||delta===0)return this.fail("INVALID_DELTA");
  const levels=m.side==="yes"?this.yes:this.no;
  const next=(levels.get(p)??0)+delta;
  if(next<0||next>1_000_000_000)return this.fail("IMPOSSIBLE_BOOK_QUANTITY");
  if(next===0)levels.delete(p);else levels.set(p,next);
  this.seq=seq;this.clock=clock;this.send=Number(frame.sending_ts_ms);
  this.received=recvMs;this.reason="VALID_SEQUENCED_BOOK";
  return true;
 }
 private fail(reason:string){this.invalid++;this.reset(reason);return false;}
 get(nowMs=Date.now()):MarketDepthState{
  const fresh=this.ok&&this.received!==null&&this.send!==null&&
    nowMs-this.received>=0&&nowMs-this.received<=2500&&
    nowMs-this.send>=0&&nowMs-this.send<=5000;
  const y=fresh?best(this.yes):null,n=fresh?best(this.no):null;
  return {ready:Boolean(fresh),reason:fresh?this.reason:
    this.ok?"STALE_SEQUENCED_BOOK":this.reason,ticker:this.ticker,
    sid:fresh?this.sid:null,seq:fresh?this.seq:null,
    clock:fresh?this.clock:null,marketId:fresh?this.marketId:null,
    exchangeSendingAtMs:fresh?this.send:null,receivedAtMs:fresh?this.received:null,
    gaps:this.gaps,invalidFrames:this.invalid,
    yesBidTicks:y,yesBidContracts:y===null?null:Math.floor(this.yes.get(y)!/100),
    noBidTicks:n,noBidContracts:n===null?null:Math.floor(this.no.get(n)!/100),
    yesAskTicks:n===null?null:10000-n,noAskTicks:y===null?null:10000-y,
    snapshotSource:"KALSHI_SEQUENCED_WEBSOCKET",executionVerified:false};
 }
 asResearchBook(nowMs=Date.now()):ReadonlyResearchBook|null{
  if(!this.get(nowMs).ready)return null;
  const toLevels=(m:Map<number,number>):ResearchBookLevel[]=>
    [...m].map(([priceTicks,contractsHundredths])=>({priceTicks,contractsHundredths}));
  return {ticker:this.ticker,requestStartedAtMs:this.send!,receivedAtMs:this.received!,
   source:"KALSHI_SEQUENCED_WEBSOCKET",timestampAuthority:"KALSHI_EXCHANGE_SENDING_TIMESTAMP",
   yesBids:toLevels(this.yes),noBids:toLevels(this.no)};
 }
 simulate(side:Side,action:"buy"|"sell",qty:number,limitTicks:number,now=Date.now()){
  const book=this.asResearchBook(now);
  return book?simulateBookCapacity(book,side,action,qty,limitTicks):null;
 }
}
/** Bounded, non-financial operational observation. Source clocks may skew;
 * these are *observed event ages*, not true network one-way latency. */
export class MarketEventAgeWindow{
 private samples:number[]=[];
 observe(sourceAtMs:number,receivedAtMs:number){
  const age=receivedAtMs-sourceAtMs;
  if(!Number.isSafeInteger(sourceAtMs)||!Number.isSafeInteger(receivedAtMs)||
     age<0||age>10_000)return false;
  this.samples.push(age);
  if(this.samples.length>256)this.samples.shift();
  return true;
 }
 summary(){
  if(!this.samples.length)return {samples:0,lastMs:null,medianMs:null,p95Ms:null,p99Ms:null,
   timeAuthority:"LOCAL_RECEIPT_MINUS_SOURCE_EVENT_CLOCK" as const};
  const a=[...this.samples].sort((x,y)=>x-y);
  const q=(pct:number)=>a[Math.max(0,Math.ceil(pct*a.length)-1)]!;
  return {samples:a.length,lastMs:this.samples[this.samples.length-1]!,
    medianMs:q(0.5),p95Ms:q(0.95),p99Ms:q(0.99),
    timeAuthority:"LOCAL_RECEIPT_MINUS_SOURCE_EVENT_CLOCK" as const};
 }
}
/** Testable liveness policies. Silence cannot upgrade a stale book to fresh. */
export function marketStreamStalled(lastObservedAtMs:number,nowMs:number,
 timeoutMs=12_000):boolean{
 return !Number.isSafeInteger(lastObservedAtMs)||!Number.isSafeInteger(nowMs)||
  lastObservedAtMs<=0||nowMs<lastObservedAtMs||
  nowMs-lastObservedAtMs>timeoutMs;
}
export function marketBookNeedsRefresh(
 lastBookEventAtMs:number,lastSnapshotRequestedAtMs:number,nowMs:number,
):boolean{
 return Number.isSafeInteger(nowMs)&&
  marketStreamStalled(lastBookEventAtMs,nowMs,15_000)&&
  (lastSnapshotRequestedAtMs===0||nowMs-lastSnapshotRequestedAtMs>=10_000);
}
export function validCoinbaseHeartbeat(
 input:unknown,receivedAtMs:number):boolean{
 if(!record(input)||input.type!=="heartbeat"||input.product_id!=="BTC-USD"||
   typeof input.time!=="string"||!Number.isSafeInteger(receivedAtMs))return false;
 const stamp=Date.parse(input.time);
 const lag=receivedAtMs-stamp;
 return Number.isSafeInteger(stamp)&&lag>=-2000&&lag<=3000;
}
export type CoinbaseTicker={
 priceUsd:number;bidUsd:number;askUsd:number;
 sourceAtMs:number;receivedAtMs:number;sequence:number;
 source:"COINBASE_EXCHANGE_TICKER_WS";executionAuthority:false;
};
export function parseCoinbaseRealtimeTicker(input:unknown,recvMs:number):CoinbaseTicker|null{
 if(!record(input)||input.type!=="ticker"||input.product_id!=="BTC-USD"||
   !Number.isSafeInteger(input.sequence)||Number(input.sequence)<0||
   typeof input.time!=="string"||!Number.isSafeInteger(recvMs))return null;
 const ts=Date.parse(input.time);
 const price=Number(input.price),bid=Number(input.best_bid),ask=Number(input.best_ask);
 if(!Number.isSafeInteger(ts)||ts>recvMs+2000||recvMs-ts>3000||
   ![price,bid,ask].every(Number.isFinite)||bid<=0||ask<=0||bid>ask||
   price<=0||price>1_000_000)return null;
 return {priceUsd:price,bidUsd:bid,askUsd:ask,sourceAtMs:ts,
   receivedAtMs:recvMs,sequence:Number(input.sequence),
   source:"COINBASE_EXCHANGE_TICKER_WS",executionAuthority:false};
}
export function evaluateTriangulatedMarket(
 brti:{indexUsd:string;sourceAtMs:number}|null,
 coinbase:CoinbaseTicker|null,book:MarketDepthState|null,nowMs:number,
){
 const b=brti?Number(brti.indexUsd):NaN;
 const freshTime=(stamp:number|null|undefined,maxAgeMs:number)=>
   Number.isSafeInteger(nowMs)&&Number.isSafeInteger(stamp)&&
   nowMs-stamp!>=0&&nowMs-stamp!<=maxAgeMs;
 const referenceFresh=Boolean(Number.isFinite(b)&&b>0&&
   freshTime(brti?.sourceAtMs,3000));
 const coinbaseFresh=Boolean(coinbase&&freshTime(coinbase.sourceAtMs,3000));
 const aligned=Boolean(referenceFresh&&coinbaseFresh&&
   Math.abs(coinbase!.sourceAtMs-brti!.sourceAtMs)<=1200);
 // Freshness and simultaneity are different claims. A valid sequenced book
 // may be up to five seconds old; that does not make it aligned with the
 // two current spot references. Use the exchange sending timestamp, never
 // receipt time or the exchange's opaque sequence/clock counters.
 const hasBook=Boolean(book?.ready&&
   freshTime(book.exchangeSendingAtMs,5000)&&freshTime(book.receivedAtMs,2500));
 const allSourceSkewMs=aligned&&hasBook?
   Math.max(brti!.sourceAtMs,coinbase!.sourceAtMs,book!.exchangeSendingAtMs!)-
   Math.min(brti!.sourceAtMs,coinbase!.sourceAtMs,book!.exchangeSendingAtMs!):null;
 const allAligned=allSourceSkewMs!==null&&allSourceSkewMs<=1200;
 return {mode:"RESEARCH_ONLY" as const,tradingAuthority:false as const,
   settlementVerified:false as const,exchangeFillVerified:false as const,
   referenceFresh,coinbaseFresh,
   sequencedKalshiBookFresh:hasBook,
   sourcesFreshAndAligned:allAligned,
   publisherSkewMs:aligned?Math.abs(coinbase!.sourceAtMs-brti!.sourceAtMs):null,
   allSourceSkewMs,
   spotBasisUsd:aligned?Math.round((coinbase!.priceUsd-b)*100)/100:null,
   reason:!aligned?"UNVERIFIED_SOURCE_TIME_ALIGNMENT":!hasBook?"KALSHI_BOOK_UNAVAILABLE":
    !allAligned?"KALSHI_BOOK_TIME_NOT_ALIGNED":
    "REFERENCE_TRIANGULATION_OBSERVED_NOT_EXECUTABLE",
   warning:"Book depth is displayed, not guaranteed IOC fills. BRTI instantaneous ticks are not final-minute settlement. No trade authorization."};
}

/** Whitelisted, low-frequency operational evidence. Never log a raw source
 * frame/status object: it also contains prices, market IDs and error text. */
type ResearchAgeSummary={samples:number;p95Ms:number|null};
type ResearchDiagnosticInput={
 state:{coinbase:string;kalshiOrderbook:string;brtiSettlement:string;brtiInstant5Hz:string};
 health:{referenceFresh:boolean;coinbaseFresh:boolean;sequencedKalshiBookFresh:boolean;
   sourcesFreshAndAligned:boolean;allSourceSkewMs:number|null};
 diagnostics:{cbInvalid:number;cbSequenceRegressions:number;kalshiReconnects:number;
   bookGaps:number;bookInvalid:number;
   ageDiagnostics:{coinbaseTickerEvent:ResearchAgeSummary;kalshiOrderbookUpdate:ResearchAgeSummary}};
};
const diagnosticStates=new Set(["DISABLED","CONNECTING","UNAVAILABLE","CONNECTED",
 "AWAITING_SNAPSHOT","CONFIG_MISSING","BRTI_CONFIRMED","NO_ENTITLEMENT",
 "DISCONNECTED","SUBSCRIBING","CONFIRMED","DEGRADED"]);
export function researchDiagnosticSummary(input:ResearchDiagnosticInput,
 lastMarketLookupMs:number|null){
 const count=(x:number)=>Number.isSafeInteger(x)&&x>=0?x:null;
 const age=(x:number|null)=>x!==null&&Number.isFinite(x)&&x>=0?
   Math.round(x*1000)/1000:null;
 const state=(x:string)=>diagnosticStates.has(x)?x:"UNAVAILABLE";
 return {event:"strata_market_research_summary",mode:"RESEARCH_ONLY",
  tradingAuthority:false,
  coinbaseState:state(input.state.coinbase),bookState:state(input.state.kalshiOrderbook),
  brtiState:state(input.state.brtiSettlement),brti5HzState:state(input.state.brtiInstant5Hz),
  referenceFresh:input.health.referenceFresh===true,
  coinbaseFresh:input.health.coinbaseFresh===true,
  bookFresh:input.health.sequencedKalshiBookFresh===true,
  sourcesFreshAndAligned:input.health.sourcesFreshAndAligned===true,
  allSourceSkewMs:age(input.health.allSourceSkewMs),
  coinbaseAgeSamples:count(input.diagnostics.ageDiagnostics.coinbaseTickerEvent.samples),
  coinbaseEventAgeP95Ms:age(input.diagnostics.ageDiagnostics.coinbaseTickerEvent.p95Ms),
  bookAgeSamples:count(input.diagnostics.ageDiagnostics.kalshiOrderbookUpdate.samples),
  bookEventAgeP95Ms:age(input.diagnostics.ageDiagnostics.kalshiOrderbookUpdate.p95Ms),
  cbInvalid:count(input.diagnostics.cbInvalid),
  cbSequenceRegressions:count(input.diagnostics.cbSequenceRegressions),
  kalshiReconnects:count(input.diagnostics.kalshiReconnects),
  bookGaps:count(input.diagnostics.bookGaps),bookInvalid:count(input.diagnostics.bookInvalid),
  lastMarketLookupMs:age(lastMarketLookupMs),
  ageAuthority:"LOCAL_RECEIPT_MINUS_SOURCE_EVENT_CLOCK_NOT_RTT"};
}
/** Called by the existing observer monitor only. No timer, I/O, or DB work
 * is created here. Advance before the sink so failure cannot cause flooding. */
export function createResearchDiagnosticReporter(
 write:(summary:ReturnType<typeof researchDiagnosticSummary>)=>void,
){
 let lastAttempt:number|null=null;
 return (monotonicNowMs:number,read:()=>ReturnType<typeof researchDiagnosticSummary>)=>{
  if(!Number.isFinite(monotonicNowMs)||monotonicNowMs<0)return;
  if(lastAttempt!==null&&monotonicNowMs-lastAttempt<60_000)return;
  lastAttempt=monotonicNowMs;
  try{write(read());}catch{/* Optional diagnostics never control processing. */}
 };
}
