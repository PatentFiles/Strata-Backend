/**
 * Optional single-process, READ-ONLY research observers for:
 * - sequenced Kalshi book on the currently paper-tracked KXBTC15M market
 * - independent Coinbase Exchange BTC-USD trade ticker
 *
 * Both are disabled by default, require explicit production opt-in,
 * never mutate strategy decisions, balances, fills, or any trading states.
 * A reconnect, ticker rollover, clock regression or seq gap invalidates
 * liquidity until a new exchange book snapshot is verified.
 */
import {performance} from "node:perf_hooks";
import {createPrivateKey,createSign,constants} from "node:crypto";
import {getEngineStatus} from "./forwardTestRepository";
import {readKalshiBrtiShadowStatus} from "./kalshiBrtiShadowStream";
import {MarketEventAgeWindow,SequencedKalshiBook,parseCoinbaseRealtimeTicker,
 marketStreamStalled,marketBookNeedsRefresh,validCoinbaseHeartbeat,
 evaluateTriangulatedMarket,researchDiagnosticSummary,createResearchDiagnosticReporter,type CoinbaseTicker} from "./strataResearchMarketStreams";

const WS="wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const COINBASE="wss://ws-feed.exchange.coinbase.com";
const tickPattern=/^KXBTC15M-[A-Z0-9-]{5,90}$/;
const MAX_MESSAGE_SIZE=256_000;
type Reason="DISABLED"|"CONNECTING"|"UNAVAILABLE"|"CONNECTED"|"AWAITING_SNAPSHOT";
let running=false,halted=false;
let kalshi:WebSocket|null=null,coinbase:WebSocket|null=null;
let depth:SequencedKalshiBook|null=null;
let depthTicker:string|null=null;
let depthState:Reason="DISABLED",coinbaseState:Reason="DISABLED";
let cb:CoinbaseTicker|null=null;
let lastCoinbaseSeq:number|null=null;
let cbInvalid=0,cbSequenceRegressions=0,kalshiReconnects=0;
const cbAges=new MarketEventAgeWindow();
const depthAges=new MarketEventAgeWindow();
let lastDepthError:string|null=null;
let lastCoinbaseError:string|null=null;
let monitor:ReturnType<typeof setInterval>|null=null;
let cbRetry:ReturnType<typeof setTimeout>|null=null;
let bookRetry:ReturnType<typeof setTimeout>|null=null;
let bookEpoch=0;
let disposeBookTimers:(()=>void)|null=null;
let disposeCoinbaseTimers:(()=>void)|null=null;

export function readTriangulatedMarketStatus(now=Date.now()){
 const brti=readKalshiBrtiShadowStatus(now);
 const index=brti.fastSourceFresh&&brti.fastIndex?
    {indexUsd:brti.fastIndex.valueUsd,sourceAtMs:brti.fastIndex.sourceTimestampMs}:
    brti.instantSourceFresh&&brti.lastIndex?
    {indexUsd:brti.lastIndex.currentIndexUsd,sourceAtMs:brti.lastIndex.sourceTimestampMs}:null;
 const validCb=cb&&now-cb.sourceAtMs>=0&&now-cb.sourceAtMs<=3000?cb:null;
 const book=depth?.get(now)??null;
 return {mode:"RESEARCH_ONLY" as const,tradingAuthority:false as const,
  state:{coinbase:coinbaseState,kalshiOrderbook:depthState,
    brtiSettlement:brti.state,brtiInstant5Hz:brti.fastState},
  ticker:depthTicker,
  sources:{
   brtiIndex:index?{sourceAtMs:index.sourceAtMs,indexUsd:index.indexUsd,
       source:brti.fastSourceFresh?"BRTI_5HZ":"BRTI_1HZ",settlementVerified:false}:null,
   coinbase:validCb,
   kalshiBook:book,
   brtiFinalMinute:brti.sourceFresh?brti.lastFrame:null,
  },
  health:evaluateTriangulatedMarket(index,validCb,book,now),
  diagnostics:{cbInvalid,cbSequenceRegressions,kalshiReconnects,
    bookGaps:book?.gaps??0,bookInvalid:book?.invalidFrames??0,
    lastDepthError,lastCoinbaseError,
    ageDiagnostics:{coinbaseTickerEvent:cbAges.summary(),kalshiOrderbookUpdate:depthAges.summary()}},
  noOrdersSubmitted:true,liveDecisionAuthority:false};
}
export function triangulationConfigured(env:NodeJS.ProcessEnv=process.env){
 return env.NODE_ENV==="production"&&env.KALSHI_API_ENVIRONMENT==="production"&&
   env.STRATA_TRIANGULATED_MARKET_RESEARCH_ENABLED==="true";
}
export function startTriangulatedMarketObserver(env:NodeJS.ProcessEnv=process.env){
 if(running||!triangulationConfigured(env))return {stop:()=>{}};
 running=true;halted=false;
 const keyId=env.KALSHI_INDEX2_API_KEY_ID?.trim();
 const pem=env.KALSHI_INDEX2_PRIVATE_KEY?.trim().replaceAll("\\n","\n");
 const enabledSigner=Boolean(keyId&&pem&&/^[-\w]{8,128}$/.test(keyId));
 const socketConfig=()=>{
  if(!enabledSigner||!pem||!keyId)throw Error("restricted_read_signer_unavailable");
  const key=createPrivateKey(pem);
  if(key.asymmetricKeyType!=="rsa"&&key.asymmetricKeyType!=="rsa-pss")
    throw Error("unexpected_signer_key");
  const stamp=String(Date.now());
  const sig=createSign("sha256");
  sig.update(`${stamp}GET/trade-api/ws/v2`);sig.end();
  return {headers:{
   "KALSHI-ACCESS-KEY":keyId,
   "KALSHI-ACCESS-TIMESTAMP":stamp,
   "KALSHI-ACCESS-SIGNATURE":sig.sign({
    key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32,
   }).toString("base64"),
  }};
 };
 const closeBook=()=>{
  bookEpoch++;
  if(bookRetry){clearTimeout(bookRetry);bookRetry=null;}
  disposeBookTimers?.();disposeBookTimers=null;
  const socket=kalshi;kalshi=null;depth=null;depthTicker=null;
  if(socket){try{socket.close()}catch{/* no order authority */}}
 };
 const scheduleBookRetry=(ticker:string)=>{
  if(halted||bookRetry)return;
  bookRetry=setTimeout(()=>{
   bookRetry=null;
   if(!halted&&depthTicker===ticker)connectBook(ticker);
  },15_000);
  bookRetry.unref?.();
 };
 const connectBook=(ticker:string)=>{
  if(halted||depthTicker!==ticker)return;
  const attempt=++bookEpoch;depthState="CONNECTING";
  depth=new SequencedKalshiBook(ticker);
  let ws:WebSocket;
  try{
   const HeaderWebSocket=WebSocket as unknown as new (
     url:string,opts:{headers:Record<string,string>})=>WebSocket;
   ws=new HeaderWebSocket(WS,socketConfig());
  }catch{
   depthState="UNAVAILABLE";lastDepthError="kalshi_restricted_wss_setup_failed";
   scheduleBookRetry(ticker);return;
  }
  kalshi=ws;
  let sid:number|null=null;
  let recovering=false;
  const connectedAt=Date.now();
  let lastBookMessageAt=connectedAt;
  let lastSnapshotRequestAt=0;
  let resyncTimer:ReturnType<typeof setTimeout>|null=null;
  let watchdog:ReturnType<typeof setInterval>|null=null;
  const clearResync=()=>{
    if(resyncTimer){clearTimeout(resyncTimer);resyncTimer=null;}
    recovering=false;
  };
  const requestSnapshot=(reason:string)=>{
    // Kalshi can remain connected with no orderbook deltas when the market is
    // quiet. A bounded fresh *exchange* snapshot repairs stale observations
    // without mistaking silence for proof of current executable depth.
    if(halted||bookEpoch!==attempt||sid===null||recovering||
      Date.now()-lastSnapshotRequestAt<10_000)return;
    recovering=true;lastSnapshotRequestAt=Date.now();
    lastDepthError=reason;
    try{
      ws.send(JSON.stringify({id:102,cmd:"update_subscription",params:{
        sid,action:"get_snapshot",market_tickers:[ticker],
      }}));
    }catch{
      lastDepthError="kalshi_book_snapshot_request_failed";
      try{ws.close()}catch{/* reconnect or stay fail-closed */}
      return;
    }
    resyncTimer=setTimeout(()=>{
      if(!halted&&bookEpoch===attempt&&recovering){
        lastDepthError="kalshi_book_snapshot_timeout";
        try{ws.close()}catch{/* fail closed */}
      }
    },5000);
    resyncTimer.unref?.();
  };
  ws.addEventListener("open",()=>{
   if(halted||bookEpoch!==attempt)return;
   depthState="AWAITING_SNAPSHOT";
   try{
     ws.send(JSON.stringify({id:101,cmd:"subscribe",params:{
       channels:["orderbook_delta"],market_ticker:ticker,
     }}));
   }catch{
     lastDepthError="kalshi_subscription_send_failed";
     try{ws.close()}catch{/* fail closed */}
   }
  });
  ws.addEventListener("message",event=>{
   if(halted||bookEpoch!==attempt||typeof event.data!=="string"||
      event.data.length>MAX_MESSAGE_SIZE)return;
   let frame:unknown;
   try{frame=JSON.parse(event.data)}catch{return;}
   if(!frame||typeof frame!=="object")return;
   const f=frame as Record<string,unknown>;
   if(f.type==="error"){lastDepthError="kalshi_market_subscription_error";
     depthState="UNAVAILABLE";try{ws.close()}catch{}return;}
   if(f.type==="subscribed"&&f.id===101&&f.msg&&typeof f.msg==="object"){
     const msg=f.msg as Record<string,unknown>;
     if(msg.channel==="orderbook_delta"&&typeof msg.sid==="number"&&
       Number.isSafeInteger(msg.sid))sid=msg.sid;
     return;
   }
   if(f.type!=="orderbook_snapshot"&&f.type!=="orderbook_delta")return;
   if(sid===null||f.sid!==sid)return;
   const applied=depth?.ingest(frame,Date.now());
   if(applied){
     lastBookMessageAt=Date.now();
     depthAges.observe(Number(f.sending_ts_ms),lastBookMessageAt);
     depthState="CONNECTED";
     if(f.type==="orderbook_snapshot")clearResync();
   }else if(depth&&!depth.get().ready){
     depthState="AWAITING_SNAPSHOT";
     // A gap is not repaired with an unordered REST snapshot.
     // Request an authoritative snapshot in the same subscription.
     requestSnapshot("kalshi_book_resync_requested");
     // Never reinstate depth until a true Kalshi subscription snapshot.
   }
  });
  // Enforce subscribe-ack and snapshot liveness. Book messages may be silent
  // in low-liquidity markets; refresh only by genuine Kalshi snapshots.
  watchdog=setInterval(()=>{
    if(halted||bookEpoch!==attempt)return;
    const now=Date.now();
    if(sid===null&&now-connectedAt>12_000){
      lastDepthError="kalshi_subscribe_ack_timeout";
      try{ws.close()}catch{/* fail closed */}
      return;
    }
    if(sid!==null&&marketBookNeedsRefresh(lastBookMessageAt,
      lastSnapshotRequestAt,now)&&ws.readyState===1){
      requestSnapshot("kalshi_book_idle_snapshot_refresh");
    }
  },2500);
  watchdog.unref?.();
  disposeBookTimers=()=>{
    clearResync();if(watchdog){clearInterval(watchdog);watchdog=null;}
  };
  ws.addEventListener("error",()=>{if(bookEpoch===attempt)
   lastDepthError="kalshi_wss_transport_error";});
  ws.addEventListener("close",()=>{
   // A late close from a previous ticker/socket may not cancel timers
   // belonging to a new subscription.
   if(bookEpoch===attempt&&kalshi===ws&&disposeBookTimers){
     disposeBookTimers();disposeBookTimers=null;
   }else{
     clearResync();if(watchdog){clearInterval(watchdog);watchdog=null;}
   }
   if(halted||bookEpoch!==attempt)return;
   kalshi=null;depth?.reset("TRANSPORT_CLOSED");
   depthState="UNAVAILABLE";kalshiReconnects++;
   scheduleBookRetry(ticker);
  });
 };
 const connectCoinbase=()=>{
  if(halted)return;
  coinbaseState="CONNECTING";cb=null;lastCoinbaseSeq=null;
  let ws:WebSocket;
  try{ws=new WebSocket(COINBASE);}catch{
   coinbaseState="UNAVAILABLE";lastCoinbaseError="coinbase_ws_setup_failed";
   return scheduleCoinbase();
  }
  coinbase=ws;
  let lastCoinbaseHeartbeatOrTickerAt=Date.now();
  const cbWatchdog=setInterval(()=>{
    if(halted||coinbase!==ws)return;
    if(marketStreamStalled(lastCoinbaseHeartbeatOrTickerAt,Date.now())){
      lastCoinbaseError="coinbase_ticker_and_heartbeat_timeout";
      cb=null;coinbaseState="UNAVAILABLE";
      try{ws.close()}catch{/* fail closed; timeout monitored */}
    }
  },3000);
  cbWatchdog.unref?.();
  disposeCoinbaseTimers=()=>clearInterval(cbWatchdog);
  ws.addEventListener("open",()=>{
   if(halted||coinbase!==ws)return;
   try{
     ws.send(JSON.stringify({type:"subscribe",product_ids:["BTC-USD"],
       channels:["ticker","heartbeat"]}));
   }catch{
     lastCoinbaseError="coinbase_subscription_send_failed";
     try{ws.close()}catch{/* fail closed */}
   }
  });
  ws.addEventListener("message",event=>{
   if(halted||coinbase!==ws||typeof event.data!=="string"||
      event.data.length>MAX_MESSAGE_SIZE)return;
   let raw:unknown;
   try{raw=JSON.parse(event.data)}catch{cbInvalid++;return;}
   if(!raw||typeof raw!=="object")return;
   const f=raw as Record<string,unknown>;
   if(f.type==="error"){lastCoinbaseError="coinbase_subscription_refused";
      coinbaseState="UNAVAILABLE";try{ws.close()}catch{}return;}
   if(f.type==="subscriptions"){coinbaseState="CONNECTED";return;}
   if(f.type==="heartbeat"){
     if(validCoinbaseHeartbeat(f,Date.now()))lastCoinbaseHeartbeatOrTickerAt=Date.now();
     return;
   }
   if(f.type!=="ticker")return;
   const parsed=parseCoinbaseRealtimeTicker(raw,Date.now());
   if(!parsed){cbInvalid++;return;}
   // Ticker sequence can skip across other Coinbase channels; only
   // strictly declining or repeated sequences are invalid.
   if(lastCoinbaseSeq!==null&&parsed.sequence<=lastCoinbaseSeq){
     cbSequenceRegressions++;return;
   }
   cb=parsed;lastCoinbaseSeq=parsed.sequence;coinbaseState="CONNECTED";
   lastCoinbaseHeartbeatOrTickerAt=Date.now();
   cbAges.observe(parsed.sourceAtMs,parsed.receivedAtMs);
  });
  ws.addEventListener("error",()=>{if(coinbase===ws)
   lastCoinbaseError="coinbase_ws_transport_error";});
  ws.addEventListener("close",()=>{
   clearInterval(cbWatchdog);
   if(coinbase===ws)disposeCoinbaseTimers=null;
   if(halted||coinbase!==ws)return;
   coinbase=null;cb=null;coinbaseState="UNAVAILABLE";
   scheduleCoinbase();
  });
 };
 const scheduleCoinbase=()=>{
  if(halted||cbRetry)return;
  cbRetry=setTimeout(()=>{cbRetry=null;if(!halted)connectCoinbase();},15_000);
  cbRetry.unref?.();
 };
 let checking=false;
 let lastMarketLookupMs:number|null=null;
 const report=createResearchDiagnosticReporter(summary=>console.info(JSON.stringify(summary)));
 const refreshMarket=async()=>{
  if(halted||checking)return;
  checking=true;
  const lookupStarted=performance.now();
  let lookupFinished=false;
  try{
   const engine=await getEngineStatus();
   lastMarketLookupMs=Math.max(0,performance.now()-lookupStarted);lookupFinished=true;
   // Only follow PAPER_ONLY market identification. No live account reads.
   const next=engine?.enabled&&typeof engine.marketTicker==="string"&&
      tickPattern.test(engine.marketTicker)?engine.marketTicker:null;
   if(next!==depthTicker){
      closeBook();
      depthTicker=next;
      depthState=next?"CONNECTING":"AWAITING_SNAPSHOT";
      if(next)connectBook(next);
   }else if(next&&kalshi===null&&!bookRetry){
      scheduleBookRetry(next);
   }
  }catch{lastDepthError="paper_market_lookup_unavailable";}
  finally{
   if(!lookupFinished)lastMarketLookupMs=Math.max(0,performance.now()-lookupStarted);
   checking=false;
  }
 };
 connectCoinbase();
 if(!enabledSigner){depthState="UNAVAILABLE";lastDepthError="restricted_read_signer_missing";}
 else{void refreshMarket();}
 monitor=setInterval(()=>{
  if(halted)return;
  report(performance.now(),()=>researchDiagnosticSummary(readTriangulatedMarketStatus(),lastMarketLookupMs));
  if(enabledSigner)void refreshMarket();
 },5000);
 monitor.unref?.();
 return {stop:()=>{
  halted=true;running=false;
  if(monitor){clearInterval(monitor);monitor=null;}
  if(cbRetry){clearTimeout(cbRetry);cbRetry=null;}
  closeBook();
  disposeCoinbaseTimers?.();disposeCoinbaseTimers=null;
  const c=coinbase;coinbase=null;cb=null;
  try{c?.close()}catch{/* no trade transport */}
  depthState="DISABLED";coinbaseState="DISABLED";
 }};
}
