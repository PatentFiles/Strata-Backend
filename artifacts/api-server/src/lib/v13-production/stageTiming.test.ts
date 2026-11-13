import test from "node:test";
import assert from "node:assert/strict";
import {beginExecutionStage,timedFinalFetch,type StageTiming,type TimingObserver} from "./stageTiming";
import {createEntryWireClockFetch,isEntryWireClockRefusal} from "../strata/entryWireClock";
const context={accountId:"account-test",mode:"LIVE" as const};
const orderId="v13p-11111111-1111-4111-8111-111111111111";
const init={method:"POST",body:JSON.stringify({reduce_only:false,client_order_id:orderId})};
const url="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders";
test("monotonic elapsed is nonnegative, one event only, and metadata excludes arbitrary payloads",async()=>{
 const events:StageTiming[]=[];let n=0;
 const end=beginExecutionStage(e=>{events.push(e)},"evaluation_age_admission",{...context,evaluationId:"secret payload\n"},()=>[40,35][n++]!);
 end("rejected",{sourceAgeMs:5001,error:Error("production_evaluation_stale")});end("completed");
 await Promise.resolve();
 assert.equal(events.length,1);assert.equal(events[0]!.durationMs,0);
 assert.equal(events[0]!.evaluationId,undefined);assert.equal(events[0]!.sourceAgeMs,5001);
 assert.equal(events[0]!.reason,"production_evaluation_stale");
 const redact=beginExecutionStage(e=>{events.push(e)},"dispatch",context);
 redact("rejected",{error:Error("Bearer secret-provider-response")});
 await Promise.resolve();
 assert.equal(events[1]!.reason,"execution_error_details_redacted");
});
test("throwing, rejected and never-settling observers cannot block or change a single HTTP attempt",async()=>{
 for(const observer of [()=>{throw Error("observer")},()=>Promise.reject(Error("observer")),()=>new Promise<void>(()=>{})] satisfies TimingObserver[]){
  let calls=0;const response=new Response("ok");
  const raw:typeof fetch=()=>{calls++;return Promise.resolve(response)};
  const measured=timedFinalFetch(raw=>raw,raw,observer,context);
  const pending=measured(url,init);assert.equal(calls,1,"no new awaited step before raw HTTP");
  assert.equal(await pending,response);assert.equal(calls,1);
 }
});
test("pre-send stale refusal is explicit and has no RTT; transport failure is network error and never retried",async()=>{
 const events:StageTiming[]=[];let calls=0;
 const observe:TimingObserver=e=>{events.push(e)};
 const raw:typeof fetch=()=>{calls++;return Promise.reject(Error("network_failed"))};
 const refused=timedFinalFetch(raw=>createEntryWireClockFetch(()=>{throw Error("production_final_wire_source_expired")},raw),raw,observe,context);
 await assert.rejects(async()=>refused(url,init),error=>isEntryWireClockRefusal(error,orderId));
 assert.equal(calls,0);assert.equal(events.length,1);assert.equal(events[0]!.outcome,"rejected");
 assert.equal(events[0]!.reason,"production_final_wire_source_expired");
 events.length=0;
 const failed=timedFinalFetch(raw=>createEntryWireClockFetch(()=>{},raw),raw,observe,context);
 await assert.rejects(failed(url,init),/network_failed/);
 assert.equal(calls,1);assert.deepEqual(events.map(e=>[e.stage,e.outcome]),[
  ["final_fee_and_authorization","completed"],["http_ack","network_error"]]);
 assert.ok(events.every(e=>e.intentId===orderId.slice(5)));
});
test("fee delay is not provider ACK time and concurrent attempts have isolated stage completion",async()=>{
 const events:StageTiming[]=[];let release!:()=>void,calls=0,factories=0;
 const held=new Promise<void>(resolve=>{release=resolve});
 const measured=timedFinalFetch(raw=>{factories++;return async(request,init)=>{
  if(init?.body==="slow")await held;return raw(request,init);
 }},async()=>{calls++;return new Response(null,{status:204})},e=>{events.push(e)},context);
 assert.equal(factories,1,"guards validate at construction, not delayed until dispatch");
 const slow=measured(url,{body:"slow"});assert.equal(calls,0);
 await measured(url,{body:"fast"});assert.equal(events.length,2);
 release();await slow;assert.equal(calls,2);assert.equal(events.length,4);
 assert.ok(events.every(e=>Number.isFinite(e.durationMs)&&e.durationMs>=0));
 assert.deepEqual(events.filter(e=>e.stage==="http_ack").map(e=>e.httpStatus),[204,204]);
});

test("observer code cannot run between final wire clock check and raw send",async()=>{
 let now=4999,sentAt=-1,observations=0;
 const observer:TimingObserver=()=>{observations++;now+=10000;};
 const measured=timedFinalFetch(raw=>createEntryWireClockFetch(()=>{
  assert.ok(now<=5000);
  beginExecutionStage(observer,"wire_source_admission",context)("eligible",{sourceAgeMs:now});
 },raw),()=>{sentAt=now;assert.equal(observations,0);return Promise.resolve(new Response())},observer,context);
 await measured(url,init);assert.equal(sentAt,4999);assert.ok(observations>0);
});
