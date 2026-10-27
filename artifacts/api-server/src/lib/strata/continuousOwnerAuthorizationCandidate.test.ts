import test from "node:test";
import assert from "node:assert/strict";
import {inspectContinuousEligibility,CONTINUOUS_STANDING_ELIGIBILITY_SQL,
 CONTINUOUS_STANDING_CONFIRM} from "./continuousOwnerAuthorizationCandidate";
const owner="11111111-1111-4111-8111-111111111111";
const sha="a".repeat(40);
const id="22222222-2222-4222-8222-222222222222";
test("standing authorization candidate is inspect-only and requires exact owner/SHA",async()=>{
 let called=0;
 const db={query:async()=>{called++;return {rows:[]}}};
 assert.equal((await inspectContinuousEligibility(db,"invalid",owner)).ok,false);
 assert.equal((await inspectContinuousEligibility(db,sha,"invalid")).ok,false);
 assert.equal(called,0);
});
test("missing, ambiguous, malformed and unreachable grants fail closed",async()=>{
 for(const rows of [[],[{grant_id:"bad"}],[{grant_id:id},{grant_id:id}]]){
  const d=await inspectContinuousEligibility({query:async()=>({rows})},sha,owner);
  assert.deepEqual(d,{ok:false,reason:"standing_authorization_missing_or_unverified"});
 }
 const denied=await inspectContinuousEligibility({query:async()=>{throw Error("down")}},sha,owner);
 assert.deepEqual(denied,{ok:false,reason:"standing_database_unavailable"});
});
test("candidate grant binds reviewer, release, owner code, policy, cash and live fee",async()=>{
 let queries=0;
 const ok=await inspectContinuousEligibility({query:async(sql,args)=>{
  queries++;assert.equal(sql,CONTINUOUS_STANDING_ELIGIBILITY_SQL);
  assert.deepEqual(args,[sha,owner]);return {rows:[{grant_id:id}]};
 }},sha,owner);
 assert.deepEqual(ok,{ok:true,reason:"standing_continuous_eligibility_verified"});
 assert.equal(queries,1);
 for(const fragment of ["s.revoked_at IS NULL","oa.revoked_at IS NULL",
  "pr.revoked_at IS NULL","s.release_commit_sha=$1",
  "p.policy_hash=s.approved_policy_hash","a.reconciled_at >=",
  "fd.valid_until>now()","fd.lease_expires_at>now()",
  "a.kill_switch=false","a.blocked_reason IS NULL"]){
   assert.ok(CONTINUOUS_STANDING_ELIGIBILITY_SQL.includes(fragment),fragment);
 }
 assert.equal(CONTINUOUS_STANDING_CONFIRM,
  "I_EXPLICITLY_AUTHORIZE_REVOCABLE_SAME_SHA_CONTINUOUS_EXECUTION_V1");
});
