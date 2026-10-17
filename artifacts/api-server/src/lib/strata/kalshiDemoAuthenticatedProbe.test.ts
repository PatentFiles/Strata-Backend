import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync} from "node:crypto";
import {probeAuthenticatedDemoBalance,DEMO_BALANCE_PATH} from "./kalshiDemoAuthenticatedProbe";
import {KALSHI_DEMO_ORIGIN} from "./kalshiDemoSignedReadOnly";

const key=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey
  .export({format:"pem",type:"pkcs8"}).toString();
const credentials={keyId:"demo-key-001",privateKeyPem:key,nowMs:()=>1780000000000};
const response=(body:unknown,status=200,ctype="application/json")=>
  new Response(JSON.stringify(body),{status,headers:{"content-type":ctype}});
function mock(body:unknown,status=200,ctype="application/json"){
  let calls=0;let exact=false;
  const fetchImpl=(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    calls++;
    exact=String(url)===KALSHI_DEMO_ORIGIN+DEMO_BALANCE_PATH;
    assert.equal(exact,true);
    assert.equal(init?.method,"GET");
    assert.equal(init?.redirect,"error");
    const headers=new Headers(init?.headers);
    assert.equal(headers.get("KALSHI-ACCESS-KEY"),credentials.keyId);
    assert.match(headers.get("KALSHI-ACCESS-SIGNATURE")??"",/^[A-Za-z0-9+/]+=*$/);
    assert.equal(headers.get("KALSHI-ACCESS-TIMESTAMP"),String(credentials.nowMs()));
    return response(body,status,ctype);
  }) as typeof fetch;
  return {fetchImpl,count:()=>calls};
}
test("real transport-shaped signed GET returns only redacted demo evidence",async()=>{
  const x=mock({balance:0,portfolio_value:0});
  const y=await probeAuthenticatedDemoBalance({...credentials,fetchImpl:x.fetchImpl});
  assert.equal(x.count(),1);
  assert.deepEqual(y,{
    environment:"KALSHI_DEMO",host:KALSHI_DEMO_ORIGIN,
    path:DEMO_BALANCE_PATH,method:"GET",httpStatus:200,
    authenticated:true,responseShapeVerified:true,
    tradingAuthorized:false,credentialsExposed:false,
    reason:"authenticated_demo_balance_get_verified",
  });
  assert.equal(JSON.stringify(y).includes(credentials.keyId),false);
  assert.equal(JSON.stringify(y).includes(key),false);
  assert.equal("balance" in y,false);
});
test("429, HTML, malformed JSON shape, error and timeout never retry",async()=>{
  for(const [body,status,ctype] of [
    [{code:"rate_limit"},429,"application/json"],
    ["<html>login</html>",200,"text/html"],
    [{orders:[]},200,"application/json"],
    [{balance:-1},200,"application/json"],
    [{balance:"00"},200,"application/json"],
  ] as const){
    const x=mock(body,status,ctype);
    const y=await probeAuthenticatedDemoBalance({...credentials,fetchImpl:x.fetchImpl});
    assert.equal(x.count(),1);
    assert.equal(y.responseShapeVerified,false);
    assert.equal(y.tradingAuthorized,false);
  }
  let calls=0;
  const failed=await probeAuthenticatedDemoBalance({...credentials,
    fetchImpl:(async()=>{calls++;throw Error("network-timeout");}) as typeof fetch});
  assert.equal(calls,1);assert.equal(failed.authenticated,false);
  assert.equal(failed.tradingAuthorized,false);
});
test("missing/malformed demo credentials never make network requests",async()=>{
  let called=0;
  const invalid=await probeAuthenticatedDemoBalance({
    ...credentials,keyId:"bad",fetchImpl:(async()=>{called++;throw Error("network");}) as typeof fetch,
  });
  assert.equal(invalid.authenticated,false);
  assert.equal(called,0);
});
