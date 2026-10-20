import test from "node:test";
import assert from "node:assert/strict";
import { digest as v13Digest } from "../v13-production/types";
import {
  qualifyProtectiveRelease,attestProtectiveReleaseReview,
  authorizeProtectiveRelease,REVIEW_CONFIRM,OWNER_CONFIRM,PROVISIONAL_REPAIR_CONFIRM,
 DURABLE_REVIEW_CONFIRM,DURABLE_OWNER_CONFIRM,
} from "./inAppProtectiveRelease";
const OWNER="11111111-1111-4111-8111-111111111111";
const REVIEWER="22222222-2222-4222-8222-222222222222";
const SHA="a".repeat(40);
const DIGEST="b".repeat(64);
const QID="33333333-3333-4333-8333-333333333333";
const RID="44444444-4444-4444-8444-444444444444";
const account={id:"owner-execution-2",owner_id:OWNER,commissioned:true,policy_state:"APPROVED",
 cash_precision_verified:true,minimum_exit_micros:10000,fee_artifact_digest:DIGEST,
 fee_source_url:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 cash_micros:"25000000",key_fingerprint:"c".repeat(64),
 policy_id:"policy-v13",commissioning_digest:"c".repeat(64),kalshi_connection_id:QID,configured_stake_cents:100,
 max_entry_stake_cents:2500,max_entry_all_in_cents:3000};
type Row=Record<string,unknown>;
function fakeDb(input:{review?:boolean;duplicate?:boolean;permit?:boolean;badCash?:boolean;freeze?:string;unresolved?:boolean;fresh?:boolean}={}){
 const executed:string[]=[];
 const query=async(sql:string,_args?:unknown[]):Promise<{rows:Row[]}>=>{
  executed.push(sql);
  if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL"))return {rows:[]};
  if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))return {rows:[{...account,blocked_reason:input.freeze??null}]};
  if(sql.includes("FROM public.v13_production_observation o"))return {rows:[{
    digest:v13Digest({accountId:String(account.id),policyId:String(account.policy_id),
      feeDigest:String(account.fee_artifact_digest),stakeCents:Number(account.configured_stake_cents),
      commissioningDigest:String(account.commissioning_digest??""),
      minimumExitMicros:Number(account.minimum_exit_micros)})
  }]};
  if(sql.includes("WITH unresolved_intents"))return {rows:[{n:"0"}]};
  if(sql.includes("FROM private.kalshi_connection_credentials c"))return {rows:[{
    decrypted_secret:JSON.stringify({api_key_id:"not-real",private_key:"offline-only"}),
  }]};
  // The guarded UPDATE embeds NOT EXISTS history subqueries; match writes
  // before generic SELECT history mocks or this test would falsely refuse.
  if(sql.includes("UPDATE public.v13_production_account"))return {rows:[{id:account.id}]};
  if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
  if(sql.includes("FROM public.v13_production_intent WHERE account_id"))return {rows:[]};
  if(sql.includes("INSERT INTO private.strata_protective_release_qualification"))
   return {rows:[{id:QID,expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("FROM private.strata_protective_release_qualification"))
   return {rows:[{qualification_id:QID,evidence_digest:DIGEST}]};
  if(sql.includes("FROM private.strata_protective_release_reviews")&&
     sql.includes("reviewer_user_id=$2"))return {rows:input.duplicate?[{review_id:RID}]:[]};
  if(sql.includes("INSERT INTO private.strata_protective_release_reviews"))
   return {rows:[{id:RID,expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("FROM public.v13_production_account")&&sql.includes("FOR UPDATE"))
   return {rows:[{id:account.id,execution_enabled:false,kill_switch:true,cash_micros:"25000000",
    blocked_reason:input.freeze??null,commissioned:true,cash_precision_verified:true,reserved_micros:"0",
    reconciled_at:new Date(Date.now()-(input.fresh===false?60_000:1000)).toISOString()}]};
  if(sql.includes("FROM public.live_execution_config"))return {rows:[{
    mode:"V13_PRODUCTION",live_execution_enabled:false,manual_kill_switch:true,
  }]};
  if(sql.includes("FROM private.strata_protective_release_reviews r")&&
     sql.includes("JOIN private.strata_protective_release_qualification"))
   return {rows:input.review===false?[]:[{review_id:RID,reviewer_user_id:REVIEWER,
     review_url:"https://github.com/PatentFiles/Strata-Backend/pull/107",review_scope:process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED==="true"?"DURABLE_CODE_V1":"TWO_HOUR",
     evidence_digest:DIGEST,qualification_digest:DIGEST}]};
  if(sql.includes("FROM auth.users u JOIN public.profiles p"))return {rows:input.permit===false?[]:[{"?column?":1}]};
  if(sql.includes("AS intents,")||sql.includes(") intents,"))
   return {rows:[{intents:input.unresolved?"1":"0",events:"0",positions:"0",exit_reservations:"0"}]};
  if(sql.includes("INSERT INTO private.strata_durable_code_approvals"))
    return {rows:[{id:"55555555-5555-4555-8555-555555555555",expires_at:null}]};
  if(sql.includes("FROM private.strata_protective_exit_release"))return {rows:[]};
  if(sql.includes("INSERT INTO private.strata_protective_exit_release"))
   return {rows:[{id:"55555555-5555-4555-8555-555555555555",expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("UPDATE public.live_execution_config"))return {rows:[{id:"singleton"}]};
  throw Error("unexpected_query");
 };
 const db={query,connect:async()=>({query,release(){executed.push("RELEASE")}})};
 return {db:db as never,executed};
}
test("PRODUCTION qualifier performs only owned GET and stores a digest, not a trading permission",async()=>{
 const h=fakeDb();
 let reads=0;
 const result=await qualifyProtectiveRelease(OWNER,{
  db:h.db,sha:()=>SHA,now:()=>Date.parse("2026-10-20T05:30:00Z"),
  readFeeds:(async()=>{reads++;return {ok:true,observedAtMs:Date.parse("2026-10-20T05:30:00Z"),
    cashMicros:"25000000",orders:[],fills:[],positions:[],settlements:[]}}) as never,
  verifyFee:(async()=>({ok:true,monetaryFeeAuthorized:true,sourceDigest:DIGEST})) as never,
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(reads,1);
 assert.equal(result.ordersSubmitted,false);
 assert.equal(h.executed.filter(s=>s.includes("INSERT INTO")).length,1);
 assert.equal(h.executed.some(s=>/INSERT INTO (?:public\.v13_production_intent|private\.strata_protective_exit_release)/.test(s)),false);
});
test("reviewer cannot impersonate account owner or use ordinary user role",async()=>{
 const h=fakeDb(),data={ownerUserId:OWNER,qualificationId:QID,
  reviewUrl:"https://github.com/PatentFiles/Strata-Backend/pull/107",
  note:"Reviewed the exact SHA, price floors, unknown orders, crash recovery, fees, owner isolation and signed production GET evidence.",
  confirmation:REVIEW_CONFIRM};
 assert.equal((await attestProtectiveReleaseReview(OWNER,"ADMIN",data,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal((await attestProtectiveReleaseReview(REVIEWER,"STANDARD",data,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal(h.executed.length,0);
});
test("authenticated distinct reviewer persists immutable evidence in transaction",async()=>{
 const h=fakeDb(),data={ownerUserId:OWNER,qualificationId:QID,
  reviewUrl:"https://github.com/PatentFiles/Strata-Backend/pull/107",
  note:"Reviewed the exact release SHA, official fee inputs, full provider history, cash and position reconciliation, signed exits, and no-retry crashes.",
  confirmation:REVIEW_CONFIRM};
 const r=await attestProtectiveReleaseReview(REVIEWER,"DEVELOPER",data,{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.ok(h.executed.indexOf("BEGIN")<h.executed.indexOf("COMMIT"));
 assert.equal(h.executed.some(s=>s.includes("UPDATE public.live_execution_config")),false);
});
test("owner acceptance is rejected if missing distinct reviewer or authenticated confirmation",async()=>{
 const h=fakeDb({review:false});
 const body={reviewId:RID,confirmation:OWNER_CONFIRM};
 assert.equal((await authorizeProtectiveRelease(OWNER,{...body,confirmation:"wrong"},{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal((await authorizeProtectiveRelease(OWNER,body,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal(h.executed.some(s=>s.includes("UPDATE public.live_execution_config")),false);
 assert.ok(h.executed.includes("ROLLBACK"));
});
test("owner consent inserts exact signed release then atomically enables account and global live flag",async()=>{
 const h=fakeDb();
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 assert.equal("workerStarted" in r && r.workerStarted,false);
 const insert=h.executed.findIndex(s=>s.includes("INSERT INTO private.strata_protective_exit_release"));
 const accountUpdate=h.executed.findIndex(s=>s.includes("UPDATE public.v13_production_account"));
 const globalUpdate=h.executed.findIndex(s=>s.includes("UPDATE public.live_execution_config"));
 assert.ok(insert>0&&accountUpdate>insert&&globalUpdate>accountUpdate);
 assert.ok(h.executed.indexOf("COMMIT")>globalUpdate);
});

test("provisional freeze cannot be cleared without distinct explicit owner consent",async()=>{
 const h=fakeDb({freeze:"awaiting_account_commissioning"});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"explicit_commissioning_repair_confirmation_required");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
 assert.equal(h.executed.includes("COMMIT"),false);
});
test("any genuine freeze is immutable through commissioning recovery",async()=>{
 const h=fakeDb({freeze:"unknown_exchange_order"});
 const r=await authorizeProtectiveRelease(OWNER,{
  reviewId:RID,confirmation:OWNER_CONFIRM,provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM,
 },{db:h.db,sha:()=>SHA});
 assert.equal(r.reason,"account_risk_freeze_requires_independent_remediation");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
});
test("owner-authorized recovery fails closed on stale reconciliation or unaccounted exposure",async()=>{
 for(const options of [{freeze:"awaiting_account_commissioning",fresh:false},
  {freeze:"awaiting_account_commissioning",unresolved:true}]){
  const h=fakeDb(options),r=await authorizeProtectiveRelease(OWNER,{
   reviewId:RID,confirmation:OWNER_CONFIRM,provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM,
  },{db:h.db,sha:()=>SHA});
  assert.equal(r.ok,false,r.reason);
  assert.equal(r.reason,"commissioning_repair_fresh_zero_exposure_unverified");
  assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
 }
});
test("explicit reviewed zero-exposure recovery is atomic, auditable and creates no order",async()=>{
 const h=fakeDb({freeze:"awaiting_account_commissioning"});
 const r=await authorizeProtectiveRelease(OWNER,{
  reviewId:RID,confirmation:OWNER_CONFIRM,provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM,
 },{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal("provisionalFreezeRepaired" in r && r.provisionalFreezeRepaired,true);
 const release=h.executed.findIndex(s=>s.includes("INSERT INTO private.strata_protective_exit_release"));
 const repair=h.executed.findIndex(s=>s.includes("SET blocked_reason=NULL"));
 const audit=h.executed.findIndex(s=>s.includes("OWNER_COMMISSIONING_FREEZE_REPAIR"));
 assert.ok(release>=0&&repair>release&&audit>repair);
 assert.ok(h.executed.indexOf("COMMIT")>audit);
 assert.equal(h.executed.some(s=>s.includes("INSERT INTO public.v13_production_intent")),false);
});

test("durable SHA mode requires distinct owner authorization and never auto-starts",async()=>{
 const old=process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED;
 process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED="true";
 try{
  const h=fakeDb(),base={reviewId:RID,confirmation:OWNER_CONFIRM};
  const blocked=await authorizeProtectiveRelease(OWNER,base,{db:h.db,sha:()=>SHA});
  assert.equal(blocked.ok,false);
  assert.equal(blocked.reason,"explicit_durable_code_owner_authorization_required");
  const approved=await authorizeProtectiveRelease(OWNER,{
   ...base,durableCodeAuthorizationConfirmation:DURABLE_OWNER_CONFIRM,
  },{db:h.db,sha:()=>SHA});
  assert.equal(approved.ok,true,JSON.stringify(approved));
  assert.equal("codeApprovalActive" in approved && approved.codeApprovalActive,true);
  assert.equal("workerStarted" in approved && approved.workerStarted,false);
  assert.equal(h.executed.filter(s=>s.includes("INSERT INTO private.strata_durable_code_approvals")).length,1);
  assert.equal(h.executed.filter(s=>s.includes("INSERT INTO private.strata_protective_exit_release")).length,0);
 }finally{
  if(old===undefined)delete process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED;
  else process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED=old;
 }
});
test("durable review attestation requires its own express independent scope confirmation",async()=>{
 const old=process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED;
 process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED="true";
 try{
  const data={ownerUserId:OWNER,qualificationId:QID,
   reviewUrl:"https://github.com/PatentFiles/Strata-Backend/pull/113",
   note:"I independently reviewed the long-lived exact SHA release, revocation, final signed exit fence, fee and book evidence, cash accounting, crashes, failover and risk gates.",
   confirmation:REVIEW_CONFIRM};
  const h=fakeDb();
  assert.equal((await attestProtectiveReleaseReview(REVIEWER,"ADMIN",data,{db:h.db,sha:()=>SHA})).ok,false);
  const signed=await attestProtectiveReleaseReview(REVIEWER,"ADMIN",{
   ...data,confirmation:DURABLE_REVIEW_CONFIRM,
  },{db:h.db,sha:()=>SHA});
  assert.equal(signed.ok,true,JSON.stringify(signed));
  assert.ok(h.executed.some(s=>s.includes("review_scope")));
 }finally{
  if(old===undefined)delete process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED;
  else process.env.STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED=old;
 }
});
