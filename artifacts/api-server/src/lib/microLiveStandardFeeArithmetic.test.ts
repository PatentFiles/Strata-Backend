import test from 'node:test';import assert from 'node:assert/strict';
import {standardFeePerFillMicros} from './microLiveStandardFeeArithmetic';
const oracle=(tick:number)=>{const n=700n*BigInt(tick)*BigInt(10000-tick),d=100000000n;return (n+d-1n)/d;};
test('every valid four-decimal tick exactly matches original BigInt ceiling',()=>{
 for(let tick=1;tick<10000;tick++){
  const actual=standardFeePerFillMicros(tick);assert.equal(actual,oracle(tick),String(tick));
  assert.equal(actual,standardFeePerFillMicros(10000-tick));
 }
});
test('invalid ticks fail closed without numeric coercion',()=>{
 for(const value of [0,10000,-1,10001,.1,1.1,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER,'1',null,undefined,{},1n])assert.equal(standardFeePerFillMicros(value as number),null);
});

test('all valid ticks prove unchanged multiplier-one cash alignment and exit loss identities',()=>{
 for(let tick=1;tick<10000;tick++){
  const t=BigInt(tick),fee=oracle(tick);
  assert.ok(fee>=1n&&fee<=t&&fee<=10000n-t);
  const entry=((t+fee+9999n)/10000n)*10000n;
  const exitProceeds=((t-fee)/10000n)*10000n;
  assert.equal(entry,10000n);assert.equal(exitProceeds,0n);
  assert.equal(t-exitProceeds,t);
 }
});

import {maximumEntryFeePerContractMicros,maximumExitFeePerContractMicros,
 maximumExitFeePerContractAtLimitMicros,maximumEntryCashDebitPerContractMicros,
 maximumExitCashDebitOnMarketGridPerContractMicros} from './microLiveEntryFees';
const sideTicks=(ticks:number[],side:'yes'|'no')=>side==='yes'?[...ticks]:ticks.map(t=>10000-t).filter(t=>t>0&&t<10000).sort((a,b)=>a-b);
const floor=(v:bigint)=>v>=0n?v/10000n*10000n:-((-v+9999n)/10000n)*10000n;
const bound=(ticks:number[],side:'yes'|'no',kind:'trade'|'exit',limit:number|null)=>{
 let max=0n;
 for(const tick of sideTicks(ticks,side)){
  if(kind==='trade'&&limit!==null&&tick>limit)break;
  if(kind==='exit'&&limit!==null&&tick<limit)continue;
  if(!Number.isSafeInteger(tick)||tick<=0||tick>=10000)return null;
  const fee=oracle(tick),value=kind==='trade'?fee:BigInt(tick)-floor(BigInt(tick)-fee);
  if(value>max)max=value;
 }
 return kind==='exit'&&max===0n?null:Number(max*100n);
};
test('sparse, asymmetric, unsorted and malformed grid traversals retain BigInt results',()=>{
 const grids:number[][]=[[1,5000,9999],[3700,3800],[9999,1,5000],[],[0,1,5000],[1,NaN,5000],[1,5000,10000],[1,1.5,9999]];
 let seed=73;for(let n=0;n<50;n++){const ticks=[];for(let i=0;i<30;i++){seed=(seed*16807)%2147483647;ticks.push(1+seed%9999);}grids.push([...new Set(ticks)].sort((a,b)=>a-b));}
 for(const ticks of grids)for(const side of ['yes','no'] as const)for(const value of [1,'1.000000']){
  assert.equal(maximumExitFeePerContractMicros(value,ticks,side),bound(ticks,side,'exit',null));
  for(const limit of [1,3700,5000,9999]){
   const text=(limit/10000).toFixed(4),present=sideTicks(ticks,side).includes(limit);
   assert.equal(maximumEntryFeePerContractMicros(value,text,ticks,side),present?bound(ticks,side,'trade',limit):null);
   assert.equal(maximumExitFeePerContractAtLimitMicros(value,text,ticks,side),present?bound(ticks,side,'exit',limit):null);
  }
 }
});
test('whole-grid cash/debit bounds remain identical at every selected singleton tick on both sides',()=>{
 for(let tick=1;tick<10000;tick++)for(const side of ['yes','no'] as const){
  const text=(tick/10000).toFixed(4),price=((side==='yes'?tick:10000-tick)/10000).toFixed(4);
  const range=[{start:text,end:text,step:'0.0001'}];
  assert.equal(maximumEntryCashDebitPerContractMicros(1,price,range,side),1000000);
  assert.equal(maximumExitCashDebitOnMarketGridPerContractMicros(1,range,side,price),0);
 }
});
