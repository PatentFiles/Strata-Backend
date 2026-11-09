import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
// Execute the actual pure paper-close function without importing runtime/DB code.
// No alternative implementation of its decision branch exists in this fixture.
const source=readFileSync(new URL('./forwardTestWorker.ts',import.meta.url),'utf8');
const start=source.indexOf('export function paperClose(');
const end=source.indexOf('\nasync function recordCycleError',start);
assert(start>=0&&end>start);
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};
runInNewContext(code,{exports,roundMoney:value=>Math.round(value*100)/100,
 validOffer:value=>value!==null&&Number.isFinite(value)&&value>0&&value<=1});
const paperClose=exports.paperClose;
const now=new Date('2026-11-09T20:00:00Z');
const market={result:null,fetchedAt:now,endsAt:new Date(now.getTime()+1),yesBid:.53,noBid:.36};
const position=direction=>({direction,contracts:3,stake:1.5});
for(const direction of ['UP','DOWN'])for(const reason of ['Momentum invalidated','Wrong-side recross']){
 test(`${direction} ${reason}: boundary and expired unresulted markets cannot book a sale`,()=>{
  for(const offset of [0,-1,-60000])assert.equal(paperClose(position(direction),{...market,endsAt:new Date(now.getTime()+offset)},0,reason,now),null);
 });
 test(`${direction} ${reason}: pre-expiry quote behavior is preserved`,()=>{
  const result=paperClose(position(direction),market,0,reason,now);
  assert.equal(result.status,'CLOSED');assert.equal(result.exitPrice,direction==='UP'?.53:.36);
  assert.equal(result.pnl,direction==='UP'?.09:-.42);
 });
}
test('explicit settled result still takes priority without an executable quote',()=>{
 for(const direction of ['UP','DOWN'])for(const result of ['yes','no']){
  const closed=paperClose(position(direction),{...market,result,endsAt:new Date(now.getTime()-60000),yesBid:null,noBid:null},0,'Momentum invalidated',now);
  assert.equal(closed.status,'SETTLED');assert.equal(closed.exitPrice,(direction==='UP')===(result==='yes')?1:0);
 }
});
test('expired without exit intent remains open pending authoritative result',()=>{
 assert.equal(paperClose(position('UP'),{...market,endsAt:new Date(now.getTime()-1)},0,null,now),null);
});
test('invalid expiry or decision time cannot establish a pre-expiry sale',()=>{
 for(const endsAt of [null,new Date(NaN)])assert.equal(paperClose(position('UP'),{...market,endsAt},0,'Momentum invalidated',now),null);
 assert.equal(paperClose(position('UP'),market,0,'Momentum invalidated',new Date(NaN)),null);
});

test('old cycle clock cannot permit an exit using a quote decoded at/after expiry',()=>{
 const endsAt=new Date(now.getTime()+10);
 for(const direction of ['UP','DOWN'])for(const offset of [0,1,60000]){
  assert.equal(paperClose(position(direction),{...market,endsAt,fetchedAt:new Date(endsAt.getTime()+offset)},0,'Momentum invalidated',now),null);
 }
 assert.equal(paperClose(position('UP'),{...market,endsAt,fetchedAt:new Date(endsAt.getTime()-1)},0,'Momentum invalidated',now)?.status,'CLOSED');
 assert.equal(paperClose(position('UP'),{...market,fetchedAt:new Date(NaN)},0,'Momentum invalidated',now),null);
});
