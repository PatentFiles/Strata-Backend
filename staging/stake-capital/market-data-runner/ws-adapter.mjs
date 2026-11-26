import {endpoint} from './capture.mjs';
const channel='orderbook_delta', path='/trade-api/ws/v2';
const headers=['KALSHI-ACCESS-KEY','KALSHI-ACCESS-SIGNATURE','KALSHI-ACCESS-TIMESTAMP'];
export function bindPublicBookSocket({signHandshake,dial}={}) {
 if(typeof signHandshake!=='function'||typeof dial!=='function')return null;
 let used=false;
 return async ({url,signal})=>{
   if(used||url!==endpoint||!(signal instanceof AbortSignal))throw Error('handshake_refused');
   used=true;signal.throwIfAborted();
   const result=await signHandshake(Object.freeze({method:'GET',origin:new URL(endpoint).origin,path,signal}));
   if(result?.scope!=='MARKET_DATA_READ_ONLY'||result.method!=='GET'||result.path!==path||result.origin!==new URL(endpoint).origin||
      !result.headers||Object.keys(result.headers).length!==headers.length||
      !headers.every(k=>typeof result.headers[k]==='string'&&/^[!-~]{1,4096}$/.test(result.headers[k])))throw Error('signing_contract_refused');
   signal.throwIfAborted();
   const peer=await dial({url:endpoint,headers:Object.fromEntries(headers.map(k=>[k,result.headers[k]])),followRedirects:false,signal});
   let closed=false, subscribed=false;
   const close=()=>{if(closed)return;closed=true;signal.removeEventListener('abort',close);try{peer.close();}catch{}};
   signal.addEventListener('abort',close,{once:true});
   if(signal.aborted){close();throw Error('aborted');}
   return Object.freeze({
     async subscribe(req){
       if(closed||subscribed||req?.channel!==channel||req.updateIntervalMs!==0||
          !/^KXBTC15M-[A-Z0-9-]{1,80}$/.test(req?.ticker??''))throw Error('subscription_refused');
       subscribed=true;
       return peer.sendText(JSON.stringify({id:1,cmd:'subscribe',params:{channels:[channel],market_ticker:req.ticker}}));
     },
     async next(){
       if(closed||!subscribed)throw Error('socket_not_ready');
       const frame=await peer.nextText();
       if(frame===null)return {done:true};
       if(typeof frame!=='string'||Buffer.byteLength(frame)>256*1024)throw Error('frame_refused');
       const value=JSON.parse(frame);
       if(value?.type==='subscribed'&&value?.msg?.channel!==channel)throw Error('channel_refused');
       if(!['subscribed','orderbook_snapshot','orderbook_delta'].includes(value?.type))throw Error('frame_kind_refused');
       return {done:false,value};
     },
     close,
   });
 };
}
