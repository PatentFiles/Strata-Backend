import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {verifyOwnerFeeSourceStage,parseOwnerFeeSource,
  encodeOwnerFeeSource} from "./ownerFeeSourceStage";
import type {OwnerFeeSourceReadiness} from "./operatorFeeAuthorizationReadiness";
const owner="11111111-1111-4111-8111-111111111111";
const grant="22222222-2222-4222-8222-222222222222";
const release="33333333-3333-4333-8333-333333333333";
const ticker="KXBTC15M-26OCT160100-00";
const now=Date.parse("2026-10-16T01:00:00Z");
const source=encodeOwnerFeeSource(grant,release)!;
function fixture(overrides:Partial<OwnerFeeSourceReadiness>={}):OwnerFeeSourceReadiness{
  return {
    ok:false,reason:"operator_source_read_only_prerequisites_present",
    diagnosticEligible:true,sourceKind:"operator_attested_not_provider",
    providerPdfVerified:false,feePolicyApproved:false,commissioningApproved:false,
    tradingAuthorized:false,
    stageChecks:{STEP_6:true,STEP_9:true,STEP_11:true,ORDER_ENTRY:true},
    candidateExpiresAt:"2026-10-16T01:04:00Z",
    grantExpiresAt:"2026-10-16T01:04:00Z",
    grantId:grant,releaseId:release,marketTicker:ticker,
    metadataFingerprint:"a".repeat(64),
    metadataVerifiedAt:new Date(now-500).toISOString(),...overrides,
  };
}
const check=(row:OwnerFeeSourceReadiness,at=now,market=ticker,expected=source)=>
  verifyOwnerFeeSourceStage(owner,"ORDER_ENTRY",expected,market,
    {readiness:async()=>row,now:()=>at});
describe("owner fee source identity and fail-closed stage gates",()=>{
  it("success binds precise source and market and grants no trading permission",async()=>{
    const result=await check(fixture());
    assert.equal(result.ok,true);
    if(result.ok){
      assert.equal(result.identity.sourceUrl,source);
      assert.equal(result.identity.sourceKind,"operator_attested_not_provider");
      assert.equal(result.identity.marketTicker,ticker);
    }
  });
  it("rejects arbitrary identity",()=>{
    assert.equal(parseOwnerFeeSource("https://kalshi.com/docs/kalshi-fee-schedule.pdf"),null);
    assert.equal(encodeOwnerFeeSource("1",release),null);
    assert.equal(parseOwnerFeeSource(source)?.grantId,grant);
  });
  const cases:readonly [string,OwnerFeeSourceReadiness,number,string,string][]=[
    ["expired grant",fixture({diagnosticEligible:false,reason:"grant_expired"}),now,ticker,source],
    ["revoked admin policy",fixture({diagnosticEligible:false,reason:"grant_revoked"}),now,ticker,source],
    ["revoked owner consent",fixture({diagnosticEligible:false,reason:"consent_revoked"}),now,ticker,source],
    ["duplicate grant",fixture({diagnosticEligible:false,reason:"multiple_active_source_grants"}),now,ticker,source],
    ["future metadata",fixture({metadataVerifiedAt:new Date(now+100).toISOString()}),now,ticker,source],
    ["stale metadata",fixture({metadataVerifiedAt:new Date(now-10_001).toISOString()}),now,ticker,source],
    ["market change",fixture(),now,"KXBTC15M-26OCT160115-00",source],
    ["source swap",fixture(),now,ticker,encodeOwnerFeeSource(owner,release)!],
    ["missing market",fixture(),now,"",source],
    ["unexpected fee override",fixture({diagnosticEligible:false,reason:"live_market_fee_evidence_unverified"}),now,ticker,source],
  ];
  for(const [name,row,at,market,expected] of cases)
    it(name+" denies",async()=>assert.equal((await check(row,at,market,expected)).ok,false));
  it("restart does not prolong source grant",async()=>{
    assert.equal((await check(fixture())).ok,true);
    assert.equal((await check(fixture({diagnosticEligible:false,reason:"candidate_expired"}),
      now+10*60_000)).ok,false);
  });
  it("owner mismatch is never masked by proof for another owner",async()=>{
    const result=await verifyOwnerFeeSourceStage("44444444-4444-4444-8444-444444444444",
      "STEP_6",undefined,undefined,{
      readiness:async()=>fixture({diagnosticEligible:false,reason:"owner_identity_mismatch"}),
      now:()=>now,
    });
    assert.equal(result.ok,false);
  });
});
