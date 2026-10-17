import {test} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,verify,constants} from "node:crypto";
import {KALSHI_DEMO_ORIGIN,readSignedKalshiDemo,signKalshiDemoRead} from "./kalshiDemoSignedReadOnly";
const t=1_780_000_000_000;
const keyId="demo-key-001";
const path="/trade-api/v2/portfolio/orders";
const rsa=generateKeyPairSync("rsa",{modulusLength:2048});
const ed=generateKeyPairSync("ed25519");
const privateKeyPem=rsa.privateKey.export({format:"pem",type:"pkcs8"}).toString();
test("RSA-PSS authenticated demo GET signature verifies against exact method and path",()=>{
 const headers=signKalshiDemoRead({keyId,privateKeyPem,path,timestampMs:t});
 const message=Buffer.from(String(t)+"GET"+path);
 assert.equal(verify("sha256",message,{key:rsa.publicKey,
  padding:constants.RSA_PKCS1_PSS_PADDING,
  saltLength:constants.RSA_PSS_SALTLEN_DIGEST},
  Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"]!,"base64")),true);
 assert.equal(verify("sha256",Buffer.from(String(t)+"POST"+path),{key:rsa.publicKey,
  padding:constants.RSA_PKCS1_PSS_PADDING,
  saltLength:constants.RSA_PSS_SALTLEN_DIGEST},
  Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"]!,"base64")),false);
});
test("Ed25519 demo GET signature verifies with matching public key",()=>{
 const h=signKalshiDemoRead({keyId,privateKeyPem:ed.privateKey.export({format:"pem",type:"pkcs8"}).toString(),path,timestampMs:t});
 assert.equal(verify(null,Buffer.from(String(t)+"GET"+path),ed.publicKey,Buffer.from(h["KALSHI-ACCESS-SIGNATURE"]!,"base64")),true);
});
test("nonallowlisted endpoint is rejected before any network transport",async()=>{
 let called=false;
 const r=await readSignedKalshiDemo({keyId,privateKeyPem,path:"/trade-api/v2/portfolio/events/orders",
 timestampMs:t,transport:async()=>{called=true;throw Error("not allowed");}});
 assert.equal(called,false);assert.equal(r.ok,false);
});
test("strict demo hostname, GET-only and no redirects",async()=>{
 let count=0;
 const r=await readSignedKalshiDemo({keyId,privateKeyPem,path,timestampMs:t,
 transport:async(url,init)=>{count++;assert.equal(url,KALSHI_DEMO_ORIGIN+path);
 assert.equal(init.method,"GET");assert.equal(init.redirect,"error");
 return {status:200,json:async()=>({orders:[]})};}});
 assert.equal(count,1);assert.equal(r.ok,true);assert.equal(r.tradingAuthorized,false);
});
test("timeouts and rate limits fail closed and never retry",async()=>{
 let count=0;const base={keyId,privateKeyPem,path,timestampMs:t};
 const failure=await readSignedKalshiDemo({...base,transport:async()=>{count++;throw Error("timeout");}});
 assert.equal(failure.ok,false);assert.equal(count,1);
 const limit=await readSignedKalshiDemo({...base,transport:async()=>{count++;return {status:429,json:async()=>({})};}});
 assert.equal(limit.ok,false);assert.equal(count,2);
});
