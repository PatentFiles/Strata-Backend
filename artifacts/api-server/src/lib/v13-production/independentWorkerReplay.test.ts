import assert from "node:assert/strict";
import test from "node:test";
import {IndependentWorkerReplay,type IndependentReplayEntryProof,type IndependentReplayGate} from "./independentWorkerReplay";

const account={ownerId:"fixture-owner",accountId:"fixture-account"};
const gate=():IndependentReplayGate=>({...account,revision:"1",fence:"1",stop:false,revoked:false,unknown:false,
  positionId:null,heldMarket:null,maxAgeMs:5000});
const entry:IndependentReplayEntryProof={...account,sourceId:"direct-1",marketTicker:"KXBTC15M-FIXTURE",
  crossingKey:"KXBTC15M-FIXTURE:first",evidenceSha256:"a".repeat(64),originalOldestMs:1000,
  originalObservedMs:1100,marketCloseMs:8000,submissionAuthorized:false};
test("independent replay discovers committed work without a hint and never grants submission",async()=>{
 let lastHint:string|null|undefined,read=0;
 const worker=new IndependentWorkerReplay(account,{
   readGate:async()=>gate(),discoverEntries:async(_s,_t,h)=>{lastHint=h;return [entry];},
   rereadEntry:async(_s,_t,p)=>{read++;assert.equal(p.sourceId,entry.sourceId);return entry;},
   readHeld:async()=>{throw Error("flat path never reads held");},now:()=>6000,
 });
 assert.equal((await worker.tick()).status,"observed_entry");assert.equal(lastHint,null);
 const duplicate=await worker.tick("ignored-hint");
 assert.equal(duplicate.status,"no_fresh_work");assert.equal(duplicate.submissionAuthorized,false);assert.equal(read,1);
});
test("fail closed when original source, control snapshot or age changes",async()=>{
 for(const kind of ["source","gate","expired"] as const){
  let n=0;
  const worker=new IndependentWorkerReplay(account,{
    readGate:async()=>({...gate(),stop:kind==="gate"&&++n===2}),
    discoverEntries:async()=>[entry],
    rereadEntry:async()=>({...entry,evidenceSha256:kind==="source"?"b".repeat(64):entry.evidenceSha256}),
    readHeld:async()=>null,now:()=>kind==="expired"?6001:6000,
  });
  const out=await worker.tick();
  assert.notEqual(out.status,"observed_entry");assert.equal(out.submissionAuthorized,false);
 }
});
test("held replay uses the held market, rejects a changed observation and never evaluates entry",async()=>{
 let n=0,changed=false;
 const heldGate={...gate(),positionId:"old-position",heldMarket:"KXBTC15M-HELD"};
 const worker=new IndependentWorkerReplay(account,{
   readGate:async()=>heldGate,discoverEntries:async()=>{throw Error("must not enter while held");},
   rereadEntry:async()=>{throw Error("must not read entries while held");},
   readHeld:async(_s,pos,market)=>{
     assert.equal(pos,"old-position");assert.equal(market,"KXBTC15M-HELD");n++;
     return {...entry,marketTicker:market,positionId:pos,observationId:changed&&n%2===0?"replacement":"held-observation"};
   },
   now:()=>6000,
 });
 const accepted=await worker.tick("active-next-market");
 assert.equal(accepted.status,"observed_held_exit");assert.equal(accepted.submissionAuthorized,false);assert.equal(n,2);
 changed=true;assert.equal((await worker.tick()).status,"stopped_or_unverified");assert.equal(n,4);
});
