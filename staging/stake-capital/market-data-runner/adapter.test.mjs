import test from 'node:test';import a from 'node:assert/strict';
import {capture,endpoint} from './capture.mjs';
import {bindPublicBookSocket} from './ws-adapter.mjs';
import {run} from './runtime.mjs';
const headers={'KALSHI-ACCESS-KEY':'fixture','KALSHI-ACCESS-SIGNATURE':'fixture','KALSHI-ACCESS-TIMESTAMP':'1700000000000'};
const scopes=(req)=>({scope:'MARKET_DATA_READ_ONLY',origin:req.origin,path:req.path,method:req.method,headers});
test('inert runtime and wrong URL or issuer never dial',async()=>{
a.equal((await run('KXBTC15M-FIXTURE')).status,'READ_ONLY_SIGNER_UNAVAILABLE');
const signal=new AbortController().signal;
let n=0;const bind=(signHandshake)=>bindPublicBookSocket({signHandshake,dial(){n++;}});
await a.rejects(bind(scopes)({url:'wss://example.com/trade-api/ws/v2',signal}));
await a.rejects(bind(q=>({...scopes(q),scope:'WRITE'}))({url:endpoint,signal}));
a.equal(n,0);
});
test('one handshake and only public subscribe; malformed channel aborts and closes',async()=>{
let close=0,n=0,sign=0,sent=[];
const open=bindPublicBookSocket({signHandshake(q){sign++;a.equal(q.path,'/trade-api/ws/v2');return scopes(q);},dial(q){n++;a.equal(q.url,endpoint);a.equal(q.followRedirects,false);return {sendText(s){sent.push(JSON.parse(s));},nextText(){return '{"type":"subscribed","msg":{"channel":"user_orders"}}';},close(){close++;}};}});
a.equal((await capture({ticker:'KXBTC15M-FIXTURE',openReadOnly:open})).status,'VENUE_TIMESTAMPED_EVIDENCE_UNVERIFIED');
await a.rejects(open({url:endpoint,signal:new AbortController().signal}));
a.equal(sign,1);a.equal(n,1);a.equal(close,1);
a.deepEqual(sent,[{id:1,cmd:'subscribe',params:{channels:['orderbook_delta'],market_ticker:'KXBTC15M-FIXTURE'}}]);
});
