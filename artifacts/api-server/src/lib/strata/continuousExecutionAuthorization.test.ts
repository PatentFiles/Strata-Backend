import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTINUOUS_OWNER_CONFIRM, CONTINUOUS_ENTRY_AUTHORIZATION_SQL,
  enrollContinuousGrant, checkContinuousBootstrap,
  checkContinuousEligibility, renewContinuousTechnicalLease,
} from "./continuousExecutionAuthorization";
const owner="11111111-1111-4111-8111-111111111111";
const sha="a".repeat(40);
test("standing opt-in requires the specific authenticated owner confirmation",async()=>{
 const r=await enrollContinuousGrant(owner,{confirmation:"wrong"},{sha:()=>sha});
 assert.equal(r.ok,false);
 assert.equal(r.ordersSubmitted,false);
 assert.equal(typeof CONTINUOUS_OWNER_CONFIRM,"string");
});
test("bootstrap consent alone never grants an entry lease",async()=>{
 const db={query:async(sql:string)=>({rows:sql.includes("strata_continuous_execution_technical_lease")?[]:[{grant_id:"x"}]})};
 assert.equal(await checkContinuousBootstrap(db,owner,sha),true);
 assert.equal(await checkContinuousEligibility(db,owner,sha),false);
 assert.match(CONTINUOUS_ENTRY_AUTHORIZATION_SQL,/l\.expires_at>now\(\)/);
 assert.match(CONTINUOUS_ENTRY_AUTHORIZATION_SQL,/oa\.revoked_at IS NULL/);
});
test("stale or unauthenticated provider evidence cannot renew standing execution",async()=>{
 const proof={ownerId:owner,accountId:"acct",releaseSha:sha,policyHash:"b".repeat(64),
 observedAtMs:1000,cashMicros:"25000000",fencingToken:"2",
 authenticated:true,complete:true,unexplainedCashActivity:false,
 providerEvidence:{}};
 const stale=await renewContinuousTechnicalLease(proof,{now:()=>100000});
 assert.equal(stale.ok,false);
 const forged=await renewContinuousTechnicalLease({...proof,authenticated:false},{now:()=>1000});
 assert.equal(forged.ok,false);
 const incomplete=await renewContinuousTechnicalLease({...proof,complete:false},{now:()=>1000});
 assert.equal(incomplete.ok,false);
});
