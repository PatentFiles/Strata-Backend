import test from "node:test";
import assert from "node:assert/strict";
import {
 signStandingFeeModel,consentStandingFeeDelegation,
 renewStandingFeeObservationLease,revokeStandingFeeDelegation,
 inspectStandingFeeReadiness,STANDING_MODEL_CONFIRM,STANDING_OWNER_CONFIRM
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

test("issue154: owner status is read-only, exact-SHA-scoped and never an order authorization",async()=>{
 let reads=0;
 const db={query:async(sql:string)=>{
  reads++;
  if(sql.includes("FROM private.strata_api_fee_standing_models m"))
   return {rows:[{model_id:MODEL,valid_until:"2026-11-20T00:00:00Z"}]};
  if(sql.includes("FROM private.strata_api_fee_standing_delegations d"))
   return {rows:[{delegation_id:GRANT,grant_id:GRANT,valid_until:"2026-11-19T00:00:00Z",
    lease_expires_at:"2026-10-23T15:40:00Z"}]};
  throw Error("unexpected read");
 }};
 const current=await inspectStandingFeeReadiness(OWNER,{db:db as never,sha:()=>SHA});
 assert.equal(current.ok,true);
 assert.equal(current.modelId,MODEL);
 assert.equal(current.delegationId,GRANT);
 assert.equal(current.tradingAuthorized,false);
 assert.equal(reads,2);
 const missing=await inspectStandingFeeReadiness("invalid",{db:db as never,sha:()=>SHA});
 assert.equal(missing.ok,false);
 assert.equal(reads,2);
});
test("issue154: missing, ambiguous or unreadable technical model cannot be treated as approved",async()=>{
 for(const rows of [
  [] as Record<string,unknown>[],
  [{model_id:MODEL},{model_id:GRANT}]
 ]){
  const q=await inspectStandingFeeReadiness(OWNER,{
   db:{query:async()=>({rows})} as never,sha:()=>SHA});
  assert.equal(q.tradingAuthorized,false);
  assert.equal(q.delegationId,null);
  if(rows.length>1)assert.equal(q.ok,false);
 }
});

const currentOfficialMarket=()=>({
 ok:true,reason:"live_series_event_fee_metadata_verified_read_only",
 series:"KXBTC15M",exchangeIndex:2,feeType:"quadratic",feeMultiplier:"1",
 pdfProvenanceApproved:false,ownerPolicyApproved:false,
 commissioningApproved:false,tradingEnabled:false,
 marketTicker:"KXBTC15M-26OCT25T2000",eventTicker:"KXBTC15M-26OCT25T2000",
 metadataDigest:"b".repeat(64),liveVerifiedAt:new Date().toISOString(),
});

test("issue165: migrated owner may explicitly enroll a reviewed standing model after bootstrap expiry",async()=>{
 const calls:{sql:string;args:unknown[]}[]=[];
 let insertCount=0,commitCount=0;
 const client={query:async(sql:string,args:unknown[]=[])=>{
   calls.push({sql,args});
   if(sql.includes("SELECT a.id,p.policy_hash,g.grant_id"))return {rows:[{id:OWNER,policy_hash:"d".repeat(64),grant_id:GRANT}]};
   if(sql.includes("SELECT m.model_id,m.reviewer_admin_id,m.valid_until"))return {rows:[{model_id:MODEL,valid_until:"2026-11-20T00:00:00.000Z"}]};
   if(sql.includes("INSERT INTO private.strata_api_fee_standing_delegations")){insertCount++;return {rows:[{delegation_id:MODEL,valid_until:"2026-11-20T00:00:00.000Z"}]};}
   if(sql==="COMMIT")commitCount++;
   return {rows:[]};
 },release(){}};
 const db={connect:async()=>client};
 const r=await consentStandingFeeDelegation(OWNER,{
  modelId:MODEL,grantId:GRANT,confirmation:STANDING_OWNER_CONFIRM
 },{db:db as never,sha:()=>SHA,probe:async()=>currentOfficialMarket() as never});
 assert.equal(r.ok,true);
 assert.equal(r.tradingAuthorized,false);
 assert.equal(insertCount,1);
 assert.equal(commitCount,1);
 const sql=calls.find(q=>q.sql.includes("SELECT a.id,p.policy_hash,g.grant_id"))?.sql??"";
 for(const require of [
  "p.fee_source_url='strata-api-reviewed://kxbtc15m/'",
  "AND g.grant_id=$2::uuid AND g.revoked_at IS NULL",
  "con.confirmed_at<=g.expires_at","con.confirmed_at>=g.issued_at",
  "original.signed_at<=g.issued_at","issuer_role.role='ADMIN'",
  "issuer.email_confirmed_at IS NOT NULL","g.issuer_admin_id<>a.owner_user_id",
  "g.authorized_stages", "p.fee_policy_version=$3",
  "con.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'",
 ])
  assert.ok(sql.includes(require),"missing original signed-grant fence: "+require);
 assert.ok(!sql.includes("g.expires_at>now()"),"expiry must not strand already-migrated owner standing consent");
 assert.equal(calls.find(x=>x.sql.includes("SELECT a.id,p.policy_hash,g.grant_id"))?.args?.[1],GRANT);
});

test("issue165: no standing consent can be saved without a fresh official Kalshi metadata check",async()=>{
 let began=0;
 const db={connect:async()=>{began++;throw Error("transaction must not start")}};
 for(const probe of [
  async()=>{throw Error("provider unavailable");},
  async()=>({...currentOfficialMarket(),feeType:"nonquadratic"}),
  async()=>({...currentOfficialMarket(),liveVerifiedAt:"2020-01-01T00:00:00Z"}),
 ]) {
  const r=await consentStandingFeeDelegation(OWNER,{
   modelId:MODEL,grantId:GRANT,confirmation:STANDING_OWNER_CONFIRM
  },{db:db as never,sha:()=>SHA,probe:probe as never});
  assert.equal(r.ok,false);
  assert.equal(r.tradingAuthorized,false);
 }
 assert.equal(began,0);
});

test("issue165: no owner delegation if original grant, consent, policy, or standing model is missing",async()=>{
 let writes=0;
 const client={query:async(sql:string)=>{
   if(sql.includes("SELECT a.id,p.policy_hash,g.grant_id"))return {rows:[]};
   if(sql.includes("INSERT INTO private.strata_api_fee_standing_delegations"))writes++;
   return {rows:[]};
 },release(){}};
 const r=await consentStandingFeeDelegation(OWNER,{
  modelId:MODEL,grantId:GRANT,confirmation:STANDING_OWNER_CONFIRM
 },{db:{connect:async()=>client} as never,sha:()=>SHA,probe:async()=>currentOfficialMarket() as never});
 assert.equal(r.ok,false);
 assert.equal(writes,0);
});
