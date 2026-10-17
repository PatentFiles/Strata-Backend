import assert from "node:assert/strict";
import test from "node:test";
import {createHash,createPublicKey,generateKeyPairSync,verify,constants} from "node:crypto";
import {DEMO_IOC_PATH,demoSignerFingerprint,executeOneSignedDemoProtectiveIoc,
 type DemoExitApproval} from "./kalshiDemoSignedIoc";
import {KALSHI_DEMO_ORIGIN} from "./kalshiDemoSignedReadOnly";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

const k=generateKeyPairSync("rsa",{modulusLength:2048});
const pem=k.privateKey.export({format:"pem",type:"pkcs8"}).toString();
const keyId="demo-key-001";
const fp=demoSignerFingerprint(keyId,pem)!;
const now=1780000000000;
const id="v13p-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ticker="KXBTC15M-26OCT161945-45";
const order:EmergencyExitOrder={
  ticker,side:"ask",count:"2.00",price:"0.5500",
  client_order_id:id,time_in_force:"immediate_or_cancel",
  self_trade_prevention_type:"taker_at_cross",post_only:false,
  reduce_only:true,subaccount:1,exchange_index:2,
};
const approval:DemoExitApproval={
  environment:"KALSHI_DEMO",
  authenticatedOwnerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  accountOwnerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  signerFingerprint:fp,
  demoAccountVerified:true,
  subaccount:1,exchangeIndex:2,
  authorizedByIndependentOperator:true,
  operatorApprovalId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  approvalExpiresAtMs:now+15_000,
  marketTicker:ticker,marketOpen:true,
  priceGridVerified:true,permittedLimitPrice:"0.5500",
  positionMarketTicker:ticker,positionsComplete:true,
  signedPositionFp:"3.00",positionObservedAtMs:now-200,
  restingOrderCount:0,unresolvedOrderCount:0,
  feeFingerprint:"a".repeat(64),feeObservedAtMs:now-200,
  feesCurrentAndApplicable:true,workerFencingToken:7,
};
const receipt=(filled:string,remaining:string)=>({
  httpStatus:201,order_id:"exchange-order-123",client_order_id:id,
  fill_count:filled,remaining_count:remaining,ts_ms:now,
});
function observation(fill:string,remaining:string):IocRecoveryObservation {
  return {
    clientOrderId:id,requestedCountFp:"2.00",
    marketTicker:ticker,positionMarketTicker:ticker,
    initialPositionFp:"3.00",
    observedPositionFp:(3-Number(fill)).toFixed(2),
    reducingBookSide:"ask",
    completeExchangeHistory:true,exactMarketAndAccountMatched:true,
    orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
    response:receipt(fill,remaining),
  };
}
function harness(opts:{
  filled?:string;remaining?:string;
  status?:number;networkFailure?:boolean;badHistory?:boolean;
  throwHistory?:boolean;denyMark?:boolean;throwMark?:boolean;
}={}){
  let marks=0,posts=0,reads=0;
  const fill=opts.filled??"2.00",remaining=opts.remaining??"0.00";
  const deps={
    nowMs:()=>now,
    commitUnknownBeforePost:async()=>{
      marks++;
      if(opts.throwMark)throw Error("commit outcome unknown");
      return {persisted:!opts.denyMark,state:"UNKNOWN" as const,
        clientOrderId:id,fencingToken:7,mayRetry:false as const,
        oneShot:true as const};
    },
    fetchImpl:(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      posts++;
      assert.equal(url,KALSHI_DEMO_ORIGIN+DEMO_IOC_PATH);
      assert.equal(init?.method,"POST");
      assert.equal(init?.redirect,"error");
      assert.equal(init?.cache,"no-store");
      assert.ok(!(init?.body as string).includes("privateKey"));
      const body=JSON.parse(init?.body as string);
      assert.deepEqual(Object.keys(body).sort(),[
        "ticker","client_order_id","side","count","price","time_in_force",
        "self_trade_prevention_type","post_only","reduce_only","subaccount","exchange_index"
      ].sort());
      assert.equal(body.reduce_only,true);
      assert.equal(body.time_in_force,"immediate_or_cancel");
      assert.equal(body.exchange_index,2);
      assert.equal(body.subaccount,1);
      const headers=new Headers(init?.headers);
      const msg=Buffer.from(String(now)+"POST"+DEMO_IOC_PATH);
      assert.equal(verify("sha256",msg,{key:k.publicKey,
        padding:constants.RSA_PKCS1_PSS_PADDING,
        saltLength:constants.RSA_PSS_SALTLEN_DIGEST},
        Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE")??"","base64")),true);
      if(opts.networkFailure)throw Error("timeout after submission");
      const code=opts.status??201;
      return new Response(JSON.stringify(receipt(fill,remaining)),
        {status:code,headers:{"content-type":"application/json"}});
    }) as typeof fetch,
    readVerifiedExchangeHistory:async()=>{
      reads++;
      if(opts.throwHistory)throw Error("history unavailable");
      const o=observation(fill,remaining);
      if(opts.badHistory)o.orderAndFillHistoryMatched=false;
      return o;
    },
  };
  return {deps,stats:()=>({marks,posts,reads})};
}
test("DEMO only: zero/partial/full independently reconciled without production authority",async()=>{
 for(const [filled,remaining] of [["0.00","2.00"],["1.00","1.00"],["2.00","0.00"]]){
   const h=harness({filled,remaining});
   const result=await executeOneSignedDemoProtectiveIoc({
     keyId,privateKeyPem:pem,order,approval,deps:h.deps,
   });
   assert.equal(result.state,"RECONCILED");
   assert.equal(result.filledHundredths,String(Math.round(Number(filled)*100)));
   assert.equal(result.tradingAuthorized,false);
   assert.equal(result.productionOrderSubmitted,false);
   assert.equal(result.mayRetry,false);
   assert.deepEqual(h.stats(),{marks:1,posts:1,reads:1});
 }
});
test("Invalid authorization, wrong market/side/subaccount, stale fees or position: zero writes",async()=>{
 const bad=[
   {approval:{...approval,authorizedByIndependentOperator:false}},
   {approval:{...approval,signerFingerprint:"b".repeat(64)}},
   {approval:{...approval,accountOwnerId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}},
   {approval:{...approval,positionObservedAtMs:now-4000}},
   {approval:{...approval,feeObservedAtMs:now-4000}},
   {approval:{...approval,approvalExpiresAtMs:now-1}},
   {approval:{...approval,unresolvedOrderCount:1}},
   {approval:{...approval,permittedLimitPrice:"0.5400"}},
   {order:{...order,side:"bid"}},
   {order:{...order,ticker:"KXBTC15M-OTHER"}},
   {order:{...order,reduce_only:false}},
   {order:{...order,time_in_force:"good_till_canceled"}},
   {order:{...order,subaccount:0}},
   {order:{...order,count:"4.00"}},
   {order:{...order,price:"1.0000"}},
   {order:{...order,price:"0.0000"}},
 ];
 for(const x of bad){
   const h=harness();
   const r=await executeOneSignedDemoProtectiveIoc({
      keyId,privateKeyPem:pem,
      order:x.order??order,
      approval:x.approval as DemoExitApproval??approval,
      deps:h.deps,
   });
   assert.equal(r.state,"BLOCKED");
   assert.deepEqual(h.stats(),{marks:0,posts:0,reads:0});
 }
});
test("Failed or ambiguous durable commit never sends to demo exchange",async()=>{
 for(const opts of [{denyMark:true},{throwMark:true}]){
   const h=harness(opts);
   const r=await executeOneSignedDemoProtectiveIoc({
     keyId,privateKeyPem:pem,order,approval,deps:h.deps,
   });
   assert.equal(r.state,"BLOCKED");
   assert.equal(r.mayRetry,false);
   assert.deepEqual(h.stats(),{marks:1,posts:0,reads:0});
 }
});
test("HTTP 429/5xx and network timeout remain UNKNOWN with no repeat submission",async()=>{
 for(const opts of [{status:429},{status:503},{networkFailure:true}]){
  const h=harness(opts);
  const r=await executeOneSignedDemoProtectiveIoc({
    keyId,privateKeyPem:pem,order,approval,deps:h.deps,
  });
  assert.equal(r.state,"UNKNOWN");
  assert.equal(r.mayRetry,false);
  assert.deepEqual(h.stats(),{marks:1,posts:1,reads:0});
 }
});
test("Receipt success without verified independent history remains UNKNOWN",async()=>{
 for(const opts of [{badHistory:true},{throwHistory:true},
   {filled:"1.00",remaining:"0.00"}]){
  const h=harness(opts);
  const r=await executeOneSignedDemoProtectiveIoc({
    keyId,privateKeyPem:pem,order,approval,deps:h.deps,
  });
  assert.equal(r.state,"UNKNOWN");
  assert.equal(r.mayRetry,false);
  assert.deepEqual(h.stats(),{marks:1,posts:1,reads:1});
 }
});
test("Signatures bind to exact method/path; signer fingerprint is deterministic",()=>{
 assert.equal(fp.length,64);
 assert.equal(demoSignerFingerprint(keyId,pem),fp);
 assert.equal(demoSignerFingerprint("bad",pem),null);
 const der=createPublicKey(pem).export({type:"spki",format:"der"});
 assert.equal(createHash("sha256").update(keyId).update(der).digest("hex"),fp);
});
