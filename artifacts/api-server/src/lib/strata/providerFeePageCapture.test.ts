import test from "node:test";
import assert from "node:assert/strict";
import {captureOfficialPredictionFeePage,OFFICIAL_PREDICTION_FEE_PAGE} from "./providerFeePageCapture";

const markup="<!DOCTYPE html><html><head><title>Fee schedule</title></head><body>"+
 "Official publisher HTML can be dynamic: this is not an authenticated fee formula or approval. ".repeat(5)+
 "</body></html>";

function htmlResponse(body=markup,opts:{status?:number;url?:string;type?:string;redirected?:boolean}={}):Response{
 const response=new Response(body,{status:opts.status??200,headers:{"content-type":opts.type??"text/html"}});
 Object.defineProperty(response,"url",{value:opts.url??OFFICIAL_PREDICTION_FEE_PAGE});
 Object.defineProperty(response,"redirected",{value:opts.redirected??false});
 return response;
}
test("official HTML capture returns digest but NEVER fee or order authority",async()=>{
 let called=0;
 const result=await captureOfficialPredictionFeePage(
  (async(url,opts)=>{
   called++;
   assert.equal(url,OFFICIAL_PREDICTION_FEE_PAGE);
   assert.equal(opts?.method,"GET");
   assert.equal(opts?.redirect,"error");
   assert.equal(opts?.cache,"no-store");
   assert.deepEqual(opts?.headers,{Accept:"text/html"});
   return htmlResponse();
  }) as typeof fetch,
  (()=>{let n=1_780_000_000_000;return ()=>n++;})(),
 );
 assert.equal(called,1);
 assert.equal(result.ok,true);
 if(result.ok){
  assert.match(result.sha256,/^[a-f0-9]{64}$/);
  assert.equal(result.providerContentReceived,true);
  assert.equal(result.currentFeeFormulaVerified,false);
  assert.equal(result.sourcePolicyApproved,false);
  assert.equal(result.exchangeExecutionAuthorized,false);
 }
});
test("provider HTTP 429 is a hard error, never an approved source",async()=>{
 const result=await captureOfficialPredictionFeePage(
  (async()=>htmlResponse(markup,{status:429})) as typeof fetch);
 assert.deepEqual([result.ok,result.sourcePolicyApproved,result.exchangeExecutionAuthorized],
  [false,false,false]);
 assert.equal(result.reason,"official_page_http_429");
});
test("rejects redirected, wrong origin and non HTML provider responses",async()=>{
 for(const response of [
  htmlResponse(markup,{url:"https://attacker.example/fee-schedule"}),
  htmlResponse(markup,{redirected:true}),
  htmlResponse(markup,{type:"application/pdf"}),
  htmlResponse("<html>tiny</html>"),
  htmlResponse("not HTML, just a spoofed body ".repeat(20)),
 ]){
  const result=await captureOfficialPredictionFeePage((async()=>response) as typeof fetch);
  assert.equal(result.ok,false);
  assert.equal(result.sourcePolicyApproved,false);
 }
});
test("network and invalid clock fail closed",async()=>{
 const error=await captureOfficialPredictionFeePage(
  (async()=>{throw new Error("timeout")}) as typeof fetch);
 assert.equal(error.reason,"official_page_network_unavailable");
 const clock=await captureOfficialPredictionFeePage((async()=>htmlResponse()) as typeof fetch,
  ()=>Number.NaN);
 assert.equal(clock.reason,"capture_clock_invalid");
});
test("size bound and incomplete responses fail closed",async()=>{
 const oversized=htmlResponse("<!DOCTYPE html>"+("x".repeat(2_000_200))+"</html>");
 const response=await captureOfficialPredictionFeePage((async()=>oversized) as typeof fetch);
 assert.equal(response.ok,false);
 assert.equal(response.reason,"official_page_size_invalid");
 const empty=await captureOfficialPredictionFeePage((async()=>htmlResponse("")) as typeof fetch);
 assert.equal(empty.ok,false);
});
