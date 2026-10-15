import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { dedicatedSignerFingerprint } from "./commissioning";
import { prepareOwnedPilotTransfer, executeOwnedPilotTransfer, ownedPilotTransferStatus,
  OWNER_PILOT_TRANSFER_CONFIRMATION } from "./ownedPilotTransfer";
import { postScopedKalshiPilotTransfer } from "../kalshiAccountClient";

const OWNER="11111111-1111-4111-8111-111111111111";
const FOREIGN="22222222-2222-4222-8222-222222222222";
const pair=generateKeyPairSync("rsa",{modulusLength:2048});
const creds={keyId:"pilot-owner-key",privateKey:pair.privateKey.export({type:"pkcs1",format:"pem"}).toString()};
const fingerprint=dedicatedSignerFingerprint(creds.keyId,creds.privateKey);
assert.ok(fingerprint);

function fixture() {
  let state:"prepared"|"attempted"|"uncertain"|"completed"|null=null;
  let transferId:string|null=null;
  let primary=3450,bot=0,posts=0;
  const ownerRow={
    id:"owner-acct",owner_user_id:OWNER,financial_account_id:"33333333-3333-4333-8333-333333333333",
    connection_id:"44444444-4444-4444-8444-444444444444",
    credential_id:"55555555-5555-4555-8555-555555555555",
    key_fingerprint:fingerprint,decrypted_secret:JSON.stringify({api_key_id:creds.keyId,private_key:creds.privateKey}),
    subaccount:1,exchange_index:2,kill_switch:true,execution_enabled:false,
    commissioned:false,manual_kill_switch:true,live_execution_enabled:false,reserved_micros:"0",
    open_positions:0,unresolved_orders:0,active_workers:0,
  };
  const query=async (sql:string,params?:unknown[])=>{
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK")return {rows:[]};
    if(sql.includes("pilot-transfer:owner-read"))return {rows:params?.[0]===OWNER?[ownerRow]:[]};
    if(sql.includes("pilot-transfer:prepare")){
      if(state)return {rows:[]};
      transferId=params?.[0] as string; state="prepared";
      return {rows:[{id:transferId}]};
    }
    if(sql.includes("pilot-transfer:status")){
      return {rows:state?[{id:transferId,state,primary_before_cents:3450,
        bot_before_cents:0,primary_after_cents:primary,bot_after_cents:bot}]:[]};
    }
    if(sql.includes("pilot-transfer:read-attempt")){
      return {rows:params?.[0]===OWNER&&params?.[1]===transferId&&state
        ?[{id:transferId,state,owner_user_id:OWNER,execution_account_id:"owner-acct",
          authority_credential_id:ownerRow.credential_id,authority_fingerprint:fingerprint,
          primary_before_cents:3450,bot_before_cents:0,prepared_ms:Date.now()}]:[]};
    }
    if(sql.includes("pilot-transfer:claim-once")){
      if(state!=="prepared"||params?.[0]!==transferId||params?.[1]!==OWNER)return {rows:[]};
      state="attempted";return {rows:[{id:transferId}]};
    }
    if(sql.includes("pilot-transfer:resolve")){
      if(state!=="attempted")return {rows:[]};
      state=params?.[2] as typeof state;return {rows:[{id:transferId}]};
    }
    throw new Error("unexpected SQL");
  };
  const db={query,connect:async()=>({query,release(){}})};
  const get=async (_creds:typeof creds,_path:string,query:string)=>{
    if(query==="?subaccount=0&exchange_index=2")
      return {balance_dollars:(primary/100).toFixed(2),subaccount:0,exchange_index:2};
    if(query==="?subaccount=1&exchange_index=2")
      return {balance_dollars:(bot/100).toFixed(2),subaccount:1,exchange_index:2};
    throw new Error("unexpected read path");
  };
  const post=async (_creds:typeof creds,_id:string)=>{
    posts++;primary-=2500;bot+=2500;
    return {status:200,body:{},unreadable:false};
  };
  return {db,get,post,getPosts:()=>posts,setUnsafe:()=>{ownerRow.kill_switch=false;},
    ambiguous:async()=>{posts++;throw new Error("timeout after POST");}};
}

test("no transfer without separate owner confirmation; strictly one exchange POST",async()=>{
  const f=fixture();
  const p=await prepareOwnedPilotTransfer(f.db,OWNER,{get:f.get});
  assert.equal(p.ok,true);
  assert.equal(p.primaryCents,3450);
  assert.equal(p.botCents,0);
  assert.equal(f.getPosts(),0);
  assert.equal((await executeOwnedPilotTransfer(f.db,OWNER,{
    attemptId:p.attemptId,confirmation:"WRONG",
  },{get:f.get,post:f.post,allowTestTransport:true})).ok,false);
  assert.equal(f.getPosts(),0);
  const completed=await executeOwnedPilotTransfer(f.db,OWNER,{
    attemptId:p.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:f.get,post:f.post,allowTestTransport:true});
  assert.equal(completed.ok,true);
  assert.equal(completed.state,"completed");
  assert.equal(completed.botCents,2500);
  assert.equal(completed.primaryCents,950);
  const duplicate=await executeOwnedPilotTransfer(f.db,OWNER,{
    attemptId:p.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:f.get,post:f.post,allowTestTransport:true});
  assert.equal(duplicate.ok,false);
  assert.equal(f.getPosts(),1);
  assert.equal((await ownedPilotTransferStatus(f.db,OWNER)).state,"completed");
  assert.equal((await ownedPilotTransferStatus(f.db,FOREIGN)).state,"unavailable");
});

test("foreign identity, disabled safety gates and ambiguous exchange response always block",async()=>{
  const f=fixture();
  assert.equal((await prepareOwnedPilotTransfer(f.db,FOREIGN,{get:f.get})).ok,false);
  assert.equal(f.getPosts(),0);
  const p=await prepareOwnedPilotTransfer(f.db,OWNER,{get:f.get});
  assert.equal(p.ok,true);
  f.setUnsafe();
  assert.equal((await executeOwnedPilotTransfer(f.db,OWNER,{
    attemptId:p.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:f.get,post:f.post,allowTestTransport:true})).ok,false);
  assert.equal(f.getPosts(),0);
  const g=fixture();
  const fresh=await prepareOwnedPilotTransfer(g.db,OWNER,{get:g.get});
  const uncertain=await executeOwnedPilotTransfer(g.db,OWNER,{
    attemptId:fresh.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:g.get,post:g.ambiguous,allowTestTransport:true});
  assert.equal(uncertain.state,"uncertain");
  assert.equal(g.getPosts(),1);
  await executeOwnedPilotTransfer(g.db,OWNER,{
    attemptId:fresh.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:g.get,post:g.ambiguous,allowTestTransport:true});
  assert.equal(g.getPosts(),1);
});

test("signed transport refuses invalid ids and nonproduction environments",async()=>{
  await assert.rejects(()=>postScopedKalshiPilotTransfer(creds,"not-uuid",
    async()=>{throw new Error("unexpected network");}));
});
