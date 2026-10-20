import assert from "node:assert/strict";
import test from "node:test";
import { INSTITUTIONAL_ENTRY_SQL, INSTITUTIONAL_EXIT_JOIN,
  INSTITUTIONAL_EXIT_PREDICATE, LEGACY_EXIT_JOIN, LEGACY_EXIT_PREDICATE,
  institutionalReleaseMode, INSTITUTIONAL_OPERATIONAL_SQL } from "./institutionalCodeApproval";
import { verifyProtectiveExitStartupRelease } from "./protectiveExitStartupRelease";

const owner="11111111-1111-4111-8111-111111111111";
const sha="a".repeat(40);
const approved="22222222-2222-4222-8222-222222222222";
const env={
 NODE_ENV:"production",RAILWAY_SERVICE_ID:"real-hosted-service",
 RAILWAY_GIT_COMMIT_SHA:sha,STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED:"true",
} as NodeJS.ProcessEnv;

test("institutional mode must be explicitly enabled, never coerced",()=>{
 for(const value of [undefined,"","TRUE","1","false","true "])
  assert.equal(institutionalReleaseMode({STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED:value}),"LEGACY_TWO_HOUR");
 assert.equal(institutionalReleaseMode(env),"DURABLE_CODE_V1");
});
test("owner SHA release requires an owner-specific, independent, revocable reviewed code approval",()=>{
 assert.match(INSTITUTIONAL_ENTRY_SQL,/release_commit_sha=\$1::text/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/owner_user_id=\$2::uuid/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/c.revoked_at IS NULL/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/c.independent_reviewer_id<>\$2::uuid/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/c.owner_approver_id=\$2::uuid/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/a.blocked_reason IS NULL/);
 assert.doesNotMatch(INSTITUTIONAL_ENTRY_SQL,/reconciled_at>now/,"START must not deadlock on stale heartbeat");
 assert.match(INSTITUTIONAL_OPERATIONAL_SQL,/a.reconciled_at>now\(\)-interval '15 seconds'/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/p.state='APPROVED'/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/g.manual_kill_switch=false/);
 assert.match(INSTITUTIONAL_ENTRY_SQL,/state IN \('DISPATCHED','UNKNOWN'\)/);
});
test("START with institutional flag uses only the new exact SHA and owner scope",async()=>{
 const calls:{sql:string;args?:unknown[]}[]=[];
 const result=await verifyProtectiveExitStartupRelease({
  query:async(sql,args)=>{calls.push({sql,args});return {rows:[{release_id:approved}]};},
 },owner,env);
 assert.equal(result.ok,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0]?.sql,INSTITUTIONAL_ENTRY_SQL);
 assert.deepEqual(calls[0]?.args,[sha,owner]);
});
test("hosted institutional START is fail-closed for missing approval, ambiguity, invalid SHA and DB outage",async()=>{
 for(const rows of [[],[{release_id:approved},{release_id:approved}]]){
  const d=await verifyProtectiveExitStartupRelease({query:async()=>({rows})},owner,env);
  assert.equal(d.ok,false);
 }
 assert.equal((await verifyProtectiveExitStartupRelease({
  query:async()=>{throw Error("schema not deployed");},
 },owner,env)).ok,false);
 const invalid=await verifyProtectiveExitStartupRelease({
  query:async()=>({rows:[{release_id:approved}]}),
 },owner,{...env,RAILWAY_GIT_COMMIT_SHA:"bad"});
 assert.equal(invalid.ok,false);
});
test("reduce-only signed exit remains fenced by durable SHA + owner and one-use execution gates",()=>{
 assert.match(INSTITUTIONAL_EXIT_JOIN,/strata_durable_code_approvals v/);
 assert.match(INSTITUTIONAL_EXIT_PREDICATE,/v.revoked_at IS NULL/);
 assert.match(INSTITUTIONAL_EXIT_PREDICATE,/v.owner_approver_id=a.owner_user_id/);
 assert.match(LEGACY_EXIT_JOIN,/strata_protective_exit_release v/);
 assert.match(LEGACY_EXIT_PREDICATE,/v.expires_at > now\(\)/);
});
