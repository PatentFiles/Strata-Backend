import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
function read(relative:string):string {
 const a=join(process.cwd(),"src/lib/strata",relative);
 const b=join(process.cwd(),"artifacts/api-server/src/lib/strata",relative);
 return readFileSync(existsSync(a)?a:b,"utf8");
}
test("Step 9 owner approval and SQL bind the signed API grant, never a supplied PDF hash",()=>{
 const policy=read("personalPolicyApproval.ts");
 const owner=read("personalAccountActivation.ts");
 assert.match(owner,/apiRequested=request\.feeSourceKind==="kalshi_trade_api_fee_policy_v1"/);
 assert.match(owner,/verifyReviewedApiFeeSourceStage\(input\.ownerUserId,"STEP_9"\)/);
 assert.match(policy,/parseReviewedApiSource\(input\.policy\.feeSourceUrl/);
 assert.match(policy,/AND \(\$25::uuid IS NULL OR EXISTS \(/);
 assert.match(policy,/g\.authorized_stages @> ARRAY\['STEP_9'\]/);
 assert.match(policy,/private\.strata_api_fee_rate_reviews r2/);
});
test("Step 11 checks fresh API source and owner consent inside commissioning SQL",()=>{
 const owner=read("personalAccountActivation.ts");
 assert.match(owner,/verifyReviewedApiFeeSourceStage\(input\.ownerUserId,"STEP_11",policySource\)/);
 assert.match(owner,/apiGrantId=checked\.identity\.grantId/);
 assert.match(owner,/private\.strata_api_fee_owner_consents/);
 assert.match(owner,/g\.authorized_stages @> ARRAY\['STEP_11'\]/);
 assert.match(owner,/AND \(\$7::uuid IS NULL OR EXISTS \(/);
});
test("worker rechecks reviewed source for every exact-market read and every final order POST",()=>{
 const worker=read("personalExecutionSupervisor.ts");
 const fence=read("guardedReviewedApiFeeWire.ts");
 assert.match(worker,/verifyReviewedApiFeeSourceStage\(input\.userId,"ORDER_ENTRY",/);
 assert.match(worker,/sourceUrl,market\)/);
 assert.match(worker,/createGuardedReviewedApiFeeFetch\(input\.userId,sourceUrl,personalProductionFetch\)/);
 assert.match(fence,/if\(order\.reduce_only!==true\)/);
 assert.match(fence,/verifyReviewedApiFeeSourceStage/);
 assert.match(fence,/client\.query\("BEGIN"\)/);
 assert.match(fence,/await transport\(request,init\)/);
});
test("migration creates empty service-only records; no client grants, approvals or execution toggles",()=>{
 const paths=[
  join(process.cwd(),"../../lib/db/drizzle/0030_strata_api_fee_rate_source_v1.sql"),
  join(process.cwd(),"lib/db/drizzle/0030_strata_api_fee_rate_source_v1.sql"),
 ];
 const found=paths.find(existsSync);
 assert.ok(found,"migration exists");
 const sql=readFileSync(found!,"utf8");
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/g);
 assert.match(sql,/REVOKE ALL ON TABLE/);
 assert.doesNotMatch(sql,/INSERT INTO|UPDATE v13_production_account|live_execution_enabled\s*=\s*true/);
});
