import test from "node:test";
import assert from "node:assert/strict";
import {digest as v13Digest} from "../v13-production/types";
import {
  authorizeOwnerShaRelease,ownerShaApprovalStatus,revokeOwnerShaRelease,
  OWNER_SHA_RELEASE_CONFIRM,OWNER_SHA_REVOKE_CONFIRM,
} from "./ownerShaRelease";
const OWNER="11111111-1111-4111-8111-111111111111";
const ACCOUNT="owned-account-one";
const SHA="a".repeat(40);
const QID="33333333-3333-4333-8333-333333333333";
const policyId="approved-owned-policy";
const feeDigest="b".repeat(64);
const cDigest="c".repeat(64);
const stake=150;
const evidence=v13Digest({accountId:ACCOUNT,policyId,feeDigest,stakeCents:stake,
  commissioningDigest:cDigest,minimumExitMicros:10000});
const confirmation={qualificationId:QID,confirmation:OWNER_SHA_RELEASE_CONFIRM};

test("owner SHA release rejects spoofed identities, invalid confirmations and stale SHA before DB",async()=>{
 let reads=0;
 const db={query:async()=>{reads++;throw Error("unexpected DB");},
  connect:async()=>{reads++;throw Error("unexpected transaction");}};
 for(const [owner,body,sha] of [
   ["not-a-user",confirmation,SHA],
   [OWNER,{...confirmation,confirmation:"not-authorized"},SHA],
   [OWNER,confirmation,"not-a-real-sha"],
   [OWNER,{...confirmation,qualificationId:"not-a-uuid"},SHA],
 ] as const){
   const result=await authorizeOwnerShaRelease(owner,body,{db:db as never,sha:()=>sha});
   assert.equal(result.ok,false);
 }
 const rev=await revokeOwnerShaRelease(OWNER,{confirmation:"wrong"},
   {db:db as never,sha:()=>SHA});
 assert.equal(rev.ok,false);
 assert.equal(reads,0);
});

test("owner SHA status refuses ambiguous approvals and database uncertainty",async()=>{
 const one={query:async()=>({rows:[{approval_id:QID}]})};
 const two={query:async()=>({rows:[{approval_id:QID},{approval_id:QID}]})};
 const down={query:async()=>{throw Error("offline")}};
 assert.deepEqual(await ownerShaApprovalStatus(OWNER,SHA,one),{available:true,active:true,approvalId:QID});
 assert.deepEqual(await ownerShaApprovalStatus(OWNER,SHA,two),{available:true,active:false,approvalId:null});
 assert.deepEqual(await ownerShaApprovalStatus(OWNER,SHA,down),{available:false,active:false,approvalId:null});
 assert.deepEqual(await ownerShaApprovalStatus("foreign",SHA,one),{available:false,active:false,approvalId:null});
});

test("global kill stays privileged even after owner AAL2 approval; transaction rolls back",async()=>{
 const sqls:string[]=[];
 const query=async(sql:string)=> {
   sqls.push(sql);
   if(sql==="BEGIN"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL"))return {rows:[]};
   if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))
     return {rows:[{id:ACCOUNT,owner_id:OWNER,commissioned:true,execution_enabled:false,
      kill_switch:true,cash_precision_verified:true,minimum_exit_micros:10000,
      cash_micros:"5000000",reserved_micros:"0",fee_artifact_digest:feeDigest,
      policy_state:"APPROVED",policy_id:policyId,commissioning_digest:cDigest,
      configured_stake_cents:stake,max_entry_stake_cents:2500,max_entry_all_in_cents:2500}]};
   if(sql.includes("FROM public.v13_production_observation o"))
     return {rows:[{digest:evidence}]};
   if(sql.includes("FROM public.v13_production_account WHERE id=")&&sql.includes("FOR UPDATE"))
     return {rows:[{commissioned:true,cash_precision_verified:true,execution_enabled:false,
       kill_switch:true,blocked_reason:null,cash_micros:"5000000",reserved_micros:"0"}]};
   if(sql.includes("FROM public.live_execution_config"))
     return {rows:[{mode:"V13_PRODUCTION",live_execution_enabled:false,manual_kill_switch:true}]};
   throw Error("unexpected query");
 };
 const db={query,connect:async()=>({query,release(){}})};
 const result=await authorizeOwnerShaRelease(OWNER,confirmation,{db:db as never,sha:()=>SHA});
 assert.equal(result.ok,false);
 assert.equal(result.reason,"privileged_global_live_release_required");
 assert.ok(sqls.includes("ROLLBACK"));
 assert.equal(sqls.some(s=>s.includes("INSERT INTO private.strata_owner_sha_approvals")),false);
 assert.equal(sqls.some(s=>s.includes("UPDATE public.live_execution_config")),false);
});
