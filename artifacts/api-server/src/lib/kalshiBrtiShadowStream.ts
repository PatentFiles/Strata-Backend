/**
 * Optional, single-process, READ-ONLY CF Benchmarks BRTI monitor.
 * Production opt-in: STRATA_CF_BRTI_SHADOW_ENABLED=true.
 * Uses the existing Kalshi server-side restricted signer only for the
 * authenticated WebSocket GET handshake; NEVER signs an order or a mutation.
 *
 * Kalshi docs: /websockets/cfbenchmarks-value (BRTI, indexlist, last_60s...)
 */
import {createPrivateKey,createSign,constants} from "node:crypto";
import {parseKalshiBrtiInstantFrame,parseKalshiBrtiQuarterHourFrame,type BrtiWindowFrame,type BrtiInstantFrame} from "./cfBenchmarksSettlement";
// Deliberately no Pino transport import: the authenticated read route must not start log workers.

const WSS_PATH="/trade-api/ws/v2";
const WSS_HOST="wss://external-api-ws.kalshi.com";
const RECONNECT_MS=30_000;
const FRESH_MS=5_000;
type State="DISABLED"|"CONFIG_MISSING"|"CONNECTING"|"CONNECTED"|"BRTI_CONFIRMED"|"NO_ENTITLEMENT"|"DISCONNECTED";
type ReferenceState={
  state:State;indexId:"BRTI";lastFrame:BrtiWindowFrame|null;
  lastIndex:BrtiInstantFrame|null;instantSourceFresh:boolean;
  lastReceivedAtMs:number|null;lastError:string|null;
  connectionEstablishedAtMs:number|null;sourceFresh:boolean;
  tradingAuthority:false;
};
let started=false;
let stopped=false;
let state:State="DISABLED";
let lastFrame:BrtiWindowFrame|null=null;
let lastIndex:BrtiInstantFrame|null=null;
let lastReceivedAtMs:number|null=null;
let connectionEstablishedAtMs:number|null=null;
let lastError:string|null=null;
let socket:WebSocket|null=null;
let reconnectTimer:ReturnType<typeof setTimeout>|null=null;

const genericError=(name:string)=>{lastError=name;console.warn(`[brti-shadow] ${name}; no live authority affected`);};
const obj=(x:unknown):x is Record<string,unknown>=>Boolean(x)&&typeof x==="object"&&!Array.isArray(x);
const enabled=(env:NodeJS.ProcessEnv)=>
  env.NODE_ENV==="production"&&
  env.KALSHI_API_ENVIRONMENT==="production"&&
  env.STRATA_CF_BRTI_SHADOW_ENABLED==="true";

/** Does not imply BRTI is entitled, current, or suitable to trigger entries. */
export function kalshiBrtiShadowConfigured(env:NodeJS.ProcessEnv=process.env):boolean {
  return enabled(env);
}
export function readKalshiBrtiShadowStatus(now=Date.now()):ReferenceState {
  const sourceFresh=lastFrame!==null&&state==="BRTI_CONFIRMED"&&
    now-lastFrame.receivedAtMs>=0&&now-lastFrame.receivedAtMs<=FRESH_MS;
  const instantSourceFresh=lastIndex!==null&&state==="BRTI_CONFIRMED"&&
    now-lastIndex.receivedAtMs>=0&&now-lastIndex.receivedAtMs<=FRESH_MS;
  return {state,indexId:"BRTI",
    lastFrame:sourceFresh?lastFrame:null,
    lastIndex:instantSourceFresh?lastIndex:null,instantSourceFresh,
    lastReceivedAtMs,connectionEstablishedAtMs,lastError,sourceFresh,
    tradingAuthority:false};
}
/** In-process read-only observer; never binds owner accounts or emits orders. */
export function startKalshiBrtiShadowFeed(env:NodeJS.ProcessEnv=process.env):{stop:()=>void}{
  if(started||!enabled(env))return {stop:()=>{}};
  started=true;stopped=false;
  const apiKey=env.KALSHI_INDEX2_API_KEY_ID?.trim();
  const pem=env.KALSHI_INDEX2_PRIVATE_KEY?.trim().replaceAll("\\n","\n");
  if(!apiKey||!pem||!/^[-\w]{8,128}$/.test(apiKey)){
    state="CONFIG_MISSING";genericError("restricted_signed_reader_missing");
    return {stop:()=>{stopped=true;}};
  }
  // No authenticated WebSocket headers can be constructed in a browser.
  // The Node >=22 native Undici WebSocket accepts a headers-only init object.
  const connect=()=>{
    if(stopped)return;
    state="CONNECTING";lastFrame=null;lastIndex=null;
    lastError=null;connectionEstablishedAtMs=null;
    try{
      const key=createPrivateKey(pem);
      if(key.asymmetricKeyType!=="rsa"&&key.asymmetricKeyType!=="rsa-pss")
        throw Error("invalid_signer_type");
      const timestamp=String(Date.now());
      const signer=createSign("sha256");
      signer.update(`${timestamp}GET${WSS_PATH}`);signer.end();
      const signature=signer.sign({
        key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32,
      }).toString("base64");
      const HeaderWebSocket=WebSocket as unknown as new (
        url:string,options:{headers:Record<string,string>},
      )=>WebSocket;
      const ws=new HeaderWebSocket(WSS_HOST+WSS_PATH,{headers:{
        "KALSHI-ACCESS-KEY":apiKey,
        "KALSHI-ACCESS-SIGNATURE":signature,
        "KALSHI-ACCESS-TIMESTAMP":timestamp,
      }});
      socket=ws;
      ws.addEventListener("open",()=>{
        if(stopped||socket!==ws)return;
        state="CONNECTED";connectionEstablishedAtMs=Date.now();
        ws.send(JSON.stringify({id:1,cmd:"subscribe",params:{
          channels:["cfbenchmarks_value"],index_ids:["BRTI"],
        }}));
      });
      ws.addEventListener("message",(event)=>{
        if(stopped||socket!==ws)return;
        if(typeof event.data!=="string"||event.data.length>32_768)return;
        let frame:unknown;
        try{frame=JSON.parse(event.data)}catch{return;}
        if(!obj(frame))return;
        if(frame.type==="error"){
          state="NO_ENTITLEMENT";genericError("cf_benchmark_subscription_error");
          ws.close();return;
        }
        if(frame.type==="subscribed"&&obj(frame.msg)&&frame.msg.channel==="cfbenchmarks_value"){
          const sid=frame.msg.sid;
          if(typeof sid!=="number"||!Number.isSafeInteger(sid))return;
          ws.send(JSON.stringify({id:2,cmd:"update_subscription",params:{
            sid,action:"indexlist",
          }}));
          return;
        }
        if(frame.type==="cfbenchmarks_value_indexlist"&&obj(frame.msg)){
          if(!Array.isArray(frame.msg.index_ids)||!frame.msg.index_ids.includes("BRTI")){
            state="NO_ENTITLEMENT";genericError("brti_index_not_entitled");
            ws.close();return;
          }
          state="BRTI_CONFIRMED";lastError=null;
          console.info("[brti-shadow] BRTI index entitlement confirmed; read-only observer");
          return;
        }
        if(frame.type!=="cfbenchmarks_value"||state!=="BRTI_CONFIRMED")return;
        const received=Date.now();
        const tick=parseKalshiBrtiInstantFrame(frame,received);
        if(tick.ok&&(!lastIndex||tick.tick.sourceTimestampMs>lastIndex.sourceTimestampMs)){
          const firstTick=lastIndex===null;
          lastIndex=tick.tick;lastReceivedAtMs=received;
          if(firstTick)console.info("[brti-shadow] fresh BRTI index tick verified; no trading authority");
        }
        const parsed=parseKalshiBrtiQuarterHourFrame(frame,received);
        // Outside final minute is an ordinary state, not a feed outage.
        if(parsed.ok){
          if(!lastFrame||parsed.frame.sourceTimestampMs>lastFrame.sourceTimestampMs){
            lastFrame=parsed.frame;
            lastReceivedAtMs=received;
          }
        }else if(parsed.reason!=="outside_kalshi_quarter_final_minute"){
          // No raw account material or payload content in logs.
          lastError=parsed.reason;
        }
      });
      ws.addEventListener("error",()=>{if(socket===ws)genericError("websocket_transport_error");});
      ws.addEventListener("close",()=>{
        if(socket!==ws)return;
        socket=null;lastFrame=null;lastIndex=null;connectionEstablishedAtMs=null;
        if(stopped)return;
        // Explicit provider denial is terminal until the next operator-approved
        // deployment. Do not hammer the credential or bypass entitlement.
        if(state==="NO_ENTITLEMENT")return;
        state="DISCONNECTED";
        reconnectTimer=setTimeout(connect,RECONNECT_MS);
        reconnectTimer.unref?.();
      });
    }catch{
      state="DISCONNECTED";genericError("websocket_setup_refused");
      reconnectTimer=setTimeout(connect,RECONNECT_MS);
      reconnectTimer.unref?.();
    }
  };
  connect();
  return {stop:()=>{
    stopped=true;state="DISABLED";lastFrame=null;lastIndex=null;
    if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
    try{socket?.close()}catch{/* release best effort */}
    socket=null;
  }};
}
