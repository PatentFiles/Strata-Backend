import test from "node:test";
import assert from "node:assert/strict";
import {inspectOwnerAccountOnboardingReadiness,OWNER_ONBOARDING_READ_SQL} from "./ownerAccountOnboardingReadiness";
const owner="11111111-1111-4111-8111-111111111111";
const roles=["account_setup_execution","provisioning","restricted_execution","verification"];
const base={
 email_verified:true,account_exists:true,commissioned:true,kill_switch:true,
 blocked_reason:"awaiting_account_commissioning",policy_state:"APPROVED",
 configured_stake_cents:500,active_roles:roles,funding_recorded:true,
};
function read(rows:Record<string,unknown>[]){
 let calls=0;let lastQuery="";
 const db={async query(sql:string,params?:unknown[]){
  calls++;lastQuery=sql;
  assert.deepEqual(params,[owner]);
  return {rows};
 }};
 return {run:()=>inspectOwnerAccountOnboardingReadiness(owner,{db}),
  count:()=>calls,query:()=>lastQuery};
}
test("a commissioned account with provisional hold gets migration guidance, not duplicate commissioning",async()=>{
 const q=read([base]);const r=await q.run();
 assert.equal(r.ok,true);assert.equal(r.phase,"commissioned_provisional_hold");
 assert.equal(r.credentials.allFourRecorded,true);
 assert.equal(r.funding.historicalOrCompletedTransferRecorded,true);
 assert.equal(r.policy.configuredStakeCents,500);
 assert.equal(r.account.killSwitchOn,true);
 assert.equal(r.tradingAuthorized,false);assert.equal(r.ordersSubmitted,false);
 assert.equal(r.signedKalshiEvidenceRefreshed,false);
 assert.ok(r.nextActions.includes("owner_approved_versioned_migration_repairs_provisional_hold_after_signed_flatness"));
 assert.equal(q.count(),1);
 assert.match(q.query(),/WHERE u.id=\$1::uuid/);
});
test("missing funding AND policy remain separate owner setup blockers",async()=>{
 const q=read([{...base,commissioned:false,policy_state:null,configured_stake_cents:null,
  funding_recorded:false}]);const r=await q.run();
 assert.equal(r.phase,"funding_or_policy_incomplete");
 assert.ok(r.nextActions.includes("verify_owned_index2_funding_without_repeating_transfer"));
 assert.ok(r.nextActions.includes("review_and_approve_owner_policy_and_stake"));
 assert.equal(r.account.commissioned,false);
 assert.equal(r.tradingAuthorized,false);
});
test("complete funding and policy with commissioning false directs owner Step 11",async()=>{
 const r=await read([{...base,commissioned:false}]).run();
 assert.equal(r.phase,"commissioning_required");
 assert.ok(r.nextActions.includes("owner_mfa_commission_own_account"));
});
test("non-provisional freeze cannot be misreported as eligible",async()=>{
 const r=await read([{...base,blocked_reason:"production_uncertain_order"}]).run();
 assert.equal(r.phase,"commissioned_other_risk_freeze");
 assert.ok(r.nextActions.includes("engineering_reconcile_non_provisional_financial_freeze"));
});
test("duplicate active role never appears complete; unknown and malformed identities fail closed",async()=>{
 const r=await read([{...base,active_roles:[...roles,"verification"]}]).run();
 assert.equal(r.phase,"credentials_incomplete");
 assert.equal(r.credentials.allFourRecorded,false);
 assert.equal((await read([base,base]).run()).ok,false);
 assert.equal((await read([]).run()).ok,false);
 assert.equal((await inspectOwnerAccountOnboardingReadiness("bad-uuid",{db:{
  async query(){throw Error("should not run");}
 }})).ok,false);
});
test("SQL reads the owner's exact execution pair and credential metadata but no secrets or mutating verbs",()=>{
 assert.match(OWNER_ONBOARDING_READ_SQL,/WHERE u.id=\$1::uuid LIMIT 2/);
 assert.match(OWNER_ONBOARDING_READ_SQL,/subaccount=1 AND a.exchange_index=2/);
 assert.match(OWNER_ONBOARDING_READ_SQL,/c.revoked_at IS NULL/);
 assert.match(OWNER_ONBOARDING_READ_SQL,/c.vault_secret_id IS NOT NULL/);
 assert.doesNotMatch(OWNER_ONBOARDING_READ_SQL,/SELECT\s+(?:\*|c\.vault_secret_id)/i);
 assert.doesNotMatch(OWNER_ONBOARDING_READ_SQL,/\b(?:UPDATE|INSERT|DELETE|CALL)\b/i);
});
