import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { dedicatedSignerFingerprint } from "./commissioning";
import { prepareOwnedPilotTransfer, executeOwnedPilotTransfer, ownedPilotTransferStatus,
  OWNER_PILOT_TRANSFER_CONFIRMATION, reconcileOwnedPilotTransfer } from "./ownedPilotTransfer";
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
  let exchangeRows:Record<string,unknown>[]=[];
  let historyError=false;
  let attemptedSeconds=Math.floor(Date.now()/1000);
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
      assert.match(sql, /RETURNING id::text AS id\s*`?\s*$/m);
      assert.doesNotMatch(sql, /AS id::text/);
      if(state)return {rows:[]};
      transferId=params?.[0] as string; state="prepared";
      return {rows:[{id:transferId}]};
    }
    if(sql.includes("pilot-transfer:reconcile-read")) {
      return {rows:state&&params?.[0]===OWNER?[{
        id:transferId,state,owner_user_id:OWNER,execution_account_id:"owner-acct",
        authority_credential_id:ownerRow.credential_id,authority_fingerprint:fingerprint,
        primary_before_cents:3450,bot_before_cents:0,attempted_seconds:attemptedSeconds,
      }]:[]};
    }
    if(sql.includes("pilot-transfer:reconcile-complete")) {
      if(!state||!["attempted","uncertain"].includes(state)||params?.[0]!==transferId||
         params?.[1]!==OWNER||params?.[2]!==950||params?.[3]!==2500)return {rows:[]};
      state="completed";return {rows:[{id:transferId}]};
    }
    if(sql.includes("pilot-transfer:status")){
      return {rows:state&&params?.[0]===OWNER?[{id:transferId,state,primary_before_cents:3450,
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
    if(_path==="/trade-api/v2/portfolio/subaccounts/transfers") {
      if(historyError)throw Error("kalshi history unavailable");
      return {transfers:exchangeRows,cursor:""};
    }
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
    setBalances:(p:number,b:number)=>{primary=p;bot=b;},
    setHistory:(rows:Record<string,unknown>[])=>{exchangeRows=rows;},
    setHistoryError:(v:boolean)=>{historyError=v;},
    attemptTime:()=>attemptedSeconds,
    makeHistory:()=>({
      transfer_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",from_subaccount:0,
      to_subaccount:1,amount_cents:2500,exchange_index:2,created_ts:attemptedSeconds,
    }),
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

test("uncertain database COMMIT cannot authorize an exchange transfer POST",async()=>{
  const fixtureState=fixture();
  const prepared=await prepareOwnedPilotTransfer(fixtureState.db,OWNER,{get:fixtureState.get});
  assert.equal(prepared.ok,true);
  const connect=fixtureState.db.connect;
  fixtureState.db.connect=async()=>{
    const client=await connect();
    return {
      ...client,
      query:async(sql:string,params?:unknown[])=>{
        if(sql==="COMMIT")throw new Error("commit_connection_lost");
        return client.query(sql,params);
      },
    };
  };
  const result=await executeOwnedPilotTransfer(fixtureState.db,OWNER,{
    attemptId:prepared.attemptId,
    confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:fixtureState.get,post:fixtureState.post,allowTestTransport:true});
  assert.equal(result.ok,false);
  assert.equal(fixtureState.getPosts(),0);
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

test("read-only reconciliation confirms unique Kalshi receipt and exact balances without another POST",async()=>{
  const f=fixture();const plan=await prepareOwnedPilotTransfer(f.db,OWNER,{get:f.get});
  const response=await executeOwnedPilotTransfer(f.db,OWNER,{
    attemptId:plan.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:f.get,post:f.ambiguous,allowTestTransport:true});
  assert.equal(response.state,"uncertain");assert.equal(f.getPosts(),1);
  f.setBalances(950,2500);f.setHistory([f.makeHistory()]);
  const result=await reconcileOwnedPilotTransfer(f.db,OWNER,{get:f.get});
  assert.equal(result.state,"completed");
  assert.equal(result.ok,true);
  assert.equal(result.botCents,2500);
  assert.equal(f.getPosts(),1);
  assert.equal((await reconcileOwnedPilotTransfer(f.db,OWNER,{get:f.get})).state,"completed");
  assert.equal(f.getPosts(),1);
});

test("history alone or balance alone does not complete an uncertain transfer",async()=>{
  const f=fixture();const plan=await prepareOwnedPilotTransfer(f.db,OWNER,{get:f.get});
  await executeOwnedPilotTransfer(f.db,OWNER,{
    attemptId:plan.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:f.get,post:f.ambiguous,allowTestTransport:true});
  f.setHistory([f.makeHistory()]);
  assert.equal((await reconcileOwnedPilotTransfer(f.db,OWNER,{get:f.get})).reason,
    "pilot_reconciliation_cash_not_settled");
  f.setBalances(950,2500);f.setHistory([]);
  assert.equal((await reconcileOwnedPilotTransfer(f.db,OWNER,{get:f.get})).reason,
    "pilot_reconciliation_receipt_missing");
  f.setHistoryError(true);
  assert.equal((await reconcileOwnedPilotTransfer(f.db,OWNER,{get:f.get})).reason,
    "pilot_reconciliation_history_unavailable");
  assert.equal(f.getPosts(),1);
});

test("foreign owner, wrong index, timestamp, amount, or duplicate receipt never completes",async()=>{
  const f=fixture();const plan=await prepareOwnedPilotTransfer(f.db,OWNER,{get:f.get});
  await executeOwnedPilotTransfer(f.db,OWNER,{
    attemptId:plan.attemptId,confirmation:OWNER_PILOT_TRANSFER_CONFIRMATION,
  },{get:f.get,post:f.ambiguous,allowTestTransport:true});
  f.setBalances(950,2500);
  assert.equal((await reconcileOwnedPilotTransfer(f.db,FOREIGN,{get:f.get})).ok,false);
  for(const bad of [
    {...f.makeHistory(),amount_cents:2400},
    {...f.makeHistory(),exchange_index:0},
    {...f.makeHistory(),created_ts:f.attemptTime()-1000},
    {...f.makeHistory(),from_subaccount:1},
  ]){
    f.setHistory([bad]);
    assert.equal((await reconcileOwnedPilotTransfer(f.db,OWNER,{get:f.get})).ok,false);
  }
  f.setHistory([f.makeHistory(),{...f.makeHistory(),transfer_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]);
  assert.equal((await reconcileOwnedPilotTransfer(f.db,OWNER,{get:f.get})).reason,
    "pilot_reconciliation_history_ambiguous");
  assert.equal(f.getPosts(),1);
});

test("signed transport refuses invalid ids and nonproduction environments",async()=>{
  await assert.rejects(()=>postScopedKalshiPilotTransfer(creds,"not-uuid",
    async()=>{throw new Error("unexpected network");}));
});
