import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { getScopedKalshiJson, KalshiApiError } from "./kalshiAccountClient";
const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const creds={keyId:"test-only-key",privateKey:privateKey.export({type:"pkcs8",format:"pem"}).toString()};

test("signed GET preserves real429 diagnostics and suppresses later sends without sharing other endpoint",async()=>{
  let sent=0;
  const fetcher=(async()=>{sent++;return new Response("{}",{status:429,headers:{"Retry-After":"120"}});}) as typeof fetch;
  const path="/trade-api/v2/portfolio/balance";
  await assert.rejects(getScopedKalshiJson(creds,path,"?subaccount=1",fetcher),e=>{
    assert.ok(e instanceof KalshiApiError);assert.equal(e.status,429);
    assert.equal(e.rateLimit?.responseReceived,true);assert.equal(e.rateLimit?.retryAfterMs,120000);
    assert.ok(!e.message.includes(creds.keyId));assert.ok(!e.message.includes("subaccount"));return true;
  });
  // An invalid signing key proves cooldown is checked before signature creation.
  await assert.rejects(getScopedKalshiJson({...creds,privateKey:"invalid"},path,"",fetcher),e=>{
    assert.ok(e instanceof KalshiApiError);assert.equal(e.rateLimit?.responseReceived,false);return true;
  });
  assert.equal(sent,1);
  await assert.rejects(getScopedKalshiJson(creds,"/trade-api/v2/portfolio/positions","",fetcher));
  assert.equal(sent,2);
});
test("successful signed GET stays fresh and is not cached; non429 retains typed status",async()=>{
  let sent=0;
  const fetcher=(async()=>{sent++;return new Response(JSON.stringify({n:sent}),{status:200});}) as typeof fetch;
  for(let n=1;n<=2;n++)assert.deepEqual(await getScopedKalshiJson(creds,"/trade-api/v2/portfolio/balance","",fetcher),{n});
  const forbidden=(async()=>new Response("",{status:403})) as typeof fetch;
  await assert.rejects(getScopedKalshiJson(creds,"/trade-api/v2/portfolio/balance","",forbidden),e=>{
    assert.ok(e instanceof KalshiApiError);assert.equal(e.status,403);assert.equal(e.rateLimit,undefined);return true;
  });
});

test("owned-feed boundary keeps stable reason but emits actual429 versus local cooldown diagnostics",async()=>{
  const {readOwnedKalshiFeeds}=await import("./strata/personalExchangeRead");
  const original=console.warn;const logs:string[]=[];console.warn=(line)=>{logs.push(String(line));};
  let sends=0;
  const fetcher=(async()=>{sends++;return new Response("sensitive provider payload",{status:429,headers:{"Retry-After":"60"}});}) as typeof fetch;
  const get:typeof getScopedKalshiJson=(c,path,query)=>getScopedKalshiJson(c,path,query,fetcher);
  try{
    for(let n=0;n<2;n++)assert.deepEqual(await readOwnedKalshiFeeds(creds,Date.now(),get),{ok:false,reason:"kalshi_read_rate_limited"});
    assert.equal(sends,1);assert.equal(logs.length,2);
    const [actual,local]=logs.map(line=>JSON.parse(line));
    assert.equal(actual.event,"strata_kalshi_read_rate_limit");
    assert.equal(actual.endpoint,"/trade-api/v2/portfolio/balance");
    assert.equal(actual.occurrence,"provider_response");assert.equal(actual.httpStatus,429);
    assert.equal(actual.retryAfterMs,60000);
    assert.equal(local.occurrence,"local_cooldown");assert.equal(local.httpStatus,null);
    assert.doesNotMatch(logs.join(""),/test-only-key|PRIVATE KEY|subaccount|sensitive provider payload|signature/i);
  }finally{console.warn=original;}
});
