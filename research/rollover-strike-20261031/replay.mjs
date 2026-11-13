// Offline scheduling comparison only. Does not call any provider or alter production.
import assert from 'node:assert/strict';
const schedules={
 current:[0,1,2,3,4,5,6,7,8,9,10,15,20,25,30],
 spreadSameReads:[0,1,3,5,7,9,10,12,14,15,17,19,20,25,30],
 twoSecondFirst20:[0,2,4,6,8,10,12,14,16,18,20,25,30],
};
for(const [name,schedule] of Object.entries(schedules)){
 assert.ok(schedule.every((v,i)=>i===0||v-schedule[i-1]>=1),name);
 assert.ok(schedule.length<=schedules.current.length,name);
}
const requested=[0,1,5,11,15,20,30];
const results=Object.entries(schedules).map(([name,schedule])=>{
 const rows=requested.map(ready=>{const observed=schedule.find(t=>t>=ready);return {strikeReadySeconds:ready,firstObservedSeconds:observed,delaySeconds:observed-ready,readsThroughRecovery:schedule.indexOf(observed)+1};});
 // Uniform hypothetical availability is not an empirical provider distribution.
 const delays=Array.from({length:301},(_,i)=>i/10).map(ready=>schedule.find(t=>t>=ready)-ready).sort((a,b)=>a-b);
 return {name,schedule,readsIfMissingThrough30s:schedule.length,rows,
  hypotheticalUniformMeanDelay:delays.reduce((a,b)=>a+b,0)/delays.length,
  hypotheticalUniformP95Delay:delays[Math.ceil(delays.length*.95)-1],
  maximumDelay:Math.max(...delays)};
});
assert.equal(results[0].rows.find(r=>r.strikeReadySeconds===11).firstObservedSeconds,15);
assert.equal(results[1].rows.find(r=>r.strikeReadySeconds===11).firstObservedSeconds,12);
assert.ok(schedules.spreadSameReads.find(t=>t>=2)>schedules.current.find(t=>t>=2),'spread is not universally better');
console.log(JSON.stringify({simulationOnly:true,providerTimingProven:false,productionPolicyChanged:false,results},null,2));
