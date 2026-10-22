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
import {createPrivateKey,createSign,constants} from "node:crypto";
import {getEngineStatus} from "./forwardTestRepository";
import {readKalshiBrtiShadowStatus} from "./kalshiBrtiShadowStream";
import {SequencedKalshiBook,parseCoinbaseRealtimeTicker,
 evaluateTriangulatedMarket,type CoinbaseTicker} from "./strataResearchMarketStreams";

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
let lastDepthError:string|null=null;
let lastCoinbaseError:string|null=null;
let monitor:ReturnType<typeof setInterval>|null=null;
let cbRetry:ReturnType<typeof setTimeout>|null=null;
let bookRetry:ReturnType<typeof setTimeout>|null=null;
let bookEpoch=0;

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
    lastDepthError,lastCoinbaseError},
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
  ws.addEventListener("open",()=>{
   if(halted||bookEpoch!==attempt)return;
   depthState="AWAITING_SNAPSHOT";
   ws.send(JSON.stringify({id:101,cmd:"subscribe",params:{
     channels:["orderbook_delta"],market_ticker:ticker,
   }}));
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
     depthState="CONNECTED";
     if(f.type==="orderbook_snapshot")recovering=false;
   }else if(depth&&!depth.get().ready){
     depthState="AWAITING_SNAPSHOT";
     // A gap is not repaired with an unordered REST snapshot.
     // Request an authoritative snapshot in the same subscription.
     if(!recovering&&sid!==null){
       recovering=true;lastDepthError="kalshi_book_resync_requested";
       ws.send(JSON.stringify({id:102,cmd:"update_subscription",params:{
         sid,action:"get_snapshot",market_tickers:[ticker],
       }}));
       // The stream stays unavailable until a genuine snapshot.
     }
   }
  });
  ws.addEventListener("error",()=>{if(bookEpoch===attempt)
   lastDepthError="kalshi_wss_transport_error";});
  ws.addEventListener("close",()=>{
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
  ws.addEventListener("open",()=>{
   if(halted||coinbase!==ws)return;
   ws.send(JSON.stringify({type:"subscribe",product_ids:["BTC-USD"],
     channels:["ticker","heartbeat"]}));
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
   if(f.type!=="ticker")return;
   const parsed=parseCoinbaseRealtimeTicker(raw,Date.now());
   if(!parsed){cbInvalid++;return;}
   // Ticker sequence can skip across other Coinbase channels; only
   // strictly declining or repeated sequences are invalid.
   if(lastCoinbaseSeq!==null&&parsed.sequence<=lastCoinbaseSeq){
     cbSequenceRegressions++;return;
   }
   cb=parsed;lastCoinbaseSeq=parsed.sequence;coinbaseState="CONNECTED";
  });
  ws.addEventListener("error",()=>{if(coinbase===ws)
   lastCoinbaseError="coinbase_ws_transport_error";});
  ws.addEventListener("close",()=>{
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
 const refreshMarket=async()=>{
  if(halted||checking)return;
  checking=true;
  try{
   const engine=await getEngineStatus();
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
  finally{checking=false;}
 };
 connectCoinbase();
 if(!enabledSigner){depthState="UNAVAILABLE";lastDepthError="restricted_read_signer_missing";}
 else{void refreshMarket();}
 monitor=setInterval(()=>{if(!halted&&enabledSigner)void refreshMarket();},5000);
 monitor.unref?.();
 return {stop:()=>{
  halted=true;running=false;
  if(monitor){clearInterval(monitor);monitor=null;}
  if(cbRetry){clearTimeout(cbRetry);cbRetry=null;}
  closeBook();
  const c=coinbase;coinbase=null;cb=null;
  try{c?.close()}catch{/* no trade transport */}
  depthState="DISABLED";coinbaseState="DISABLED";
 }};
}
