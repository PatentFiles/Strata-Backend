import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import WebSocket,{WebSocketServer} from 'ws';
import {run} from './runtime.mjs';
import {makeFixedTlsDial} from './tls-dial.mjs';
import {endpoint} from './capture.mjs';
const ticker='KXBTC15M-FIXTURE';
const headers={'KALSHI-ACCESS-KEY':'fixture','KALSHI-ACCESS-SIGNATURE':'fixture','KALSHI-ACCESS-TIMESTAMP':'1700000000000'};
const signHandshake=({origin,path,method})=>({scope:'MARKET_DATA_READ_ONLY',origin,path,method,headers});
test('real loopback TLS from reviewed runtime to a reconstructed book, with no orders',async()=>{
 const work=mkdtempSync(join(tmpdir(),'strata-local-tls-'));
 try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(work,'key'),'-out',join(work,'cert')],{stdio:'ignore'});
  const cert=readFileSync(join(work,'cert'));
  const server=createServer({key:readFileSync(join(work,'key')),cert});
  const wss=new WebSocketServer({server});
  try {
   await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
   let request, command;
   wss.on('connection',(wire,req)=>{
    request=req;
    wire.once('message',raw=>{
     command=JSON.parse(raw);
     const t=Date.now(), base={market_ticker:ticker,market_id:'fixture'};
     wire.send(JSON.stringify({type:'orderbook_snapshot',sid:1,seq:2,sending_ts_ms:t,msg:{...base,clock:100,yes_dollars_fp:[['0.48','8']],no_dollars_fp:[['0.49','7']]}}));
     wire.send(JSON.stringify({type:'orderbook_delta',sid:1,seq:3,sending_ts_ms:t,msg:{...base,clock:101,ts_ms:t,side:'no',price_dollars:'0.49',delta_fp:'-1.25'}}));
    });
   });
   function Local(url, opts) {
    assert.equal(url,endpoint);
    return new WebSocket(`wss://127.0.0.1:${server.address().port}/trade-api/ws/v2`,{...opts,ca:cert});
   }
   const out=await run(ticker,{signHandshake,dial:makeFixedTlsDial(Local)});
   assert.equal(out.status,'VENUE_TIMESTAMPED_BOOK_OBSERVED');
   assert.equal(out.ordersEnabled,false);
   assert.equal(request.url,'/trade-api/ws/v2');
   assert.equal(request.method,'GET');
   assert.equal(request.headers['kalshi-access-key'],'fixture');
   assert.deepEqual(command,{id:1,cmd:'subscribe',params:{channels:['orderbook_delta'],market_ticker:ticker}});
   assert.deepEqual(out.depth.yes,{entryAskLevels:[[5100,575]],exitBidLevels:[[4800,800]]});
   function Untrusted(url, opts) {
    return new WebSocket(`wss://127.0.0.1:${server.address().port}/trade-api/ws/v2`,opts);
   }
   assert.equal((await run(ticker,{signHandshake,dial:makeFixedTlsDial(Untrusted)})).status,'VENUE_TIMESTAMPED_EVIDENCE_UNVERIFIED');
  } finally { for (const peer of wss.clients) peer.terminate(); wss.close(); await new Promise(resolve=>server.close(resolve)); }
 } finally { rmSync(work,{recursive:true,force:true}); }
});
