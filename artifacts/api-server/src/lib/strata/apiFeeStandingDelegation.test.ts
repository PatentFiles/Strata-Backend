import test from "node:test";
import assert from "node:assert/strict";
import {
 signStandingFeeModel,consentStandingFeeDelegation,
 renewStandingFeeObservationLease,revokeStandingFeeDelegation,
 STANDING_MODEL_CONFIRM,STANDING_OWNER_CONFIRM
} from "./apiFeeStandingDelegation";

const OWNER="11111111-1111-4111-8111-111111111111";
const GRANT="22222222-2222-4222-8222-222222222222";
const MODEL="33333333-3333-4333-8333-333333333333";
const SHA="a".repeat(40);

test("issue154: no implicit independent human review or owner delegation",async()=>{
 let called=0;
 const db={query:async()=>{called++;throw Error("unexpected");},
  connect:async()=>{called++;throw Error("unexpected");}};
 const admin=await signStandingFeeModel(OWNER,{
  confirmation:STANDING_MODEL_CONFIRM,evidenceUrl:"https://random.example/fees",
  evidenceSha256:"0".repeat(64),note:"x".repeat(130)
 },{db:db as never,sha:()=>SHA});
 assert.equal(admin.ok,false);
 const owner=await consentStandingFeeDelegation(OWNER,{
  modelId:MODEL,grantId:GRANT,confirmation:"not owner consent"
 },{db:db as never,sha:()=>SHA});
 assert.equal(owner.ok,false);
 assert.equal(called,0);
});
test("issue154: only ORDER ENTRY or STEP11 can renew, owner and exact SHA required",async()=>{
 let writes=0;
 const db={query:async()=>{writes++;return {rows:[{delegation_id:MODEL,valid_until:"2026-11-10T00:00:00Z"}]}}};
 for(const [owner,grant,stage,sha] of [
  ["bad",GRANT,"ORDER_ENTRY",SHA],
  [OWNER,"bad","ORDER_ENTRY",SHA],
  [OWNER,GRANT,"STEP_9",SHA],
  [OWNER,GRANT,"ORDER_ENTRY","bad"]
 ] as const){
  const result=await renewStandingFeeObservationLease(owner,grant,stage,{db:db as never,sha:()=>sha});
  assert.equal(result.ok,false);
 }
 assert.equal(writes,0);
});
test("issue154: atomic observation renewal checks reviewer, consent, grant revocation, policy and release SHA",async()=>{
 let sql="",args:unknown[]=[];
 const db={query:async(query:string,values?:unknown[])=>{
  sql=query;args=values??[];return {rows:[{delegation_id:MODEL,valid_until:"2026-11-10T00:00:00Z"}]};
 }};
 const result=await renewStandingFeeObservationLease(OWNER,GRANT,"ORDER_ENTRY",{
  db:db as never,sha:()=>SHA,
 });
 assert.equal(result.ok,true);
 assert.ok(sql.startsWith("UPDATE private.strata_api_fee_standing_delegations"));
 for(const part of ["lease_expires_at","model_id","revoked_at IS NULL",
  "p.policy_hash=d.policy_hash","m.release_commit_sha=$3",
  "reviewed_role.role='ADMIN'","issuer_role.role='ADMIN'",
  "g.authorized_stages","con.revoked_at IS NULL","valid_until>now()"])
  assert.ok(sql.includes(part),"missing "+part);
 assert.deepEqual(args.slice(0,4),[OWNER,GRANT,SHA,"ORDER_ENTRY"]);
});
test("issue154: missing or revoked delegation never allows order entry",async()=>{
 const db={query:async()=>({rows:[]})};
 const result=await renewStandingFeeObservationLease(OWNER,GRANT,"ORDER_ENTRY",{
  db:db as never,sha:()=>SHA,
 });
 assert.equal(result.ok,false);
});
test("issue154: no owner can revoke another owner's delegation without own JWT identity",async()=>{
 const noWrites={connect:async()=>{throw Error("should not connect");}};
 const result=await revokeStandingFeeDelegation(OWNER,{
  delegationId:MODEL,confirmation:"NOT_APPROVED",reason:"Please revoke now"
 },{db:noWrites as never});
 assert.equal(result.ok,false);
 assert.equal(result.tradingAuthorized,false);
});
