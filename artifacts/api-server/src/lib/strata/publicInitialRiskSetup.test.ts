import test from "node:test";
import assert from "node:assert/strict";
import {parseInitialRiskConsent,REVIEW_INITIAL_RISK,APPROVE_INITIAL_RISK} from "./publicInitialRiskSetup";
const owner="11111111-1111-4111-8111-111111111111";
const body={confirmation:REVIEW_INITIAL_RISK,expectedOwnerId:owner,presetId:"strata-test-c52c53-20pct-v1",presetRevision:1,capitalBudgetCents:2500};
test("initial risk uses existing owner-selected preset and exact integer limits",()=>{
 const parsed=parseInitialRiskConsent(owner,body);
 assert.equal(parsed?.limits.maxEntryStakeCents,500);
 assert.equal(parsed?.limits.maxEntryAllInCents,625);
 assert.equal(parsed?.limits.maxDailyLossCents,1000);
 assert.equal(parsed?.limits.maxTotalLossCents,1500);
 assert.equal(parsed?.preview,true);
});
test("cross-owner, tampered limits, stale preset revision and insufficient stake are rejected",()=>{
 assert.equal(parseInitialRiskConsent("22222222-2222-4222-8222-222222222222",body),null);
 for(const changed of [{maxEntryStakeCents:100000},{presetRevision:2},{capitalBudgetCents:1},{capitalBudgetCents:2500.5},{confirmation:APPROVE_INITIAL_RISK},{presetId:"unknown"}])
  assert.equal(parseInitialRiskConsent(owner,{...body,...changed}),null);
 const approval=parseInitialRiskConsent(owner,{...body,confirmation:APPROVE_INITIAL_RISK,scopeDigest:"a".repeat(64)});
 assert.equal(approval?.preview,false);
});
