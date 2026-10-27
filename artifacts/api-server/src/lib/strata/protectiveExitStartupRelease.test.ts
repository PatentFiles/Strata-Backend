import test from "node:test";
import assert from "node:assert/strict";
import {verifyProtectiveExitStartupRelease,PROTECTIVE_STARTUP_RELEASE_SQL,OWNER_SHA_STARTUP_RELEASE_SQL} from "./protectiveExitStartupRelease";

test("standing release SQL rejects SHA and owner drift and changed policy or stake",()=>{
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/v\.expires_at <> 'infinity'::timestamptz/);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/v\.standing_execution_account_id/);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/p\.policy_hash=v\.standing_policy_hash/);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/stake\.configured_stake_cents=v\.standing_stake_cents/);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/v\.revoked_at IS NULL/);
});
const owner="11111111-1111-4111-8111-111111111111";
const releaseId="22222222-2222-4222-8222-222222222222";
const sha="a".repeat(40);
const env=(value:"true"|"false"|undefined="true")=>({
 NODE_ENV:"production",RAILWAY_PROJECT_ID:"hosted",
 RAILWAY_GIT_COMMIT_SHA:sha,
 ...(value===undefined?{}:{STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE:value}),
}) as NodeJS.ProcessEnv;

test("explicit Railway false switch prevents START without reading DB",async()=>{
 let called=false;
 const result=await verifyProtectiveExitStartupRelease({query:async()=>{
   called=true;return {rows:[{release_id:releaseId}]};
 }},owner,env("false"));
 assert.equal(result.ok,false);
 assert.equal(result.reason,"protective_exit_release_disabled");
 assert.equal(called,false);
});
test("absent or malformed switch cannot enable START even with an approved SHA",async()=>{
 for(const value of [undefined,"","TRUE","1","false"]){
  let dbReads=0;
  const candidate=env();
  if(value===undefined)delete candidate.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
  else candidate.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=value;
  const rejected=await verifyProtectiveExitStartupRelease({query:async()=>{
   dbReads++;return {rows:[{release_id:releaseId}]};
  }},owner,candidate);
  assert.equal(rejected.ok,false,String(value));
  assert.equal(rejected.reason,"protective_exit_release_disabled");
  assert.equal(dbReads,0);
 }
});
test("START refuses invalid runtime SHA and bad owner before any DB read",async()=>{
 let called=false;
 const db={query:async()=>{called=true;return {rows:[]}}};
 assert.equal((await verifyProtectiveExitStartupRelease(db,owner,{
   ...env(),RAILWAY_GIT_COMMIT_SHA:"not-a-commit",
 })).reason,"protective_exit_release_version_unknown");
 assert.equal((await verifyProtectiveExitStartupRelease(db,"untrusted",env())).reason,
   "protective_exit_owner_unverified");
 assert.equal(called,false);
});
test("owner SHA consent alone cannot bypass independent exact-SHA exit release",async()=>{
 let queries=0;
 const db={query:async(sql:string,args?:unknown[])=>{
  queries++;assert.deepEqual(args,[sha,owner]);
  if(sql===OWNER_SHA_STARTUP_RELEASE_SQL)return {rows:[{release_id:releaseId}]};
  if(sql===PROTECTIVE_STARTUP_RELEASE_SQL)return {rows:[]};
  throw Error("unrecognized release query");
 }};
 const result=await verifyProtectiveExitStartupRelease(db,owner,env());
 assert.equal(result.ok,false);
 assert.equal(result.reason,"protective_exit_exact_deployed_version_approval_missing");
 assert.equal(queries,2);
});
test("owner consent plus independent technical reviewer release permits startup",async()=>{
 let queries=0;
 const db={query:async(sql:string,args?:unknown[])=>{
  queries++;assert.deepEqual(args,[sha,owner]);
  if(sql===OWNER_SHA_STARTUP_RELEASE_SQL)return {rows:[{release_id:releaseId}]};
  if(sql===PROTECTIVE_STARTUP_RELEASE_SQL)return {rows:[{release_id:releaseId}]};
  throw Error("unrecognized release query");
 }};
 assert.deepEqual(await verifyProtectiveExitStartupRelease(db,owner,env()),
  {ok:true,reason:"protective_exit_release_verified"});
 assert.equal(queries,2);
});

test("Step 12 owner SHA approval is mandatory, not a fallback after a query failure",async()=>{
 for(const state of ["absent","invalid","db_error"]){
  let attempts=0;
  const db={query:async(sql:string)=>{
   attempts++;
   if(sql!==OWNER_SHA_STARTUP_RELEASE_SQL)
     throw Error("technical release should never be checked without owner authority");
   if(state==="db_error")throw Error("owner approval schema unavailable");
   return {rows:state==="absent"?[]:[{release_id:"not-a-uuid"}]};
  }};
  const result=await verifyProtectiveExitStartupRelease(db,owner,env());
  assert.equal(result.ok,false,state);
  assert.equal(result.reason,state==="absent"?"owner_code_approval_missing":
    state==="invalid"?"owner_code_approval_unverified":
    "owner_code_approval_evidence_unavailable",state);
  assert.equal(attempts,1);
 }
});
test("exact deployed SHA and unrelated reviewer with unexpired release is required",async()=>{
 let calls=0;
 const db={query:async(sql:string,args?:unknown[])=>{
  calls++;
  assert.ok(sql===PROTECTIVE_STARTUP_RELEASE_SQL||sql===OWNER_SHA_STARTUP_RELEASE_SQL);
  assert.deepEqual(args,[sha,owner]);
  return {rows:[{release_id:releaseId}]};
 }};
 const result=await verifyProtectiveExitStartupRelease(db,owner,env());
 assert.deepEqual(result,{ok:true,reason:"protective_exit_release_verified"});
 assert.equal(calls,2);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/release_commit_sha=\$1::text/);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/independent_reviewer_id <> \$2::uuid/);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/expires_at>now\(\)\+interval '20 minutes'/);
 assert.match(PROTECTIVE_STARTUP_RELEASE_SQL,/revoked_at IS NULL/);
});
test("no release, ambiguous release or DB failures refuse START",async()=>{
 for(const rows of [[],[{release_id:releaseId},{release_id:releaseId}]]) {
  const outcome=await verifyProtectiveExitStartupRelease({query:async(sql:string)=>({rows:sql===OWNER_SHA_STARTUP_RELEASE_SQL?[{release_id:releaseId}]:rows})},owner,env());
  assert.equal(outcome.ok,false);
  assert.equal(outcome.reason,"protective_exit_exact_deployed_version_approval_missing");
 }
 const duplicate=await verifyProtectiveExitStartupRelease({query:async(sql:string)=>({
  rows:sql===OWNER_SHA_STARTUP_RELEASE_SQL?[{release_id:releaseId},{release_id:releaseId}]:[],
 })},owner,env());
 assert.equal(duplicate.reason,"duplicate_owner_code_approval");
 const broken=await verifyProtectiveExitStartupRelease({query:async()=>{throw Error("offline")}},owner,env());
 assert.equal(broken.reason,"owner_code_approval_evidence_unavailable");
 const failedTech=await verifyProtectiveExitStartupRelease({query:async(sql:string)=>{
   if(sql===OWNER_SHA_STARTUP_RELEASE_SQL)return {rows:[{release_id:releaseId}]};
   throw Error("independent reviewer evidence unavailable");
 }},owner,env());
 assert.equal(failedTech.reason,"protective_exit_release_evidence_unavailable");
});
test("Railway environment always enforces gate even if NODE_ENV accidentally set to test",async()=>{
 const observed=await verifyProtectiveExitStartupRelease({query:async()=>({rows:[]})},
  owner,{...env("false"),NODE_ENV:"test"});
 assert.equal(observed.reason,"protective_exit_release_disabled");
});
test("isolated tests can run without production release credentials",async()=>{
 const decision=await verifyProtectiveExitStartupRelease({query:async()=>{
  throw Error("should not access external database");
 }},owner,{NODE_ENV:"test"});
 assert.equal(decision.ok,true);
});

test("owner SHA query excludes accounts under any persisted risk/commissioning freeze",()=>{
 assert.ok(OWNER_SHA_STARTUP_RELEASE_SQL.includes("a.blocked_reason IS NULL"));
});

test("the account owner and an independently approved exit SHA are both necessary at START",()=>{
 assert.ok(OWNER_SHA_STARTUP_RELEASE_SQL.includes("oa.release_commit_sha=$1"));
 assert.ok(OWNER_SHA_STARTUP_RELEASE_SQL.includes("oa.owner_user_id=$2::uuid"));
 assert.ok(OWNER_SHA_STARTUP_RELEASE_SQL.includes("a.blocked_reason IS NULL"));
 assert.ok(PROTECTIVE_STARTUP_RELEASE_SQL.includes("independent_reviewer_id <> $2::uuid"));
});
