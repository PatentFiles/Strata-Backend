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
