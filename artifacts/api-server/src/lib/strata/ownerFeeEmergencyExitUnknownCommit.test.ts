import assert from "node:assert/strict";
import test from "node:test";
import {markOwnedEmergencyExitUnknownForReview} from "./ownerFeeEmergencyExitUnknownCommit";
import type {inspectOwnedEmergencyExitRead} from "./ownerFeeEmergencyExitRead";
import type {dedicatedSignerFingerprint} from "./commissioning";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";

const OWNER="11111111-1111-4111-8111-111111111111";
const ACCOUNT="owner-execution-2";
const RESERVATION="22222222-2222-4222-8222-222222222222";
const CLIENT_ID="v13p-33333333-3333-4333-8333-333333333333";
const MARKET="KXBTC15M-26OCT161945-45";
const NOW=Date.parse("2026-10-19T19:00:00Z");
const ORDER:EmergencyExitOrder={
  ticker:MARKET,side:"ask",count:"2.00",price:"0.5500",
  client_order_id:CLIENT_ID,time_in_force:"immediate_or_cancel",
  post_only:false,reduce_only:true,self_trade_prevention_type:"taker_at_cross",
  subaccount:1,exchange_index:2,
};
const LEASE={holderId:"personal-22222222-2222-4222-8222-222222222222",fencingToken:7};

function mock(opts:{advisory?:boolean;lock?:boolean;update?:boolean;failAt?:"lock"|"update"|"commit";badReturn?:boolean}={}){
  const events:string[]=[];
  let phase:"PREPARED"|"UNKNOWN"="PREPARED";
  const inspect=(async()=>opts.advisory===false
    ? {ok:false as const,reason:"unverified",diagnosticEligible:false,
       tradingAuthorized:false as const,needsIndependentApproval:true as const}
    : {ok:false as const,reason:"emergency_exit_candidate_verified_requires_fenced_dispatch",
       diagnosticEligible:true,tradingAuthorized:false as const,
       verifiedPositionFp:"3.00",verifiedPositionObservedAtMs:NOW-100,
       needsIndependentApproval:true as const}) as typeof inspectOwnedEmergencyExitRead;
  const db={connect:async()=>({query:async(sql:string,args?:unknown[])=>{
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||
      sql.startsWith("SET LOCAL")){
      events.push(sql);
      if(sql==="COMMIT"&&opts.failAt==="commit")throw new Error("uncertain_commit");
      return {rows:[]};
    }
    if(sql.includes("FOR UPDATE OF r,a,w,pos")){
      events.push("LOCK");
      assert.match(sql,/r\.owner_user_id=\$2::uuid/);
      assert.match(sql,/r\.execution_account_id=\$3::text/);
      assert.match(sql,/r\.worker_fencing_token=\$10::bigint/);
      assert.match(sql,/r\.state='PREPARED'/);
      assert.match(sql,/r\.created_at > now\(\)-interval '30 seconds'/);
      assert.match(sql,/a\.subaccount=1 AND a\.exchange_index=2/);
      assert.match(sql,/g\.manual_kill_switch=false/);
      assert.match(sql,/pos\.quantity_hundredths >= r\.quantity_hundredths/);
      assert.match(sql,/NOT EXISTS/);
      assert.match(sql,/FOR UPDATE OF r,a,w,pos/);
      assert.equal(args?.[0],RESERVATION);
      assert.equal(args?.[1],OWNER);
      assert.equal(args?.[2],ACCOUNT);
      assert.equal(args?.[4],CLIENT_ID);
      assert.equal(args?.[9],7);
      if(opts.failAt==="lock")throw new Error("database_offline");
      return {rows:phase==="PREPARED"&&opts.lock!==false?[{reservation_id:RESERVATION,client_order_id:CLIENT_ID}]:[]};
    }
    if(sql.startsWith("UPDATE private.strata_emergency_exit_reservations")){
      events.push("UPDATE");
      assert.match(sql,/state='UNKNOWN'/);
      assert.match(sql,/state='PREPARED'/);
      assert.match(sql,/trading_authorized=false/);
      assert.deepEqual(args?.slice(0,3),[RESERVATION,OWNER,ACCOUNT]);
      if(opts.failAt==="update")throw new Error("write_failed");
      if(phase!=="PREPARED"||opts.update===false)return {rows:[]};
      phase="UNKNOWN";
      return {rows:[{reservation_id:opts.badReturn?"wrong-id":RESERVATION,client_order_id:CLIENT_ID}]};
    }
    throw new Error("unexpected_sql:"+sql.slice(0,65));
  },release:()=>events.push("RELEASE")})};
  const run=(params:{
    owner?:string;account?:string;reservation?:string;
    order?:EmergencyExitOrder;lease?:typeof LEASE
  }={})=>markOwnedEmergencyExitUnknownForReview(
    params.owner??OWNER,params.account??ACCOUNT,params.reservation??RESERVATION,
    {keyId:"test",privateKey:"test"},
    params.order??ORDER,params.lease??LEASE,
    {inspect,db,now:()=>NOW,signerFingerprint:(()=> "a".repeat(64)) as typeof dedicatedSignerFingerprint},
  );
  return {run,events,phase:()=>phase};
}

test("durable UNKNOWN marker is committed before returning; no transport or retry authority",async()=>{
  const x=mock();
  const result=await x.run();
  assert.equal(result.unknownRecorded,true);
  assert.equal(result.ok,false);
  assert.equal(result.tradingAuthorized,false);
  assert.equal(result.transportAuthorized,false);
  assert.equal(result.mayRetry,false);
  assert.deepEqual(x.events.filter(z=>["LOCK","UPDATE","COMMIT"].includes(z)),["LOCK","UPDATE","COMMIT"]);
  assert.equal(x.phase(),"UNKNOWN");
  assert.equal(x.events.at(-1),"RELEASE");
  const again=await x.run();
  assert.equal(again.unknownRecorded,false);
  assert.equal(again.transportAuthorized,false);
  assert.equal(x.events.filter(z=>z==="UPDATE").length,1);
});

test("wrong owner, lease, order identity or unchecked advisory cannot mark UNKNOWN",async()=>{
  for(const invalid of [
    {owner:"not-owner"},
    {account:""},
    {reservation:"bad-reservation"},
    {lease:{...LEASE,fencingToken:0}},
    {order:{...ORDER,reduce_only:false}},
    {order:{...ORDER,exchange_index:1}},
    {order:{...ORDER,client_order_id:"forged"}},
    {order:{...ORDER,time_in_force:"good_til_canceled"}},
    {order:{...ORDER,price:"1.0100"}},
    {order:{...ORDER,price:"0.55"}},
    {order:{...ORDER,price:"0.00001"}},
    {order:{...ORDER,price:"0.0000"}},
    {order:{...ORDER,price:"1.0000"}},
  ]){
    const x=mock();
    const result=await x.run(invalid);
    assert.equal(result.unknownRecorded,false);
    assert.equal(x.events.length,0);
  }
  const x=mock({advisory:false});
  assert.equal((await x.run()).unknownRecorded,false);
  assert.equal(x.events.length,0);
});

test("concurrent, failed and ambiguous database transitions fail closed and never grant retry",async()=>{
  for(const scenario of [
    {lock:false},{update:false},{failAt:"lock" as const},
    {failAt:"update" as const},{failAt:"commit" as const},{badReturn:true},
  ]){
    const x=mock(scenario);
    const result=await x.run();
    assert.equal(result.unknownRecorded,false);
    assert.equal(result.transportAuthorized,false);
    assert.equal(result.mayRetry,false);
    assert.equal(result.tradingAuthorized,false);
    assert.equal(x.events.includes("COMMIT"),scenario.failAt==="commit");
    assert.equal(x.events.at(-1),"RELEASE");
    assert.ok(x.events.includes("ROLLBACK"));
  }
});
