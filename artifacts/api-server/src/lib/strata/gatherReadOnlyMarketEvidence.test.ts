import test from "node:test";
import assert from "node:assert/strict";
import { gatherReadOnlyMarketEvidence } from "./gatherReadOnlyMarketEvidence";

test("fee, orderbook and official metadata reads start concurrently but all must finish",async()=>{
 const started:string[]=[];
 let finishFee!:()=>void, finishBook!:()=>void;
 const fee=new Promise<void>(resolve=>{finishFee=resolve;});
 const book=new Promise<string>(resolve=>{finishBook=()=>resolve("signed book");});
 let completed=false;
 const result=gatherReadOnlyMarketEvidence({
  verifyFee:()=>{started.push("fee");return fee;},
  readBook:()=>{started.push("book");return book;},
  readSeries:async()=>{started.push("series");return "series metadata";},
  readMarket:async()=>{started.push("market");return "exact market metadata";},
 }).then(x=>{completed=true;return x;});
 assert.deepEqual(started,["fee","book","series","market"]);
 await Promise.resolve();assert.equal(completed,false);
 finishBook();await Promise.resolve();assert.equal(completed,false);
 finishFee();
 assert.deepEqual(await result,{
  bookPayload:"signed book",seriesPayload:"series metadata",marketPayload:"exact market metadata",
 });
 assert.equal(completed,true);
});

test("failed authoritative fee review prevents market evidence admission",async()=>{
 let completed=false;
 await assert.rejects(
  gatherReadOnlyMarketEvidence({
   verifyFee:async()=>{throw Error("fee_review_unavailable");},
   readBook:async()=>({market:"KXBTC15M"}),
   readSeries:async()=>({series:"KXBTC15M"}),
   readMarket:async()=>({market:"KXBTC15M"}),
  }).then(()=>{completed=true;}),
  /fee_review_unavailable/,
 );
 assert.equal(completed,false);
});

test("missing signed book or exact market metadata is fail closed",async()=>{
 for(const failed of ["book","market"]){
  let completed=false;
  await assert.rejects(gatherReadOnlyMarketEvidence({
   verifyFee:async()=>{},
   readBook:async()=>{if(failed==="book")throw Error("book_unavailable");return "book";},
   readSeries:async()=> "series",
   readMarket:async()=>{if(failed==="market")throw Error("market_unavailable");return "market";},
  }).then(()=>{completed=true;}),/unavailable/);
  assert.equal(completed,false);
 }
});
