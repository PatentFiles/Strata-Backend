import assert from "node:assert/strict";
import test from "node:test";
import {exactSignedCash,exactOwnedBotTransferReceipt,OWNER_TOPUP_CONFIRM,executeOwnerTopup,prepareOwnerTopup} from "./ownerVariableTopup";
import {postScopedOwnerVariableTopup} from "../kalshiAccountClient";
import {generateKeyPairSync} from "node:crypto";
test("exact provider USD microdollars, reject wrong identity and fractional monetary precision",()=>{
 assert.equal(exactSignedCash({subaccount:0,exchange_index:2,balance_dollars:"100.123456"},0,2),100123456n);
 assert.equal(exactSignedCash({subaccount:1,exchange_index:2,balance:2500},1,2),25000000n);
 assert.equal(exactSignedCash({subaccount:0,exchange_index:2,balance_dollars:"100.00"},1,2),null);
 assert.equal(exactSignedCash({balance_dollars:"100.0000001"},0,2),null);
 assert.equal(exactSignedCash({balance:-5},0,2),null);
});
const unsafeDb={query:async()=>{throw Error("never read");},connect:async()=>{throw Error("never connect");}};
test("malformed and unauthorized amounts cause zero Kalshi operations",async()=>{
 for(const amount of [-1,0,99,2500001,100.5,NaN]){
  const r=await prepareOwnerTopup(unsafeDb as never,"owner",amount);
  assert.equal(r.ok,false);assert.equal(r.transferAttempted,false);
 }
 const v=await executeOwnerTopup(unsafeDb as never,"owner",{
   attemptId:"00000000-0000-4000-8000-000000000000",confirmation:"wrong",
 });
 assert.equal(v.reason,"topup_explicit_owner_consent_required");
 assert.equal(v.transferAttempted,false);
});
test("live exchange POST is disabled by default regardless of submitted consent",async()=>{
 const v=await executeOwnerTopup(unsafeDb as never,"owner",{
   attemptId:"00000000-0000-4000-8000-000000000000",confirmation:OWNER_TOPUP_CONFIRM,
 });
 assert.equal(v.reason,"variable_topup_post_not_activated");
 assert.equal(v.transferAttempted,false);
});

test("official Kalshi history matches unique provider-issued transfer_id even without client_transfer_id",()=>{
 const attempted=1_798_000_000;
 const receipt={transfer_id:"kalshi-transfer-123",from_subaccount:0,
   to_subaccount:1,exchange_index:2,amount_cents:10_000,created_ts:attempted};
 assert.equal(exactOwnedBotTransferReceipt(receipt,"kalshi-transfer-123",
   "00000000-0000-4000-8000-000000000001",10_000,attempted),true);
 for(const patch of [
   {transfer_id:"different-provider-id"},
   {from_subaccount:2},{to_subaccount:2},{exchange_index:0},
   {amount_cents:5_000},{created_ts:attempted-121},
   {created_ts:attempted+301},
   {client_transfer_id:"different-owner-request-id"},
 ])assert.equal(exactOwnedBotTransferReceipt({...receipt,...patch},
   "kalshi-transfer-123","00000000-0000-4000-8000-000000000001",
   10_000,attempted),false);
 assert.equal(exactOwnedBotTransferReceipt(receipt,undefined,
   "00000000-0000-4000-8000-000000000001",10_000,attempted),false);
});
test("bot and shard POST bodies use Kalshi's documented intra-account schema and return server ID",async()=>{
 const priorEnv=process.env.KALSHI_API_ENVIRONMENT;
 const priorFlag=process.env.STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED;
 const {privateKey}=generateKeyPairSync("ed25519");
 const creds={keyId:"test-key-id",privateKey:privateKey.export({format:"pem",type:"pkcs8"}).toString()};
 const id="3c90c3cc-0d44-4b50-8888-8dd25736052a";
 const captures:Array<{url:string;body:Record<string,unknown>}>=[];
 const mockFetch=(async(url:string,init:RequestInit)=>{
   captures.push({url,body:JSON.parse(String(init.body)) as Record<string,unknown>});
   return new Response(JSON.stringify({transfer_id:"kalshi-transfer-123"}),{
     status:200,headers:{"content-type":"application/json"},
   });
 }) as typeof fetch;
 try{
   process.env.KALSHI_API_ENVIRONMENT="production";
   process.env.STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED="true";
   const bot=await postScopedOwnerVariableTopup(creds,id,10_000,"bot",mockFetch);
   const shard=await postScopedOwnerVariableTopup(creds,id,10_000,"shard",mockFetch);
   assert.equal(bot.status,200);assert.equal(shard.status,200);
   assert.equal((bot.body as {transfer_id:string}).transfer_id,"kalshi-transfer-123");
   assert.equal(captures.length,2);
   assert.ok(captures.every(c=>c.url.endsWith("/portfolio/intra_exchange_instance_transfer")));
   assert.deepEqual(captures[0]!.body,{
     source:"event_contract",destination:"event_contract",
     amount:1_000_000,source_exchange_shard:2,destination_exchange_shard:2,
     source_subaccount:0,destination_subaccount:1,
   });
   assert.equal(captures[1]!.body.client_transfer_id,id);
   assert.equal(captures[1]!.body.source_exchange_shard,0);
   assert.equal(captures[1]!.body.destination_exchange_shard,2);
 }finally{
   if(priorEnv===undefined)delete process.env.KALSHI_API_ENVIRONMENT;
   else process.env.KALSHI_API_ENVIRONMENT=priorEnv;
   if(priorFlag===undefined)delete process.env.STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED;
   else process.env.STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED=priorFlag;
 }
});
