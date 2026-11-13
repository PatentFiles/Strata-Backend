import test from "node:test";
import assert from "node:assert/strict";
import {
 issueOwnerV3FeeAuthority,verifyOwnerV3FeeAuthority,revokeOwnerV3FeeAuthority,encodeV3FeeSource,
 parseV3FeeSource,V3_FEE_GRANT_CONFIRM,V3_FEE_GRANT_REVOKE_CONFIRM,V3_FEE_FORMULA_VERSION,
} from "./ownerFeeV3Authority";

const OWNER="11111111-1111-4111-8111-111111111111";
const ATTEST="22222222-2222-4222-8222-222222222222";
const GRANT="33333333-3333-4333-8333-333333333333";
const SHA="a".repeat(40),HASH="b".repeat(64);
const TICKER="KXBTC15M-26OCT231915";
const base={confirmation:V3_FEE_GRANT_CONFIRM,evidenceAttestationId:ATTEST,expectedDeployedSha:SHA};
const verified=(stage:"STEP_9"|"STEP_11"|"ORDER_ENTRY"="STEP_9")=>({
 ok:true,reason:"provider_monetary_fee_schedule_and_market_verified",
 stage,marketTicker:TICKER,sourceDigest:HASH,verifiedAt:new Date().toISOString(),
 monetaryFeeAuthorized:true,policyApproved:false,tradingAuthorized:false,
});
function issueDb(changed:Record<string,unknown>={},audit:string[]=[]){
 return {connect:async()=>({
  query:async(sql:string,args:unknown[]=[]):Promise<{rows:Record<string,unknown>[]}>=>{
   audit.push(sql);
   if(sql.includes("SELECT a.id,a.commissioned"))return {rows:[{
     id:"strata-account-owner",commissioned:true,kill_switch:true,
     cash_precision_verified:true,...changed,
   }]};
   if(sql.includes("FROM private.kalshi_account_worker_lease"))return {rows:[{
     lease_state:"killed",arm_requested:false,account_kill:true,...changed,
   }]};
   if(sql.includes("FROM private.strata_owner_fee_evidence_v3"))return {rows:[{
     release_commit_sha:SHA,source_digest:HASH,market_ticker:TICKER,
     expires_at:new Date(Date.now()+30*60_000).toISOString(),...changed,
   }]};
   if(sql.includes("SELECT authority_id FROM private.strata_owner_fee_authority_v3"))
      return {rows:changed.duplicate===true?[{authority_id:GRANT}]:[]};
   if(sql.includes("INSERT INTO private.strata_owner_fee_authority_v3"))
      return {rows:[{authority_id:GRANT,expires_at:new Date(Date.now()+10*60_000).toISOString()}]};
   return {rows:[]};
  },release(){},
 })};
}
test("V3 is disabled by default; cannot invent approval from a client flag",async()=>{
 let called=false;
 const x=await issueOwnerV3FeeAuthority(OWNER,base,{
   enabled:()=>false,check:async()=>{called=true;return verified() as never;},
   sha:()=>SHA,
 });
 assert.equal(x.ok,false);
 assert.equal(x.reason,"v3_authority_feature_disabled");
 assert.equal(called,false);
 assert.equal(x.tradingAuthorized,false);
});
test("AAL2 owner confirmation and EXACT SHA required prior to DB or provider read",async()=>{
 for(const owner of ["invalid",OWNER]){
  const payload=owner==="invalid"?base:{...base,expectedDeployedSha:"f".repeat(40)};
  const x=await issueOwnerV3FeeAuthority(owner,payload,{enabled:()=>true,sha:()=>SHA});
  assert.equal(x.ok,false);
 }
 const bad=await issueOwnerV3FeeAuthority(OWNER,{...base,confirmation:"fake"},{enabled:()=>true,sha:()=>SHA});
 assert.equal(bad.ok,false);
});
test("no reviewed V2 grant or fee model silently promoted to V3 on rate-source failure",async()=>{
 const audit:string[]=[];
 const result=await issueOwnerV3FeeAuthority(OWNER,base,{
   enabled:()=>true,sha:()=>SHA,db:issueDb({},audit) as never,
   check:async()=>({...verified(),ok:false,monetaryFeeAuthorized:false}) as never,
 });
 assert.equal(result.ok,false);assert.equal(result.reason,"v3_genuine_current_monetary_fee_evidence_required");
 assert.deepEqual(audit,[]);
});
test("genuine official fee, scoped stopped owner, matching attestation: creates only V3 grant",async()=>{
 const audit:string[]=[];
 const x=await issueOwnerV3FeeAuthority(OWNER,base,{
   enabled:()=>true,sha:()=>SHA,db:issueDb({},audit) as never,
   check:async()=>verified() as never,
 });
 assert.equal(x.ok,true,JSON.stringify(x));
 if(!x.ok)return;
 assert.equal(x.grantIssued,true);assert.equal(x.policyMigrated,false);
 assert.equal(x.tradingAuthorized,false);assert.equal(x.ordersSubmitted,false);
 assert.equal(audit.filter(s=>s.includes("INSERT INTO private.strata_owner_fee_authority_v3")).length,1);
 assert.equal(audit.some(s=>/UPDATE public\.v13_production_account/.test(s)),false);
 assert.equal(audit.some(s=>/private\.strata_api_fee_source_grants/.test(s)),false);
 assert.equal(audit.at(-1),"COMMIT");
});
test("cannot issue when receipt changed, worker active, or duplicate grant",async()=>{
 for(const [alter,reason] of [
   [{market_ticker:"KXBTC15M-OTHER"},"v3_issuer_source_digest_or_sha_changed"],
   [{source_digest:"f".repeat(64)},"v3_issuer_source_digest_or_sha_changed"],
   [{lease_state:"owned"},"v3_worker_lease_or_arm_not_stopped"],
   [{duplicate:true},"v3_consent_already_used_for_authority"],
   [{kill_switch:false},"v3_safe_commissioned_stop_required"],
 ] as const){
  const a:string[]=[];
  const x=await issueOwnerV3FeeAuthority(OWNER,base,{enabled:()=>true,sha:()=>SHA,
    db:issueDb(alter as Record<string,unknown>,a) as never,
    check:async()=>verified() as never});
  assert.equal(x.ok,false,JSON.stringify(x));
  assert.equal(x.reason,reason);
  assert.equal(a.some(s=>s.includes("INSERT INTO private.strata_owner_fee_authority_v3")),false);
 }
});
test("source URLs encode only UUIDs; V2 and fake grant URLs cannot be confused",()=>{
 const s=encodeV3FeeSource(GRANT);
 assert.equal(s,"strata-owner-fee-v3://kxbtc15m/"+GRANT);
 assert.equal(parseV3FeeSource(s!),GRANT);
 assert.equal(parseV3FeeSource("strata-api-reviewed://kxbtc15m/"+GRANT),null);
 assert.equal(parseV3FeeSource("strata-owner-fee-v3://kxbtc15m/fake"),null);
 assert.equal(V3_FEE_FORMULA_VERSION,"standard-quadratic-0.07-v1");
});
test("V3 verifier rejects missing/expired grant BEFORE costly provider read",async()=>{
 let calls=0;
 const x=await verifyOwnerV3FeeAuthority(OWNER,"STEP_9",encodeV3FeeSource(GRANT)!,undefined,{
    enabled:()=>true,sha:()=>SHA,
    db:{connect:async()=>({query:async()=>({rows:[]}),release(){}})} as never,
    check:async()=>{calls++;return verified() as never;},
 });
 assert.equal(x.ok,false);assert.equal(calls,0);
});
test("V3 verifier checks owner, immutable receipt digest, current provider and exact order market",async()=>{
 const d={connect:async()=>({query:async()=>({rows:[{
   authority_id:GRANT,source_digest:HASH,official_source_digest:HASH,
   consent_digest:HASH,consent_sha:SHA,release_commit_sha:SHA,
   consent_market:TICKER,
 }]}),release(){}})};
 for(const [stage,digest,ticker,allow] of [
  ["ORDER_ENTRY",HASH,TICKER,true],
  ["ORDER_ENTRY","f".repeat(64),TICKER,false],
  ["ORDER_ENTRY",HASH,"KXBTC15M-WRONG",false],
 ] as const){
  const x=await verifyOwnerV3FeeAuthority(OWNER,stage,
   encodeV3FeeSource(GRANT)!,ticker,{db:d as never,sha:()=>SHA,enabled:()=>true,
   check:async()=>({...verified(stage),sourceDigest:digest}) as never});
  assert.equal(x.ok,allow,JSON.stringify(x));
  if(x.ok)assert.equal(x.identity.feePolicyVersion,"strata_owner_official_monetary_fee_v3");
 }
});

test("owner explicitly revokes V3 authority transactionally and writes immutable audit",async()=>{
 const statements:string[]=[];
 const db={connect:async()=>({query:async(sql:string)=>{
   statements.push(sql);
   if(sql.includes("SELECT g.authority_id,g.execution_account_id"))return {rows:[{
     authority_id:GRANT,execution_account_id:"strata-account-test",
   }]};
   if(sql.includes("UPDATE private.strata_owner_fee_authority_v3"))return {rows:[{authority_id:GRANT}]};
   return {rows:[]};
 },release(){}})};
 const x=await revokeOwnerV3FeeAuthority(OWNER,{
   authorityId:GRANT,confirmation:V3_FEE_GRANT_REVOKE_CONFIRM,
 },{db:db as never,enabled:()=>false});
 assert.equal(x.ok,true,JSON.stringify(x));
 assert.equal(x.revoked,true);
 assert.equal(x.ordersSubmitted,false);
 assert.equal(x.tradingAuthorized,false);
 assert.ok(statements.some(s=>s.includes("UPDATE private.strata_owner_fee_authority_v3")));
 assert.ok(statements.some(s=>s.includes("OWNER_V3_FEE_AUTHORITY_REVOKED")));
 assert.equal(statements.at(-1),"COMMIT");
});
test("V3 grant cannot be revoked without authenticated owner confirmation",async()=>{
 const x=await revokeOwnerV3FeeAuthority(OWNER,{authorityId:GRANT,confirmation:"not owner"});
 assert.equal(x.ok,false);
 assert.equal(x.tradingAuthorized,false);
});
