import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { dedicatedSignerFingerprint } from "./commissioning";
import {
  prepareOwnerShardAllocation, executeOwnerShardAllocation,
  ownerShardAllocationStatus, reconcileOwnerShardAllocation, SHARD_ALLOCATION_CONFIRMATION,
} from "./ownerShardAllocation";
import { postScopedKalshiShardAllocation, getScopedKalshiJson, KalshiApiError } from "../kalshiAccountClient";

const USER="11111111-1111-4111-8111-111111111111";
const OTHER="22222222-2222-4222-8222-222222222222";
const keys=generateKeyPairSync("rsa",{modulusLength:2048});
const cred={keyId:"allocation-test-key",privateKey:keys.privateKey.export({type:"pkcs1",format:"pem"}).toString()};
const fingerprint=dedicatedSignerFingerprint(cred.keyId,cred.privateKey);
assert.ok(fingerprint);
function fixture(){
  let state:string|null=null,attempt:string|null=null,exchangeId:string|null=null;
  let cash0=3450,cash2=0,bot=0,posts=0,preparedAt=Date.now(),allowOwner=true;
  let receiptStatus="complete",receiptAmount="25.0000",receiptDestinationShard=2;
  const owner={id:"acct-one",owner_user_id:USER,financial_account_id:"33333333-3333-4333-8333-333333333333",
    connection_id:"44444444-4444-4444-8444-444444444444",
    credential_id:"55555555-5555-4555-8555-555555555555",
    key_fingerprint:fingerprint,decrypted_secret:JSON.stringify({api_key_id:cred.keyId,private_key:cred.privateKey}),
    subaccount:1,exchange_index:2,kill_switch:true,execution_enabled:false,
    commissioned:false,manual_kill_switch:true,live_execution_enabled:false,
    reserved_micros:"0",positions:0,intents:0,workers:0};
  const query=async(sql:string,params:unknown[]=[]):Promise<{rows:Record<string,unknown>[]}>=>{
    if(["BEGIN","ROLLBACK","COMMIT"].includes(sql))return {rows:[]};
    if(sql.includes("shard-allocation:owner"))return {rows:params[0]===USER&&allowOwner?[owner]:[]};
    if(sql.includes("shard-allocation:prepare")){
      if(state==="prepared"){preparedAt=Date.now();return {rows:[{id:attempt}]};}
      if(state)return {rows:[]};
      attempt=String(params[0]);state="prepared";preparedAt=Date.now();
      return {rows:[{id:attempt}]};
    }
    if(sql.includes("shard-allocation:status"))
      return {rows:state&&params[0]===USER?[{
        id:attempt,state,source_before_cents:3450,destination_before_cents:0,bot_before_cents:0,
        source_after_cents:state==="completed"?cash0:null,
        destination_after_cents:state==="completed"?cash2:null,
        bot_after_cents:state==="completed"?bot:null,exchange_transfer_id:exchangeId,
      }]:[]};
    if(sql.includes("shard-allocation:attempt"))
      return {rows:state&&params[0]===USER&&params[1]===attempt?[{
        id:attempt,state,execution_account_id:"acct-one",authority_credential_id:owner.credential_id,
        authority_fingerprint:fingerprint,source_before_cents:3450,
        destination_before_cents:0,bot_before_cents:0,prepared_ms:preparedAt,
      }]:[]};
    if(sql.includes("shard-allocation:claim-once")){
      if(state!=="prepared"||params[0]!==attempt||params[1]!==USER)return {rows:[]};
      state="attempted";return {rows:[{id:attempt}]};
    }
    if(sql.includes("shard-allocation:outcome")){
      if(state!=="attempted")return {rows:[]};
      state="uncertain";exchangeId=params[2] as string|null;
      return {rows:[{id:attempt}]};
    }
    if(sql.includes("shard-allocation:complete-verified")){
      if(state!=="uncertain")return {rows:[]};
      state="completed";return {rows:[{id:attempt}]};
    }
    throw new Error("unexpected query "+sql.slice(0,65));
  };
  const db={query,connect:async()=>({query,release(){}})};
  const read=async (_creds:typeof cred,path:string,qs:string):Promise<unknown>=>{
    if(path.includes("intra_exchange_instance_transfers/")){
      return {transfer:{transfer_id:exchangeId,source:"event_contract",destination:"event_contract",
        source_exchange_shard:0,destination_exchange_shard:receiptDestinationShard,
        amount:receiptAmount,status:receiptStatus}};
    }
    if(path==="/trade-api/v2/portfolio/subaccounts/balances")
      return {subaccount_balances:[
        {subaccount_number:0,exchange_index:0,balance:(cash0/100).toFixed(4),updated_ts:1700000000},
        {subaccount_number:0,exchange_index:2,balance:(cash2/100).toFixed(4),updated_ts:1700000000},
        {subaccount_number:1,exchange_index:2,balance:(bot/100).toFixed(4),updated_ts:1700000000},
      ]};
    if(path!=="/trade-api/v2/portfolio/balance")throw new Error("unexpected path");
    const mapping:Record<string,[number,number,number]>={
      "?subaccount=0&exchange_index=0":[cash0,0,0],
      "?subaccount=0&exchange_index=2":[cash2,0,2],
      "?subaccount=1&exchange_index=2":[bot,1,2],
    };
    const a=mapping[qs];if(!a)throw new Error("unexpected shard");
    return {balance_dollars:(a[0]/100).toFixed(2),subaccount:a[1],exchange_index:a[2]};
  };
  const post=async (_creds:typeof cred,id:string)=>{
    posts++;assert.equal(id,attempt);
    cash0-=2500;cash2+=2500;
    return {status:200,body:{transfer_id:"exchange-accepted-123"},unreadable:false};
  };
  return {db,read,post,posts:()=>posts,setUnsafe:()=>{owner.kill_switch=false;},
    setDestination:(n:number)=>{cash2=n;},setSource:(n:number)=>{cash0=n;},
    setReceiptStatus:(v:string)=>{receiptStatus=v;},
    setReceiptAmount:(v:string)=>{receiptAmount=v;},
    setReceiptDestinationShard:(v:number)=>{receiptDestinationShard=v;},
    rejectPost:async()=>{posts++;throw Error("timeout after acceptance");},
    state:()=>state};
}
test("read-only prepare verifies shard0 3450, shard2 zero and bot zero; no POST",async()=>{
  const f=fixture();
  assert.equal((await prepareOwnerShardAllocation(f.db,OTHER,{read:f.read})).ok,false);
  const p=await prepareOwnerShardAllocation(f.db,USER,{read:f.read});
  assert.equal(p.ok,true);
  assert.equal(p.state,"prepared");
  assert.equal(p.sourceCents,3450);
  assert.equal(p.destinationCents,0);
  assert.equal(f.posts(),0);
  assert.equal((await ownerShardAllocationStatus(f.db,USER)).state,"prepared");
  assert.equal((await ownerShardAllocationStatus(f.db,OTHER)).state,"unavailable");
  assert.equal((await prepareOwnerShardAllocation(f.db,USER,{read:f.read})).state,"prepared");
});
test("wrong money shard, owner, or global safety gate rejects preparation",async()=>{
  const f=fixture();
  f.setSource(2000);assert.equal((await prepareOwnerShardAllocation(f.db,USER,{read:f.read})).reason,"shard0_primary_cash_insufficient");
  f.setSource(3450);f.setDestination(25);
  assert.equal((await prepareOwnerShardAllocation(f.db,USER,{read:f.read})).reason,"destination_shard_not_empty");
  const x=fixture();x.setUnsafe();
  assert.equal((await prepareOwnerShardAllocation(x.db,USER,{read:x.read})).ok,false);
  assert.equal(x.posts(),0);
});
test("POST disabled by default and wrong confirmation cannot claim or transfer",async()=>{
  const f=fixture();const p=await prepareOwnerShardAllocation(f.db,USER,{read:f.read});
  assert.equal((await executeOwnerShardAllocation(f.db,USER,
    {attemptId:p.attemptId,confirmation:SHARD_ALLOCATION_CONFIRMATION},{read:f.read,post:f.post})).reason,
    "shard_execution_not_enabled");
  assert.equal((await executeOwnerShardAllocation(f.db,USER,
    {attemptId:p.attemptId,confirmation:"NO"},{read:f.read,post:f.post,enableTestPost:true})).ok,false);
  assert.equal(f.posts(),0);
});
test("owner confirmation makes exactly ONE accepted POST; completion requires receipt and verified balances",async()=>{
  const f=fixture();const p=await prepareOwnerShardAllocation(f.db,USER,{read:f.read});
  const first=await executeOwnerShardAllocation(f.db,USER,{
    attemptId:p.attemptId,confirmation:SHARD_ALLOCATION_CONFIRMATION,
  },{read:f.read,post:f.post,enableTestPost:true});
  assert.equal(first.state,"uncertain"); // 200 is asynchronous, never treat as completion.
  assert.equal(first.exchangeTransferId,"exchange-accepted-123");
  assert.equal(f.posts(),1);
  await executeOwnerShardAllocation(f.db,USER,{
    attemptId:p.attemptId,confirmation:SHARD_ALLOCATION_CONFIRMATION,
  },{read:f.read,post:f.post,enableTestPost:true});
  assert.equal(f.posts(),1);
  const verified=await reconcileOwnerShardAllocation(f.db,USER,{read:f.read});
  assert.equal(verified.state,"completed");
  assert.equal(verified.destinationCents,2500);
  assert.equal(verified.sourceCents,950);
  assert.equal(f.posts(),1);
});
test("official Kalshi pending receipt never completes or posts a duplicate",async()=>{
  const f=fixture();
  const plan=await prepareOwnerShardAllocation(f.db,USER,{read:f.read});
  await executeOwnerShardAllocation(f.db,USER,
    {attemptId:plan.attemptId,confirmation:SHARD_ALLOCATION_CONFIRMATION},
    {read:f.read,post:f.post,enableTestPost:true});
  f.setReceiptStatus("pending");
  const checked=await reconcileOwnerShardAllocation(f.db,USER,{read:f.read});
  assert.equal(checked.state,"uncertain");
  assert.equal(checked.reason,"shard_exchange_receipt_not_complete");
  assert.equal(f.posts(),1);
  f.setReceiptStatus("complete");
  assert.equal((await reconcileOwnerShardAllocation(f.db,USER,{read:f.read})).state,"completed");
  assert.equal(f.posts(),1);
});

test("Kalshi complete receipt with wrong destination or amount cannot finalize funding",async()=>{
  const f=fixture();
  const plan=await prepareOwnerShardAllocation(f.db,USER,{read:f.read});
  await executeOwnerShardAllocation(f.db,USER,
    {attemptId:plan.attemptId,confirmation:SHARD_ALLOCATION_CONFIRMATION},
    {read:f.read,post:f.post,enableTestPost:true});
  f.setReceiptDestinationShard(1);
  assert.equal((await reconcileOwnerShardAllocation(f.db,USER,{read:f.read})).state,"uncertain");
  f.setReceiptDestinationShard(2);
  f.setReceiptAmount("24.0000");
  assert.equal((await reconcileOwnerShardAllocation(f.db,USER,{read:f.read})).state,"uncertain");
  assert.equal(f.posts(),1);
});

test("timeout is uncertain and unreplayable, with no fabricated cash receipt",async()=>{
  const f=fixture();const p=await prepareOwnerShardAllocation(f.db,USER,{read:f.read});
  const result=await executeOwnerShardAllocation(f.db,USER,{
    attemptId:p.attemptId,confirmation:SHARD_ALLOCATION_CONFIRMATION,
  },{read:f.read,post:f.rejectPost,enableTestPost:true});
  assert.equal(result.state,"uncertain");
  assert.equal(f.posts(),1);
  assert.equal((await reconcileOwnerShardAllocation(f.db,USER,{read:f.read})).state,"uncertain");
  await executeOwnerShardAllocation(f.db,USER,{attemptId:p.attemptId,confirmation:SHARD_ALLOCATION_CONFIRMATION},
    {read:f.read,post:f.rejectPost,enableTestPost:true});
  assert.equal(f.posts(),1);
});
test("signed fixed request refuses invalid transfer IDs before network",async()=>{
  await assert.rejects(()=>postScopedKalshiShardAllocation(cred,"invalid-id",async()=>{
    throw Error("network must never be called");
  }));
});

test("signed transport uses exact primary-to-primary shards and centicent $25, receipt GET is allowlisted",async()=>{
  const prior=process.env.KALSHI_API_ENVIRONMENT;
  process.env.KALSHI_API_ENVIRONMENT="production";
  const transferId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const seen:Array<{url:string;method:string;body:unknown;signature:string|null}>=[];
  const fake:typeof fetch=async(input,init)=>{
    const url=String(input);
    const headers=new Headers(init?.headers);
    seen.push({url,method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)) as unknown:null,
      signature:headers.get("KALSHI-ACCESS-SIGNATURE")});
    return new Response(JSON.stringify(url.endsWith("instance_transfer")
      ? {transfer_id:"accepted-kalshi-id"} : {transfer:{transfer_id:"accepted-kalshi-id"}}),
      {status:200,headers:{"Content-Type":"application/json"}});
  };
  try{
    const posted=await postScopedKalshiShardAllocation(cred,transferId,fake);
    assert.equal(posted.status,200);
    assert.equal(seen[0]!.method,"POST");
    assert.deepEqual(seen[0]!.body,{
      source:"event_contract",destination:"event_contract",
      amount:250000,client_transfer_id:transferId,
      source_exchange_shard:0,destination_exchange_shard:2,
      source_subaccount:0,destination_subaccount:0,
    });
    assert.ok(seen[0]!.signature);
    await getScopedKalshiJson(cred,
      "/trade-api/v2/portfolio/intra_exchange_instance_transfers/accepted-kalshi-id",
      "",fake,"https://external-api.kalshi.com");
    assert.equal(seen[1]!.method,"GET");
    assert.ok(seen[1]!.signature);
    await assert.rejects(()=>getScopedKalshiJson(cred,
      "/trade-api/v2/portfolio/intra_exchange_instance_transfers/../../api_keys",
      "",fake,"https://external-api.kalshi.com"));
    assert.equal(seen.length,2);
  }finally{
    if(prior===undefined)delete process.env.KALSHI_API_ENVIRONMENT;
    else process.env.KALSHI_API_ENVIRONMENT=prior;
  }
});

test("429 from scoped primary cash is distinguishable from unverified cash and never transfers",async()=>{
 const f=fixture();
 const prepared=await prepareOwnerShardAllocation(f.db,USER,{
   read:async(c,p,q)=>{
     if(p==="/trade-api/v2/portfolio/balance"&&q==="?subaccount=0&exchange_index=0")
       throw new KalshiApiError("HTTP_ERROR",429);
     return f.read(c,p,q);
   },
 });
 assert.equal(prepared.ok,false);
 assert.equal(prepared.reason,"shard_cash_http_429");
 assert.equal(f.posts(),0);
});
test("missing or conflicting cross-shard inventory refuses preflight without submitting",async()=>{
 const f=fixture();
 const result=await prepareOwnerShardAllocation(f.db,USER,{
   read:async(c,p,q)=>{
     if(p==="/trade-api/v2/portfolio/subaccounts/balances")
       return {subaccount_balances:[
         {subaccount_number:0,exchange_index:0,balance:"1.0000"},
         {subaccount_number:0,exchange_index:2,balance:"0.0000"},
         {subaccount_number:1,exchange_index:2,balance:"0.0000"},
       ]};
     return f.read(c,p,q);
   },
 });
 assert.equal(result.ok,false);
 assert.equal(result.reason,"shard_cash_inventory_mismatch");
 assert.equal(f.posts(),0);
});
