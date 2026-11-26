import {bookAfterDelta} from './book.mjs';
export const endpoint='wss://external-api-ws.kalshi.com/trade-api/ws/v2';
export const TTL=20_000;
const tick=/^KXBTC15M-[A-Z0-9-]{1,80}$/;
const safe=n=>Number.isSafeInteger(n)&&n>0;
export async function capture({ticker, openReadOnly, now=Date.now, mono=()=>performance.now()}={}) {
 if(typeof openReadOnly!=='function') return {status:'READ_ONLY_SIGNER_UNAVAILABLE',ordersEnabled:false};
 if(typeof ticker!=='string'||!tick.test(ticker))return {status:'MARKET_SCOPE_REFUSED',ordersEnabled:false};
 const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),TTL);
 const start=mono(); let socket,sid,seq,clock,marketId,snapshot,snapshotSentAtMs;
 const bound=new Promise((_,reject)=>ac.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));
 const race=p=>Promise.race([p,bound]);
 try{
  socket=await race(openReadOnly({url:endpoint,signal:ac.signal}));
  await race(socket.subscribe({channel:'orderbook_delta',ticker,updateIntervalMs:0}));
  while(mono()-start<TTL){
   const {value:f,done}=await race(socket.next());
   const recvMs=now(), elapsed=mono()-start;
   if(done||!safe(recvMs)||!Number.isFinite(elapsed)||elapsed<0||elapsed>=TTL)break;
   if(f?.type==='subscribed')continue;
   const m=f?.msg;
   if(!m||m.market_ticker!==ticker||typeof m.market_id!=='string'||!m.market_id||
      !safe(f.sid)||!safe(f.seq)||!safe(m.clock)||!safe(f.sending_ts_ms)||f.sending_ts_ms>recvMs||
      recvMs-f.sending_ts_ms>5000)throw Error('scope');
   if(seq===undefined){
    if(f.type!=='orderbook_snapshot'||!Array.isArray(m.yes_dollars_fp)||!Array.isArray(m.no_dollars_fp))throw Error('snapshot');
    ({sid,seq}=f);clock=m.clock;marketId=m.market_id;snapshot=m;snapshotSentAtMs=f.sending_ts_ms;continue;
   }
   if(f.type!=='orderbook_delta'||f.sid!==sid||f.seq!==seq+1||m.clock<=clock||m.market_id!==marketId||
      !safe(m.ts_ms)||m.ts_ms>f.sending_ts_ms||recvMs-m.ts_ms>5000||
      f.sending_ts_ms<snapshotSentAtMs||recvMs-snapshotSentAtMs>5000)throw Error('continuity');
   const depth=bookAfterDelta(snapshot,m);
   return {status:'VENUE_TIMESTAMPED_BOOK_OBSERVED',ordersEnabled:false,ticker,sid,seq:f.seq,clock:m.clock,snapshotSentAtMs,depth,
      eventAtMs:m.ts_ms,venueSentAtMs:f.sending_ts_ms,localReceivedAtMs:recvMs,localElapsedMs:elapsed};
  }
 }catch{}finally{clearTimeout(timer);ac.abort();try{socket?.close();}catch{}}
 return {status:'VENUE_TIMESTAMPED_EVIDENCE_UNVERIFIED',ordersEnabled:false};
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href)
 console.log(JSON.stringify(await capture()));
