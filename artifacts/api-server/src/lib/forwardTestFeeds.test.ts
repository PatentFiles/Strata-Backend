import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createPublicForwardTestFeeds} from './forwardTestFeeds';
const NOW=Date.parse('2026-10-29T00:45:10Z'),TICKER='KXBTC15M-26OCT282100-00';
const market=(extra:Record<string,unknown>={})=>({ticker:TICKER,status:'active',open_time:'2026-10-29T00:45:00Z',
 close_time:'2026-10-29T01:00:00Z',floor_strike:81086.06,yes_ask_dollars:'0.4600',no_ask_dollars:'0.5500',...extra});
function feeds(list:unknown[],detail:unknown,at=NOW){
 const calls:string[]=[];
 const fetchImpl:typeof fetch=async(input,init)=>{
  assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
  assert.equal(init?.cache,'no-store');assert.equal(init?.method,undefined);
  const url=String(input);calls.push(url);
  return new Response(JSON.stringify(url.includes('?')?{markets:list}:{market:detail}));
 };
 return {api:createPublicForwardTestFeeds(fetchImpl,()=>new Date(at)),calls};
}
test('bounded discovery refreshes exact detail and never uses cached list quotes or status',async()=>{
 const f=feeds([market({status:'initialized',floor_strike:null,yes_ask_dollars:'0.9900'})],market());
 const m=await f.api.market();
 assert.equal(m.yesAsk,.46);assert.equal(m.target,81086.06);
 assert.match(f.calls[0],/min_close_ts=1793234701&max_close_ts=1793236500/);
 assert.doesNotMatch(f.calls[0],/status=/);assert.equal(f.calls.length,2);
 assert.equal(f.calls[1].endsWith('/'+TICKER),true);
});
test('expired and future candidates cannot route current discovery',async()=>{
 for(const row of [market({close_time:'2026-10-29T00:45:00Z'}),market({open_time:'2026-10-29T00:50:00Z'})]){
  const f=feeds([row],market());await assert.rejects(f.api.market(),/no current market/);assert.equal(f.calls.length,1);
 }
});
test('mismatched, closed or still-initialized detail never becomes a current market',async()=>{
 for(const row of [market({ticker:'OTHER'}),market({status:'closed'}),market({status:'initialized'})]){
  const f=feeds([market()],row);await assert.rejects(f.api.market());
 }
});
test('explicit expired contract reads retain settlement handling without discovery',async()=>{
 const f=feeds([],market({status:'settled',result:'no',close_time:'2026-10-29T00:45:00Z'}));
 const m=await f.api.market(TICKER);assert.equal(m.result,'no');assert.equal(f.calls.length,1);
});
test('incomplete exact strike is not replaced by the cached list strike',async()=>{
 const f=feeds([market()],market({floor_strike:null}));assert.equal((await f.api.market()).target,null);
});
test('recorded public rollover replay shows discovery availability, not invented crossings',async()=>{
 const rows=readFileSync(resolve('../../research/discovery-boundary-20261029/observations.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const bounded=rows.filter(x=>x.source==='bounded'),detail=rows.filter(x=>x.source==='detail');
 let first:number|null=null;
 for(let i=0;i<bounded.length;i++){
  const r=bounded[i],d=detail[i];if(!d||r.error||d.error)continue;
  const f=feeds(r.markets,d.markets?.[0],Math.max(r.finished,d.finished)*1000);
  try{const m=await f.api.market();if(m.target!==null&&m.yesAsk!==null&&m.yesAsk>0&&m.noAsk!==null&&m.noAsk>0){first=Math.max(r.finished,d.finished);break;}}catch{}
 }
 const legacy=rows.find(x=>x.source==='legacy'&&x.markets?.some((m:Record<string,unknown>)=>m.ticker===TICKER&&m.status==='active'&&m.floor_strike!==null));
 assert.ok(first!==null&&legacy);assert.ok(legacy.finished-first>20);
});

test('fixed-point dollar prices take precedence over rounded legacy cent fields',async()=>{
 const row=market({yes_bid:1,yes_bid_dollars:'0.0125',yes_ask:2,yes_ask_dollars:'0.0250',
  no_bid:97,no_bid_dollars:'0.9750',no_ask:99,no_ask_dollars:'0.9875'});
 const m=await feeds([row],row).api.market();
 assert.equal(m.yesBid,.0125);assert.equal(m.yesAsk,.025);assert.equal(m.noBid,.975);assert.equal(m.noAsk,.9875);
});
test('legacy integer prices retain their cent unit including one cent and one dollar',async()=>{
 const {yes_ask_dollars:_yes,no_ask_dollars:_no,...row}=market({yes_bid:1,yes_ask:100,no_bid:0,no_ask:99});
 const m=await feeds([row],row).api.market();
 assert.equal(m.yesBid,.01);assert.equal(m.yesAsk,1);assert.equal(m.noBid,0);assert.equal(m.noAsk,.99);
});
test('malformed present dollar prices never fall back to legacy values or rescale as cents',async()=>{
 for(const value of ['5','1.01','-0.01','1e-2','',null,1]){
  const row=market({yes_bid:52,yes_bid_dollars:value,yes_ask:53,yes_ask_dollars:value});
  const m=await feeds([row],row).api.market();
  assert.equal(m.yesBid,null,JSON.stringify(value));assert.equal(m.yesAsk,null,JSON.stringify(value));
 }
});

test('public 429 identifies provider and suppresses repeated requests without fabricating fresh data',async()=>{
 let requests=0,wall=NOW,mono=100;
 const api=createPublicForwardTestFeeds(async()=>{requests++;return new Response('',{status:429,headers:{'Retry-After':'60'}})},()=>new Date(wall),()=>mono);
 await assert.rejects(api.btc(),/provider=coinbase.*HTTP 429.*retryAfterMs=60000/);
 wall+=60_000;mono+=5000;
 await assert.rejects(api.btc(),/provider=coinbase.*cooldown.*remainingMs=55000/);
 assert.equal(requests,1);
});

function routingHarness(){
 let now=NOW,mono=0,row=market();let failStatus=0;
 const calls:string[]=[];
 const api=createPublicForwardTestFeeds(async(input)=>{
  const url=String(input);calls.push(url);
  if(failStatus)return new Response('',{status:failStatus,headers:{'Retry-After':'30'}});
  return new Response(JSON.stringify(url.includes('?')?{markets:[row]}:{market:row}));
 },()=>new Date(now),()=>mono);
 return {api,calls,setTime:(value:number)=>{now=value;},advance:(ms:number)=>{now+=ms;mono+=ms;},
  setRow:(value:ReturnType<typeof market>)=>{row=value;},setFailure:(value:number)=>{failStatus=value;}};
}
test('identity routing reduces180 same-window cycles to1discovery but180 fresh exact observations',async()=>{
 const h=routingHarness();h.setTime(Date.parse('2026-10-29T00:45:00Z'));
 for(let i=0;i<180;i++){
  h.setRow(market({floor_strike:81086+i,yes_ask_dollars:i%2?'0.4700':'0.4600'}));
  const result=await h.api.market();
  assert.equal(result.target,81086+i);assert.equal(result.yesAsk,i%2?.47:.46);
  assert.equal(result.fetchedAt.getTime(),Date.parse('2026-10-29T00:45:00Z')+i*5000);
  h.advance(5000);
 }
 assert.equal(h.calls.filter(x=>x.includes('?')).length,1);
 assert.equal(h.calls.filter(x=>!x.includes('?')).length,180);
});
test('rollover invalidates route and discovers new contract with fresh missing strike retained',async()=>{
 const h=routingHarness();await h.api.market();
 h.setTime(Date.parse('2026-10-29T01:00:00Z'));
 const next=market({ticker:'KXBTC15M-NEXT',open_time:'2026-10-29T01:00:00Z',close_time:'2026-10-29T01:15:00Z',floor_strike:null});
 h.setRow(next);assert.equal((await h.api.market()).target,null);
 h.advance(1000);h.setRow({...next,floor_strike:82000});
 assert.equal((await h.api.market()).target,82000);
 assert.equal(h.calls.filter(x=>x.includes('?')).length,2);
 assert.equal(h.calls.at(-1)?.endsWith('/KXBTC15M-NEXT'),true);
});
test('cached identity never rescues missing prices or strike from fresh detail',async()=>{
 const h=routingHarness();await h.api.market();h.advance(5000);
 h.setRow(market({floor_strike:null,yes_ask_dollars:null,no_ask_dollars:null}));
 const result=await h.api.market();assert.equal(result.target,null);assert.equal(result.yesAsk,null);
 assert.equal(h.calls.length,3);
});
test('closed and mismatched fresh details invalidate route and require discovery next cycle',async()=>{
 for(const invalid of [market({status:'closed'}),market({ticker:'WRONG'})]){
  const h=routingHarness();await h.api.market();h.advance(5000);h.setRow(invalid);
  await assert.rejects(h.api.market());h.advance(5000);h.setRow(market());await h.api.market();
  assert.equal(h.calls.filter(x=>x.includes('?')).length,2);
 }
});
test('noncanonical contract dates never pin a discovery identity',async()=>{
 const h=routingHarness();h.setRow(market({open_time:'2026-10-29T00:44:59Z'}));
 await h.api.market();h.advance(5000);await h.api.market();assert.equal(h.calls.length,4);
});
test('wallclock regression invalidates routing even inside same market window',async()=>{
 const h=routingHarness();await h.api.market();h.setTime(NOW-1000);await h.api.market();
 assert.equal(h.calls.filter(x=>x.includes('?')).length,2);
});
test('explicit settlement lookup cannot poison current routing identity',async()=>{
 const h=routingHarness();await h.api.market();
 h.setRow(market({ticker:'OLD',status:'settled',result:'yes',close_time:'2026-10-29T00:45:00Z'}));
 assert.equal((await h.api.market('OLD')).result,'yes');
 h.advance(5000);h.setRow(market());await h.api.market();
 assert.equal(h.calls.filter(x=>x.includes('?')).length,1);
 assert.equal(h.calls.at(-1)?.endsWith('/'+TICKER),true);
});
test('provider cooldown still blocks fresh detail when a routing identity is cached',async()=>{
 const h=routingHarness();await h.api.market();h.advance(5000);h.setFailure(429);
 await assert.rejects(h.api.market(),/provider=kalshi endpoint=market_detail HTTP 429/);
 const count=h.calls.length;h.advance(5000);h.setFailure(0);
 await assert.rejects(h.api.market(),/provider=kalshi endpoint=market_detail cooldown/);
 assert.equal(h.calls.length,count);
 h.advance(25000);assert.equal((await h.api.market()).ticker,TICKER);
});

test('response crossing expiry rejects old contract then rediscovers next window',async()=>{
 let now=Date.parse('2026-10-29T00:59:59Z'),count=0;
 const calls:string[]=[];
 const api=createPublicForwardTestFeeds(async(input)=>{
  const url=String(input);calls.push(url);count++;
  if(count===2)now+=2000;
  const row=count<=2?market():market({ticker:'KXBTC15M-NEXT',open_time:'2026-10-29T01:00:00Z',close_time:'2026-10-29T01:15:00Z'});
  return new Response(JSON.stringify(url.includes('?')?{markets:[row]}:{market:row}));
 },()=>new Date(now));
 await assert.rejects(api.market(),/no current market/);
 assert.equal((await api.market()).ticker,'KXBTC15M-NEXT');
 assert.equal(calls.filter(x=>x.includes('?')).length,2);
});
test('aborted cached detail never returns previously successful quote',async()=>{
 let calls=0;
 const api=createPublicForwardTestFeeds(async(input,init)=>{
  calls++;if(init?.signal?.aborted)throw new Error('aborted');
  return new Response(JSON.stringify(String(input).includes('?')?{markets:[market()]}:{market:market()}));
 },()=>new Date(NOW));
 await api.market();const abort=new AbortController();abort.abort();
 await assert.rejects(api.market(undefined,abort.signal),/request_failed aborted=true/);
 assert.equal(calls,3);
});
test('invalid or regressed response clock never produces a current snapshot',async()=>{
 for(const bad of [NaN,NOW-1]){
  let now=NOW;
  const api=createPublicForwardTestFeeds(async input=>{
   const list=String(input).includes('?');if(!list)now=bad;
   return new Response(JSON.stringify(list?{markets:[market()]}:{market:market()}));
  },()=>new Date(now));
  await assert.rejects(api.market(),/clock invalid/);
 }
});
