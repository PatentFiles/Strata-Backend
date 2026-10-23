import assert from "node:assert/strict";
import test from "node:test";
import {recordOwnerV3FeeEvidence,OWNER_V3_FEE_CONFIRM} from "./ownerFeeV3Evidence";
import type {MonetaryFeeEvidenceContract} from "./monetaryFeeContract";

const OWNER="11111111-1111-4111-8111-111111111111", SHA="a".repeat(40);
const proof:MonetaryFeeEvidenceContract={ok:true,reason:"verified",stage:"STEP_9",
  marketTicker:"KXBTC15M-TEST",sourceDigest:"b".repeat(64),verifiedAt:"2026-10-23T18:00:00.000Z",
  monetaryFeeAuthorized:true,policyApproved:false,tradingAuthorized:false};
const account={id:"strata-account-test",kill_switch:true,execution_enabled:false,
  cash_precision_verified:true,lease_state:"released"};
function mock(row:Record<string,unknown>|null=account,prior=false){
 const sqls:string[]=[];
 const tx={
   query:async(sql:string,args:unknown[]=[])=>{
     sqls.push(sql);
     if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL"))return {rows:[]};
     if(sql.includes("FROM public.v13_production_account a")){
       assert.deepEqual(args,[OWNER]);return {rows:row?[row]:[]};
     }
     if(sql.includes("FROM private.strata_owner_fee_evidence_v3"))
       return {rows:prior?[{attestation_id:"already"}]:[]};
     if(sql.includes("INSERT INTO private.strata_owner_fee_evidence_v3")){
       assert.deepEqual(args.slice(1,6),[OWNER,"strata-account-test",SHA,proof.sourceDigest,proof.marketTicker]);
       return {rows:[{attestation_id:"recorded",expires_at:"2026-10-23 20:00:00+00"}]};
     }
     throw Error("unexpected SQL "+sql);
   },
   release:()=>{},
 };
 return {db:{connect:async()=>tx},sqls};
}
const args={confirmation:OWNER_V3_FEE_CONFIRM};
const run=(db:ReturnType<typeof mock>["db"],check=async()=>proof)=>
 recordOwnerV3FeeEvidence(OWNER,args,{db,check,sha:()=>SHA,now:()=>1792778400000});
test("owner-only actual-source consent produces a NO-TRADE immutable receipt",async()=>{
 const {db,sqls}=mock();const result=await run(db);
 assert.equal(result.ok,true);
 assert.equal(result.evidenceRecorded,true);
 assert.equal(result.grantIssued,false);
 assert.equal(result.policyMigrated,false);
 assert.equal(result.protectiveExitReleased,false);
 assert.equal(result.ordersSubmitted,false);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(result.receiptId,"recorded");
 assert.ok(sqls.includes("COMMIT"));
 assert.equal(sqls.some(x=>/insert into .*owner_sha|order|live_execution_config/i.test(x)),false);
});
test("bad owner confirmation and missing deployed SHA never touch database",async()=>{
 let called=false;const db={connect:async()=>{called=true;throw Error("bad")}};
 const wrong=await recordOwnerV3FeeEvidence(OWNER,{confirmation:"yes"},{db,sha:()=>SHA,check:async()=>proof});
 assert.equal(wrong.ok,false);assert.equal(called,false);
 const sha=await recordOwnerV3FeeEvidence(OWNER,args,{db,sha:()=>"missing",check:async()=>proof});
 assert.equal(sha.reason,"exact_deployed_backend_sha_unavailable");assert.equal(called,false);
 const foreign=await recordOwnerV3FeeEvidence("forged",args,{db,sha:()=>SHA,check:async()=>proof});
 assert.equal(foreign.ok,false);assert.equal(called,false);
});
test("stale or invalid official fee evidence never writes an owner receipt",async()=>{
 for(const fee of [
  {...proof,ok:false},{...proof,sourceDigest:"bad"},
  {...proof,marketTicker:"KXETH-TEST"},{...proof,stage:"ORDER_ENTRY" as const},
  {...proof,monetaryFeeAuthorized:false},
 ]){
   const {db,sqls}=mock();const v=await run(db,async()=>fee);
   assert.equal(v.ok,false);assert.equal(sqls.length,0);
 }
 const {db,sqls}=mock();
 const v=await run(db,async()=>{throw Error("HTTP 429")});
 assert.equal(v.reason,"official_fee_source_unavailable");assert.equal(sqls.length,0);
});
test("owner must be stopped, disarmed, flat worker, and cash-precision verified",async()=>{
 for(const row of [
  {...account,execution_enabled:true},{...account,kill_switch:false},
  {...account,lease_state:"owned"},{...account,cash_precision_verified:false},null,
 ]){
  const {db,sqls}=mock(row);const v=await run(db);
  assert.equal(v.ok,false);assert.equal(v.evidenceRecorded,false);
  assert.equal(sqls.some(s=>s.includes("INSERT INTO private.strata_owner_fee_evidence_v3")),false);
  assert.ok(sqls.includes("ROLLBACK"));
 }
});
test("duplicate current exact-SHA owner consent is serialized and rejected",async()=>{
 const {db,sqls}=mock(account,true);const v=await run(db);
 assert.equal(v.reason,"active_owner_fee_v3_evidence_already_exists");
 assert.equal(sqls.some(s=>s.includes("INSERT INTO private.strata_owner_fee_evidence_v3")),false);
 assert.ok(sqls.includes("ROLLBACK"));
});
