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
const stake=500;
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

test("owner alone may approve after authentic qualification, but stale freeze requires separate personal consent",async()=>{
 const sqls:string[]=[];
 const query=async(sql:string)=>{
  sqls.push(sql);
  if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.startsWith("SET LOCAL"))return {rows:[]};
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
    kill_switch:true,blocked_reason:"awaiting_account_commissioning",
    cash_micros:"5000000",reserved_micros:"0"}]};
  throw Error("unexpected production action");
 };
 const db={query,connect:async()=>({query,release(){}})};
 const r=await authorizeOwnerShaRelease(OWNER,confirmation,{db:db as never,sha:()=>SHA});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"explicit_owner_commissioning_repair_confirmation_required");
 assert.equal(sqls.some(sql=>sql.includes("UPDATE public.v13_production_account")),false);
 assert.equal(sqls.some(sql=>sql.includes("INSERT INTO private.strata_owner_sha_approvals")),false);
 assert.ok(sqls.includes("ROLLBACK"));
});
test("historical $1.50 configured stake cannot authorize exact-SHA owner release",async()=>{
 const oldStake=150;
 const legacyEvidence=v13Digest({accountId:ACCOUNT,policyId,feeDigest,stakeCents:oldStake,
   commissioningDigest:cDigest,minimumExitMicros:10000});
 const sqls:string[]=[];
 const query=async(sql:string):Promise<{rows:Record<string,unknown>[]}>=>{
   sqls.push(sql);
   if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.startsWith("SET LOCAL"))return {rows:[]};
   if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))
     return {rows:[{id:ACCOUNT,owner_id:OWNER,commissioned:true,execution_enabled:false,
       kill_switch:true,cash_precision_verified:true,minimum_exit_micros:10000,
       cash_micros:"25000000",reserved_micros:"0",fee_artifact_digest:feeDigest,
       policy_state:"APPROVED",policy_id:policyId,commissioning_digest:cDigest,
       configured_stake_cents:oldStake,max_entry_stake_cents:150,max_entry_all_in_cents:200}]};
   if(sql.includes("FROM public.v13_production_observation o"))
     return {rows:[{digest:legacyEvidence}]};
   if(sql.includes("FROM public.v13_production_account WHERE id=")&&sql.includes("FOR UPDATE"))
     return {rows:[{id:ACCOUNT,commissioned:true,cash_precision_verified:true,
       execution_enabled:false,kill_switch:true,blocked_reason:null,
       cash_micros:"25000000",reserved_micros:"0"}]};
   if(sql.includes("FROM public.live_execution_config"))
     return {rows:[{mode:"V13_PRODUCTION",live_execution_enabled:true,manual_kill_switch:false}]};
   if(sql.includes("FROM private.strata_protective_release_qualification"))
     return {rows:[{qualification_id:QID,evidence_digest:feeDigest}]};
   if(sql.includes("WITH unresolved_intents"))return {rows:[{n:"0"}]};
   throw Error("Unexpected SQL before minimum stake gate: "+sql.slice(0,90));
 };
 const db={query,connect:async()=>({query,release(){}})};
 const result=await authorizeOwnerShaRelease(OWNER,confirmation,{db:db as never,sha:()=>SHA});
 assert.deepEqual(result,{ok:false,reason:"approved_stake_or_available_cash_unverified",ordersSubmitted:false});
 assert.equal(sqls.some(q=>q.includes("INSERT INTO private.strata_owner_sha_approvals")),false);
 assert.equal(sqls.some(q=>q.includes("UPDATE public.v13_production_account")),false);
 assert.ok(sqls.includes("ROLLBACK"));
});

test("inconsistent global execution and kill state never records owner approval",async()=>{
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
     return {rows:[{mode:"V13_PRODUCTION",live_execution_enabled:false,manual_kill_switch:false}]};
   throw Error("unexpected query");
 };
 const db={query,connect:async()=>({query,release(){}})};
 const result=await authorizeOwnerShaRelease(OWNER,confirmation,{db:db as never,sha:()=>SHA});
 assert.equal(result.ok,false);
 assert.equal(result.reason,"global_execution_kill_state_inconsistent");
 assert.ok(sqls.includes("ROLLBACK"));
 assert.equal(sqls.some(s=>s.includes("INSERT INTO private.strata_owner_sha_approvals")),false);
 assert.equal(sqls.some(s=>s.includes("UPDATE public.live_execution_config")),false);
});

/**
 * Regression for real pre-owner-SHA accounts: commission + execution_enabled
 * may both be true while no SHA-bound owner approval exists. The release is
 * permitted only through fresh, independently verifiable ZERO-exposure proof,
 * never by inheriting the old execution flag or requesting another login.
 */
test("legacy-enabled Step 12 refuses a running lease without writing an approval",async()=>{
 const sqls:string[]=[];
 const query=async(sql:string):Promise<{rows:Record<string,unknown>[]}>=>{
   sqls.push(sql);
   if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.startsWith("SET LOCAL"))return {rows:[]};
   if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))
     return {rows:[{id:ACCOUNT,owner_id:OWNER,commissioned:true,execution_enabled:true,
       kill_switch:false,cash_precision_verified:true,minimum_exit_micros:10000,
       cash_micros:"25000000",reserved_micros:"0",fee_artifact_digest:feeDigest,
       policy_state:"APPROVED",policy_id:policyId,commissioning_digest:cDigest,
       configured_stake_cents:stake,max_entry_stake_cents:2500,max_entry_all_in_cents:2500,
       revision:1,key_fingerprint:"f".repeat(64),kalshi_connection_id:QID}]};
   if(sql.includes("FROM public.v13_production_observation o"))
     return {rows:[{digest:evidence}]};
   if(sql.includes("FROM public.v13_production_account WHERE id=")&&sql.includes("FOR UPDATE"))
     return {rows:[{id:ACCOUNT,commissioned:true,cash_precision_verified:true,
       execution_enabled:true,kill_switch:false,blocked_reason:null,
       cash_micros:"25000000",reserved_micros:"0",revision:1,key_fingerprint:"f".repeat(64)}]};
   if(sql.includes("FROM public.live_execution_config"))
     return {rows:[{mode:"V13_PRODUCTION",live_execution_enabled:true,manual_kill_switch:false}]};
   if(sql.includes("FROM private.strata_protective_release_qualification"))
     return {rows:[{qualification_id:QID,evidence_digest:feeDigest}]};
   if(sql.includes("WITH unresolved_intents"))
     return {rows:[{n:"0"}]};
   if(sql.includes("FROM public.v13_production_intent WHERE account_id=")&&
      sql.includes("running_leases"))
     return {rows:[{intents:0,events:0,positions:0,reservations:0,running_leases:1}]};
   if(sql.includes("FROM private.kalshi_connection_credentials c"))
     return {rows:[{decrypted_secret:JSON.stringify({api_key_id:"offline-key-id",private_key:"offline-only"})}]};
   throw Error("unexpected query: "+sql.slice(0,70));
 };
 const db={query,connect:async()=>({query,release(){}})};
 const result=await authorizeOwnerShaRelease(OWNER,confirmation,{db:db as never,sha:()=>SHA,
   readFeeds:(async(_material:unknown,observedAtMs:number)=>({
     ok:true,observedAtMs,cashMicros:"25000000",
     orders:[],fills:[],positions:[],settlements:[],
   })) as never});
 assert.equal(result.ok,false,JSON.stringify(result));
 assert.equal(result.reason,"owner_release_requires_zero_financial_history_or_worker_lease");
 assert.equal(sqls.some(s=>s.includes("INSERT INTO private.strata_owner_sha_approvals")),false);
 assert.equal(sqls.some(s=>s.includes("UPDATE public.v13_production_account")),false);
 assert.equal(sqls.includes("COMMIT"),false);
 assert.ok(sqls.includes("ROLLBACK"));
});

test("legacy-enabled commissioned owner can repair only the stale marker and approve their own exact SHA after zero-exposure proof",async()=>{
 const calls:string[]=[];
 const query=async(sql:string):Promise<{rows:Record<string,unknown>[]}>=>{
   calls.push(sql);
   if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.startsWith("SET LOCAL"))return {rows:[]};
   if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))
     return {rows:[{id:ACCOUNT,owner_id:OWNER,commissioned:true,execution_enabled:true,
       kill_switch:false,cash_precision_verified:true,minimum_exit_micros:10000,
       cash_micros:"25000000",reserved_micros:"0",fee_artifact_digest:feeDigest,
       policy_state:"APPROVED",policy_id:policyId,commissioning_digest:cDigest,
       key_fingerprint:"f".repeat(64),configured_stake_cents:stake,
       kalshi_connection_id:QID,max_entry_stake_cents:2500,max_entry_all_in_cents:2500,
       blocked_reason:"awaiting_account_commissioning",revision:1}]};
   if(sql.includes("FROM public.v13_production_observation o"))
     return {rows:[{digest:evidence}]};
   if(sql.includes("FROM public.v13_production_account WHERE id=")&&sql.includes("FOR UPDATE"))
     return {rows:[{id:ACCOUNT,commissioned:true,cash_precision_verified:true,
       execution_enabled:true,kill_switch:false,blocked_reason:"awaiting_account_commissioning",
       cash_micros:"25000000",reserved_micros:"0",revision:1,key_fingerprint:"f".repeat(64)}]};
   if(sql.includes("FROM public.live_execution_config"))
     return {rows:[{mode:"V13_PRODUCTION",live_execution_enabled:true,manual_kill_switch:false}]};
   if(sql.includes("FROM private.strata_protective_release_qualification"))
     return {rows:[{qualification_id:QID,evidence_digest:feeDigest}]};
   if(sql.includes("WITH unresolved_intents"))return {rows:[{n:"0"}]};
   if(sql.includes("running_leases")&&sql.includes("SELECT count(*)"))
     return {rows:[{intents:0,events:0,positions:0,reservations:0,running_leases:0}]};
   if(sql.includes("FROM private.kalshi_connection_credentials c"))
     return {rows:[{decrypted_secret:JSON.stringify({api_key_id:"offline-key-id",private_key:"offline-only"})}]};
   if(sql.includes("SET blocked_reason=NULL"))return {rows:[{id:ACCOUNT}]};
   if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
   if(sql.includes("FROM private.strata_owner_sha_approvals"))return {rows:[]};
   if(sql.includes("INSERT INTO private.strata_owner_sha_approvals"))
     return {rows:[{approval_id:QID}]};
   if(sql.includes("WHERE id=$1 AND owner_user_id=$2::uuid AND commissioned=true")&&
      sql.includes("reserved_micros=0"))return {rows:[{id:ACCOUNT}]};
   throw Error("unexpected query: "+sql.slice(0,80));
 };
 const db={query,connect:async()=>({query,release(){}})};
 const result=await authorizeOwnerShaRelease(OWNER,{
   ...confirmation,provisionalRepairConfirmation:
     "I_AUTHORIZE_AN_AUDITED_REPAIR_OF_MY_STALE_COMMISSIONING_BLOCKER",
 },{db:db as never,sha:()=>SHA,
    readFeeds:(async(_material:unknown,observedAtMs:number)=>({
      ok:true,observedAtMs,cashMicros:"25000000",
      orders:[],fills:[],positions:[],settlements:[],
    })) as never});
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal("approvalId" in result ? result.approvalId : null,QID);
 assert.equal(result.ordersSubmitted,false);
 assert.equal(calls.includes("COMMIT"),true);
 const repairAt=calls.findIndex(s=>s.includes("SET blocked_reason=NULL"));
 const approveAt=calls.findIndex(s=>s.includes("INSERT INTO private.strata_owner_sha_approvals"));
 assert.ok(repairAt>0&&approveAt>repairAt,"repair is fenced before approval");
 assert.equal(calls.some(s=>s.includes("UPDATE public.live_execution_config")),false);
 assert.equal(calls.some(s=>s.includes("UPDATE public.v13_production_account")&&s.includes("SET execution_enabled=true")),false);
});

test("global STOP permits separately signed SHA owner consent, without lifting account/global kills",async()=>{
 const calls:string[]=[];
 const query=async(sql:string):Promise<{rows:Record<string,unknown>[]}>=>{
   calls.push(sql);
   if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.startsWith("SET LOCAL"))return {rows:[]};
   if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))
     return {rows:[{id:ACCOUNT,owner_id:OWNER,commissioned:true,execution_enabled:true,
       kill_switch:true,cash_precision_verified:true,minimum_exit_micros:10000,
       cash_micros:"25000000",reserved_micros:"0",fee_artifact_digest:feeDigest,
       policy_state:"APPROVED",policy_id:policyId,commissioning_digest:cDigest,
       key_fingerprint:"f".repeat(64),configured_stake_cents:stake,
       kalshi_connection_id:QID,max_entry_stake_cents:2500,max_entry_all_in_cents:2500,
       blocked_reason:null,revision:1}]};
   if(sql.includes("FROM public.v13_production_observation o"))return {rows:[{digest:evidence}]};
   if(sql.includes("FROM public.v13_production_account WHERE id=")&&sql.includes("FOR UPDATE"))
     return {rows:[{id:ACCOUNT,commissioned:true,cash_precision_verified:true,
       execution_enabled:true,kill_switch:true,blocked_reason:null,
       cash_micros:"25000000",reserved_micros:"0",revision:1,key_fingerprint:"f".repeat(64)}]};
   if(sql.includes("FROM public.live_execution_config"))
     return {rows:[{mode:"V13_PRODUCTION",live_execution_enabled:false,manual_kill_switch:true}]};
   if(sql.includes("FROM private.strata_protective_release_qualification"))
     return {rows:[{qualification_id:QID,evidence_digest:feeDigest}]};
   if(sql.includes("WITH unresolved_intents"))return {rows:[{n:"0"}]};
   if(sql.includes("running_leases")&&sql.includes("SELECT count(*)"))
     return {rows:[{intents:0,events:0,positions:0,reservations:0,running_leases:0}]};
   if(sql.includes("FROM private.kalshi_connection_credentials c"))
     return {rows:[{decrypted_secret:JSON.stringify({api_key_id:"offline-key-id",private_key:"offline-only"})}]};
   if(sql.includes("FROM private.strata_owner_sha_approvals"))return {rows:[]};
   if(sql.includes("INSERT INTO private.strata_owner_sha_approvals"))
     return {rows:[{approval_id:QID}]};
   if(sql.includes("WHERE id=$1 AND owner_user_id=$2::uuid AND commissioned=true")&&
       sql.includes("reserved_micros=0"))return {rows:[{id:ACCOUNT}]};
   if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
   throw Error("unexpected SQL: "+sql.slice(0,90));
 };
 const db={query,connect:async()=>({query,release(){}})};
 const result=await authorizeOwnerShaRelease(OWNER,confirmation,{
   db:db as never,sha:()=>SHA,
   readFeeds:(async(_creds:unknown,observedAtMs:number)=>({
     ok:true,observedAtMs,cashMicros:"25000000",
     orders:[],fills:[],positions:[],settlements:[],
   })) as never,
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(calls.includes("COMMIT"),true);
 assert.equal(calls.some(x=>x.includes("INSERT INTO private.strata_owner_sha_approvals")),true);
 assert.equal(calls.some(x=>x.includes("UPDATE public.live_execution_config")),false);
 assert.equal(calls.some(x=>x.includes("SET execution_enabled=true")),false);
 assert.equal(calls.some(x=>x.includes("kill_switch=false")),false);
 assert.equal(result.ordersSubmitted,false);
});
