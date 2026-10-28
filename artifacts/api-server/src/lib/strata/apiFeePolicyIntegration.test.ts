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
 const sql=policy.split("const APPROVE_API_SQL = `")[1]?.split("`;")[0];
 assert.ok(sql,"atomic API policy SQL must exist");
 assert.match(sql,/g\.policy_version=\$16 AND \$16='strata_api_fee_source_signed_review_v2'/);
 assert.match(sql,/r1\.reviewer_user_id=g\.issuer_admin_id/);
 assert.match(sql,/r1\.reviewer_user_id<>g\.owner_user_id/);
 assert.match(sql,/c\.revoked_at IS NULL/);
 assert.match(sql,/g\.issuer_admin_id<>g\.owner_user_id/);
 assert.match(sql,/g\.authorized_stages @> ARRAY\['STEP_9'\]/);
 assert.match(sql,/rx\.reviewer_user_id=g\.issuer_admin_id/);
 assert.match(sql,/r1\.signed_at<=g\.issued_at/);
 assert.doesNotMatch(sql,/strata_api_fee_source_signed_review_v1|r2\.reviewer_user_id|r1\.reviewer_user_id<>g\.issuer_admin_id/);
});
test("Step 11 checks fresh API source and owner consent inside commissioning SQL",()=>{
 const owner=read("personalAccountActivation.ts");
 assert.match(owner,/verifyReviewedApiFeeSourceStage\(input\.ownerUserId,"STEP_11",policySource\)/);
 assert.match(owner,/apiGrantId=checked\.identity\.grantId/);
 assert.match(owner,/private\.strata_api_fee_owner_consents/);
 assert.match(owner,/g\.authorized_stages @> ARRAY\['STEP_11'\]/);
 assert.match(owner,/AND \(\$7::uuid IS NULL OR EXISTS \(/);
 const sql=owner.split("const COMMISSION_API_SQL = `")[1]?.split("`;")[0];
 assert.ok(sql);
 assert.match(sql,/p\.fee_policy_version='strata_api_fee_source_signed_review_v2'/);
 assert.match(sql,/r1\.reviewer_user_id=g\.issuer_admin_id/);
 assert.match(sql,/g\.issuer_admin_id<>g\.owner_user_id/);
 assert.match(sql,/g\.authorized_stages @> ARRAY\['STEP_11'\]/);
 assert.match(sql,/g\.fee_model_version='kalshi_quadratic_007_whole_cent_conservative_reference_v1'/);
 assert.match(sql,/c\.revoked_at IS NULL/);
 assert.match(sql,/rx\.reviewer_user_id=g\.issuer_admin_id/);
 assert.match(sql,/r1\.signed_at<=g\.issued_at/);
 assert.doesNotMatch(sql,/strata_api_fee_source_signed_review_v1|r2\.reviewer_user_id|r1\.reviewer_user_id<>g\.issuer_admin_id/);
});
test("worker rechecks reviewed source for every exact-market read and every final order POST",()=>{
 const worker=read("personalExecutionSupervisor.ts");
 const fence=read("guardedReviewedApiFeeWire.ts");
 assert.match(worker,/verifyReviewedApiFeeSourceStage\(input\.userId,"ORDER_ENTRY",/);
 assert.match(worker,/sourceUrl,market\)/);
  assert.ok(worker.includes("createGuardedReviewedApiFeeFetch(input.userId,input.accountId,sourceUrl,personalProductionFetch,policyHash,fingerprint,claimed.fencingToken,holderId,{borrowTransaction:()=>finalLedger?.currentTransaction()??null})"),"reviewed fee transport must borrow the active final-ledger transaction to avoid an account-lock deadlock");
 assert.match(fence,/FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL/);
 assert.match(fence,/live\.manual_kill_switch=false/);
 assert.match(fence,/c\.revoked_at IS NULL/);
 assert.match(fence,/order\.reduce_only!==true && order\.reduce_only!==false/);
 assert.match(fence,/api_fee_source_new_entry_blocked_pending_exit_validation/);
 assert.match(fence,/private\.strata_owner_sha_approvals/);
 assert.match(fence,/private\.strata_protective_exit_release/);
 assert.match(fence,/a\.blocked_reason IS NULL/);
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

test("signed API fee model is rechecked at Step 9, Step 11 and the final order fence without PDF dependency",()=>{
 const owner=read("personalAccountActivation.ts");
 const fence=read("guardedReviewedApiFeeWire.ts");
 const api9=owner.split("if(apiRequested){")[1]?.split("}else if(altRequested)")[0] ?? "";
 const api11=owner.split("if(apiIdentity){")[1]?.split("}else if(operatorIdentity)")[0] ?? "";
 assert.match(api9,/verifyReviewedApiFeeSourceStage/);
 assert.match(api11,/verifyReviewedApiFeeSourceStage/);
 assert.doesNotMatch(api9,/verifyMonetaryFeeContract/);
 assert.doesNotMatch(api11,/verifyMonetaryFeeContract/);
 // The legacy owner-verified/standing official PDF policies still require
 // the original independent official monetary fee verifier.
 assert.match(owner,/input\.verifyMonetary\?\?verifyMonetaryFeeContract/);
 assert.match(fence,/verifyReviewedApiFeeSourceStage/);
 assert.match(fence,/checked\.identity\.feePolicyVersion/);
 assert.match(fence,/checked\.identity\.formulaVersion/);
 assert.match(fence,/checked\.identity\.digest/);
 assert.match(fence,/order\.reduce_only!==true && order\.reduce_only!==false/);
 assert.match(fence,/api_fee_source_new_entry_blocked_pending_exit_validation/);
 assert.match(fence,/private\.strata_owner_sha_approvals/);
 assert.match(fence,/private\.strata_protective_exit_release/);
 assert.match(fence,/a\.blocked_reason IS NULL/);
 assert.match(fence,/live\.manual_kill_switch=false/);
});
