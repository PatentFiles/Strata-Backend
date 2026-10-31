import test from "node:test";
import assert from "node:assert/strict";
import {createMarketEvidenceReadTiming,attachMarketEvidenceReadTiming,getMarketEvidenceReadTiming} from "./marketEvidenceReadTiming";
test("full-read durations are measured, bounded, immutable and non-serializing",async()=>{
 let now=100;const clock=createMarketEvidenceReadTiming(()=>now);
 now=110;await clock.read("book",async()=>{now=125;return {rawBody:"SECRET"};});
 const snapshot=clock.snapshot()!;
 assert.deepEqual(snapshot.reads.book,{startOffsetMs:10,elapsedMs:15,outcome:"completed"});
 assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot.reads));assert.ok(Object.isFrozen(snapshot.reads.book));
 const book={observedAtMs:1};attachMarketEvidenceReadTiming(book,snapshot);
 assert.equal(getMarketEvidenceReadTiming(book),snapshot);assert.equal(book.observedAtMs,1);
 assert.equal(JSON.stringify(book),'{"observedAtMs":1}');assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
});
test("clock/observer failures cannot affect reads, errors retain exact identity",async()=>{
 const broken=createMarketEvidenceReadTiming(()=>{throw Error("clock");});
 assert.equal(await broken.read("market",async()=>42),42);
 assert.deepEqual(broken.snapshot()!.reads.market,{startOffsetMs:null,elapsedMs:null,outcome:"completed"});
 const error=Error("HTTP 429 SECRET");
 await assert.rejects(broken.read("event",async()=>{throw error;}),e=>e===error);
 assert.equal(broken.snapshot()!.reads.event!.outcome,"rejected");
 assert.ok(!JSON.stringify(broken.snapshot()).includes("SECRET"));
 for(const bad of [NaN,Infinity,-1]){
  let calls=0;const clock=createMarketEvidenceReadTiming(()=>calls++?bad:10);
  await clock.read("book",async()=>{});assert.equal(clock.snapshot()!.reads.book!.startOffsetMs,null);
 }
});

test("untrusted casted timing attachment cannot bypass diagnostic provenance",()=>{
 const book={};
 attachMarketEvidenceReadTiming(book,{rawBody:"SECRET"} as never);
 assert.equal(getMarketEvidenceReadTiming(book),undefined);
});
