import assert from "node:assert/strict";
import test from "node:test";
import { inspectOwnerFeeSourceReadiness } from "./operatorFeeAuthorizationReadiness";
const NOW=Date.parse("2026-10-16T15:00:00.000Z");
const owner="11111111-1111-4111-8111-111111111111";
const stranger="99999999-9999-4999-8999-999999999999";
const grantId="33333333-3333-4333-8333-333333333333";
const releaseId="44444444-4444-4444-8444-444444444444";
const approver="22222222-2222-4222-8222-222222222222";
const iso=(ms:number)=>new Date(ms).toISOString();
const candidate=async()=>({
  ok:true,reason:"operator_candidate_reviewed_only",releaseId,
  expiresAt:iso(NOW+600_000),provenance:"operator_attested" as const,
  approvedOfficialPdf:false as const,policyApproved:false as const,
  commissioningApproved:false as const,tradingAuthorized:false as const,
});
const market=async()=>({
  ok:true,reason:"live_series_event_fee_metadata_verified_read_only",
  series:"KXBTC15M" as const,exchangeIndex:2 as const,
  referenceDigest:"a".repeat(64),liveVerifiedAt:iso(NOW-100),
  marketTicker:"KXBTC15M-26OCT161045-45",
  eventTicker:"KXBTC15M-26OCT161045",
  feeType:"quadratic" as const,feeMultiplier:"1" as const,
  metadataDigest:"b".repeat(64),
  pdfProvenanceApproved:false as const,ownerPolicyApproved:false as const,
  commissioningApproved:false as const,tradingEnabled:false as const,
});
const grant=()=>({
  grant_id:grantId,owner_user_id:owner,release_id:releaseId,
  reviewed_pdf_sha256:"c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601",
  policy_version:"operator_attested_fee_source_v1",approved_by_admin_id:approver,
  policy_decision_sha256:"d".repeat(64),
  approver_is_current_admin:true,approver_independent:true,
  approved_at:iso(NOW-1000),expires_at:iso(NOW+300_000),revoked_at:null,
  authorized_stages:["STEP_6","STEP_9","STEP_11","ORDER_ENTRY"],
});
const consent=()=>({
  grant_id:grantId,owner_user_id:owner,release_id:releaseId,
  confirmed_at:iso(NOW-500),revoked_at:null,
  confirmation:"CONFIRM_OPERATOR_FEE_SOURCE_ONLY",
});
function db(options?:{grantRows?:Array<Record<string,unknown>>;
    consentRows?:Array<Record<string,unknown>>;accountRows?:Array<Record<string,unknown>>;
    throwOnGrants?:boolean}) {
  const reads:string[]=[];
  return {
    reads,
    query:async (sql:string,params?:unknown[])=>{
      reads.push(sql);
      // Owner identity is always sourced from authenticated route identity,
      // and must never be accepted from a query parameter.
      if(!params || params[0]===stranger) throw Error("foreign_owner");
      if(sql.includes("v13_production_account")) return {rows:options?.accountRows ?? [{id:"owned_account"}]};
      if(sql.includes("strata_fee_source_grants")) {
        if(options?.throwOnGrants) throw Error("store_unavailable");
        return {rows:options?.grantRows ?? [grant()]};
      }
      if(sql.includes("strata_fee_source_owner_consents")) return {rows:options?.consentRows ?? [consent()]};
      throw Error("unexpected_sql");
    },
  };
}
async function run(options?:Parameters<typeof db>[0],
  checks?:{candidate?:typeof candidate;market?:typeof market}) {
  const conn=db(options);
  const answer=await inspectOwnerFeeSourceReadiness(owner,conn,
    checks?.candidate ?? candidate,checks?.market ?? market,()=>NOW);
  assert.equal(answer.providerPdfVerified,false);
  assert.equal(answer.feePolicyApproved,false);
  assert.equal(answer.commissioningApproved,false);
  assert.equal(answer.tradingAuthorized,false);
  assert.equal(answer.ok,false,"diagnostic must never become approval");
  return {answer,reads:conn.reads};
}
test("returns non-authoritative eligible diagnostic only when complete",async()=>{
  const {answer,reads}=await run();
  assert.equal(answer.diagnosticEligible,true);
  assert.deepEqual(Object.values(answer.stageChecks),[true,true,true,true]);
  assert.equal(reads.filter(s=>/SELECT /i.test(s)).length,3);
  assert.equal(reads.filter(s=>/INSERT|UPDATE|DELETE/i.test(s)).length,0);
});
test("rejects missing, duplicate, foreign owner or revoked source grants",async()=>{
  assert.equal((await run({grantRows:[]})).answer.reason,"source_policy_grant_missing");
  assert.equal((await run({grantRows:[grant(),grant()]})).answer.reason,"multiple_active_source_grants");
  assert.equal((await run({grantRows:[{...grant(),owner_user_id:stranger}]})).answer.diagnosticEligible,false);
  assert.equal((await run({grantRows:[{...grant(),revoked_at:iso(NOW-1)}]})).answer.diagnosticEligible,false);
});
test("requires independent current administrator and fixed policy decision digest",async()=>{
  for (const changed of [
    {approver_is_current_admin:false},
    {approver_independent:false},
    {policy_decision_sha256:"not-a-digest"},
    {policy_decision_sha256:null},
    {approved_by_admin_id:owner},
  ]) {
    const {answer}=await run({grantRows:[{...grant(),...changed}]});
    assert.equal(answer.reason,"independent_source_policy_approval_unverified");
    assert.equal(answer.diagnosticEligible,false);
    assert.deepEqual(Object.values(answer.stageChecks),[false,false,false,false]);
  }
});
test("rejects absent, ambiguous, revoked, and foreign owner consent",async()=>{
  assert.equal((await run({consentRows:[]})).answer.reason,"owner_source_consent_missing_or_ambiguous");
  assert.equal((await run({consentRows:[consent(),consent()]})).answer.reason,"owner_source_consent_missing_or_ambiguous");
  assert.equal((await run({consentRows:[{...consent(),revoked_at:iso(NOW-1)}]})).answer.diagnosticEligible,false);
  assert.equal((await run({consentRows:[{...consent(),owner_user_id:stranger}]})).answer.diagnosticEligible,false);
});
test("does not contact public market if release/grant evidence missing",async()=>{
  let marketCalled=false;
  const badMarket=async()=>{marketCalled=true;return market();};
  const x=await run({grantRows:[]},{market:badMarket});
  assert.equal(x.answer.diagnosticEligible,false);
  assert.equal(marketCalled,false);
});
test("refuses missing account and ledger failure",async()=>{
  assert.equal((await run({accountRows:[]})).answer.reason,"owned_execution_account_missing_or_ambiguous");
  assert.equal((await run({throwOnGrants:true})).answer.reason,"private_fee_authorization_ledger_unavailable");
});
test("never accepts stale live market metadata or unsupported fee type",async()=>{
  const stale=async()=>({...await market(),liveVerifiedAt:iso(NOW-10_001)});
  const badType=async()=>({...await market(),feeMultiplier:"2" as "1"});
  assert.equal((await run(undefined,{market:stale})).answer.diagnosticEligible,false);
  assert.equal((await run(undefined,{market:badType})).answer.diagnosticEligible,false);
});
test("expired release or stage-limited grant cannot authorize orders",async()=>{
  const expired=async()=>({...await candidate(),expiresAt:iso(NOW-1)});
  assert.equal((await run(undefined,{candidate:expired})).answer.diagnosticEligible,false);
  const stageOnly=await run({grantRows:[{...grant(),authorized_stages:["STEP_6","STEP_9"]}]});
  assert.equal(stageOnly.answer.stageChecks.ORDER_ENTRY,false);
  assert.equal(stageOnly.answer.diagnosticEligible,false);
});
