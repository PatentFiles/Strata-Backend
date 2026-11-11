import test from 'node:test';import assert from 'node:assert/strict';
import {prepareDirectPrecisionBounds} from './directPrecisionCashBounds';
const full=Array.from({length:9999},(_,i)=>i+1);
test('direct bounds support historical gross-max counts conditionally under unchanged reserve',()=>{
 for(const side of ['YES','NO'] as const){const b=prepareDirectPrecisionBounds(full,side)!;
 assert.deepEqual(b(.52),{cash:540000,trade:17500,exit:27400});
 assert.deepEqual(b(.43),{cash:450000,trade:17200,exit:27400});
 assert.equal(Math.ceil(b(.52)!.cash*9/10000)+Math.ceil(b(.52)!.exit*9/10000),511);
 assert.equal(Math.ceil(b(.43)!.cash*11/10000)+Math.ceil(b(.43)!.exit*11/10000),526);
 }});
test('prefix cash bounds are price-specific, source arrays are captured',()=>{
 const ticks=[100,4000,5000,6000];const b=prepareDirectPrecisionBounds(ticks,'YES')!;ticks.fill(9999);
 assert.equal(b(.4)!.cash,420000);assert.equal(b(.5)!.cash,520000);assert.equal(b(.6)!.cash,620000);assert.equal(b(.41),null);
});
test('invalid grid or limit never produces a bound',()=>{
 for(const ticks of [[],[0],[10000],[1,1],[NaN],new Array(3)])assert.equal(prepareDirectPrecisionBounds(ticks,'YES'),null);
 const b=prepareDirectPrecisionBounds(full,'NO')!;for(const p of [0,1,.12345,NaN,Infinity])assert.equal(b(p),null);
});
test('minimum fragment envelopes dominate all larger fragment sizes, every price',()=>{
 const b=prepareDirectPrecisionBounds(full,'YES')!;
 const ceil=(a:bigint,d:bigint)=>(a+d-1n)/d;
 for(let p=1;p<=9999;p++)for(const units of [1n,7n,99n,100n,1100n]){
 const gross=BigInt(p)*units,fee=ceil(7n*BigInt(p)*BigInt(10000-p)*units,1000000n);
 const debit=ceil(gross+fee,100n)*100n,proceeds=(gross-fee)/100n*100n;
 const bound=b(p/10000)!;assert.ok(debit*100n<=BigInt(bound.cash)*units);assert.ok((gross-proceeds)*100n<=BigInt(bound.exit)*units);
 }
});

test('mixed-price taker/maker fragments and peak pre-rebate charges stay inside envelope',()=>{
 const bound=prepareDirectPrecisionBounds(full,'YES')!(.52)!;
 const ceil=(a:bigint,d:bigint)=>(a+d-1n)/d;
 let seed=31273;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let scenario=0;scenario<100;scenario++){
  let debit=0n,rawDebit=0n,exitLoss=0n,totalUnits=0n;
  for(let fragment=0;fragment<100;fragment++){
   const price=BigInt(1+random()%5200),units=BigInt(1+random()%100);
   // Reviewed taker .07 ceiling dominates maker .0175. Fee rounded UP to
   // whole microdollars before direct balance alignment. No rebate credited.
   const divisor=fragment%2?4000000n:1000000n;
   const fee=ceil(7n*price*(10000n-price)*units,divisor),gross=price*units;
   rawDebit+=gross+fee;debit+=ceil(gross+fee,100n)*100n;
   exitLoss+=gross-(gross-fee)/100n*100n;totalUnits+=units;
   assert.ok(debit*100n<=BigInt(bound.cash)*totalUnits);
   assert.ok(exitLoss*100n<=BigInt(bound.exit)*totalUnits);
   // Order-cumulative alignment cannot charge more than independent upward
   // rounding on every fill. Ignoring all later credits protects peak debit.
   assert.ok(ceil(rawDebit,100n)*100n<=debit);
  }
 }
});
