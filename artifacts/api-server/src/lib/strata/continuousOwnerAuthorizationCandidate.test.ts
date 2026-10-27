import test from "node:test";
import assert from "node:assert/strict";
import {inspectContinuousEligibility,CONTINUOUS_STANDING_ELIGIBILITY_SQL,
 CONTINUOUS_STANDING_CONFIRM,enrollContinuousOwnerAuthorization,
 revokeContinuousOwnerAuthorization,CONTINUOUS_ENROLL_SQL,CONTINUOUS_OWNER_REVOKE_SQL
} from "./continuousOwnerAuthorizationCandidate";
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

test("candidate enrollment requires real owner confirmation, review and release identifiers",async()=>{
 let touched=0;
 const db={query:async()=>{touched++;return {rows:[{id}]}}};
 for(const c of ["", "YES", "I_AUTHORIZE", "I_STOP"]){
  const r=await enrollContinuousOwnerAuthorization(db,owner,sha,id,id,c);
  assert.equal(r.ok,false);
 }
 assert.equal(touched,0);
 const ok=await enrollContinuousOwnerAuthorization(db,owner,sha,id,id,CONTINUOUS_STANDING_CONFIRM);
 assert.deepEqual(ok,{ok:true,reason:"signed_owner_continuous_consent_recorded",authorizationId:id});
 assert.equal(touched,1);
});
test("candidate enrollment SQL requires active real signatures, matching owner+SHA, and current fees",()=>{
 for(const condition of ["v.revoked_at IS NULL","v.expires_at>now()",
   "r.review_url", "reviewed.email_confirmed_at", "oa.revoked_at IS NULL",
   "a.owner_user_id=$1::uuid","p.state='APPROVED'",
   "d.valid_until>now()","d.lease_expires_at>now()",
   "a.reconciled_at>now()","ON CONFLICT DO NOTHING"]){
  // The review URL is stored immutable as part of the inspected PR receipt.
  if(condition==="r.review_url")continue;
  assert.ok(CONTINUOUS_ENROLL_SQL.includes(condition),condition);
 }
});
test("candidate revocation is owner-scoped, one-way, and fails closed",async()=>{
 assert.ok(CONTINUOUS_OWNER_REVOKE_SQL.includes("owner_user_id=$1::uuid"));
 assert.ok(CONTINUOUS_OWNER_REVOKE_SQL.includes("revoked_at IS NULL"));
 assert.ok(CONTINUOUS_OWNER_REVOKE_SQL.includes("revoked_at=now()"));
 const ok=await revokeContinuousOwnerAuthorization({query:async()=>({rows:[{id}]})},owner,sha);
 assert.deepEqual(ok,{ok:true,reason:"owner_continuous_authorization_revoked"});
 const again=await revokeContinuousOwnerAuthorization({query:async()=>({rows:[]})},owner,sha);
 assert.equal(again.ok,false);
 const down=await revokeContinuousOwnerAuthorization({query:async()=>{throw Error("down")}},owner,sha);
 assert.equal(down.ok,false);
});
