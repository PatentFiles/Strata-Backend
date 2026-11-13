import assert from "node:assert/strict";
import test from "node:test";
import { createReadOnlyRateLimit } from "./readOnlyRateLimit";

test("read cooldown honors Retry-After and does not affect another endpoint", () => {
  let t=0; const gate=createReadOnlyRateLimit(()=>1_000_000,()=>t);
  const a=gate.begin("key/balance","balance"); assert.equal(a.blocked,null);
  assert.equal(a.limited!("60").remainingMs,60_000);
  const blocked=gate.begin("key/balance","balance").blocked!;
  assert.equal(blocked.responseReceived,false); assert.equal(blocked.remainingMs,60_000);
  assert.equal(gate.begin("key/positions","positions").blocked,null);
  assert.equal(gate.begin("other/balance","balance").blocked,null);
  t=60_000; assert.equal(gate.begin("key/balance","balance").blocked,null);
});
test("older success cannot clear a later concurrent 429; fresh success resets backoff",()=>{
  let t=0;const gate=createReadOnlyRateLimit(()=>0,()=>t);
  const older=gate.begin("x","x"), newer=gate.begin("x","x");
  newer.limited!(null); older.success!();
  assert.ok(gate.begin("x","x").blocked);
  t=30_000; assert.equal(gate.begin("x","x").limited!(null).remainingMs,60_000);
  t=90_000;gate.begin("x","x").success!();
  assert.equal(gate.begin("x","x").limited!(null).remainingMs,30_000);
});
test("HTTP date converts once; regressed clocks cannot shorten hold; malformed fallback bounded",()=>{
  let wall=Date.parse("Fri, 30 Oct 2026 18:00:00 GMT"),t=500;
  const gate=createReadOnlyRateLimit(()=>wall,()=>t);
  assert.equal(gate.begin("x","x").limited!("Fri, 30 Oct 2026 18:01:00 GMT").remainingMs,60_000);
  wall+=100000000;t=0;assert.equal(gate.begin("x","x").blocked!.remainingMs,60_000);
  t=60500;
  for(let i=0;i<8;i++){const r=gate.begin("x","x").limited!("invalid");assert.ok(r.remainingMs<=300000);t+=r.remainingMs;}
});
test("zero Retry-After keeps minimum hold; invalid monotonic clock fails closed",()=>{
  const gate=createReadOnlyRateLimit(()=>0,()=>0);
  assert.equal(gate.begin("x","x").limited!("0").remainingMs,1000);
  assert.throws(()=>createReadOnlyRateLimit(()=>0,()=>NaN).begin("x","x"));
});

test("diagnostic emitter whitelists endpoint and finite durations and never spreads extra properties",async()=>{
  const {emitReadRateLimitDiagnostic}=await import("./readOnlyRateLimit");
  const original=console.warn;const logs:string[]=[];console.warn=(line)=>{logs.push(String(line));};
  try{
    emitReadRateLimitDiagnostic({provider:"kalshi",endpoint:"secret-query",responseReceived:false,
      retryAfterMs:Infinity,remainingMs:-1,secret:"never-log"} as any);
    const row=JSON.parse(logs[0]!);assert.equal(row.endpoint,"unknown");
    assert.equal(row.retryAfterMs,null);assert.equal(row.remainingMs,null);
    assert.doesNotMatch(logs[0]!,/secret-query|never-log/);
  }finally{console.warn=original;}
});
