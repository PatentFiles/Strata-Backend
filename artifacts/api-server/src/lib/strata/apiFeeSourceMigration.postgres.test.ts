import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pool} from "@workspace/db";
import {CONTINUE_SQL} from "./apiFeeStandingDelegation";
test("the exact fee stage SQL runs on transactional isolated CI PostgreSQL and revocation fails closed",async()=>{
 const urlText=process.env.DATABASE_URL;
 assert.equal(process.env.CI,"true");
 assert.equal(process.env.NODE_ENV,"test");
 assert.ok(urlText);
 const url=new URL(urlText);
 assert.ok(["localhost","127.0.0.1"].includes(url.hostname));
 assert.equal(url.pathname,"/v13_ci");
 const db=await pool.connect();
 const privateSchema="strata_fee_sql_test_private";
 const authSchema="strata_fee_sql_test_auth";
 const replaceSchemas=(value:string)=>value
    .split("private.").join(privateSchema+".")
    .split("auth.").join(authSchema+".");
 const owner="11111111-1111-4111-8111-111111111111";
 const admin="22222222-2222-4222-8222-222222222222";
 const gid="55555555-5555-4555-8555-555555555555";
 const digest="a".repeat(64);
 const model="kalshi_quadratic_007_whole_cent_conservative_reference_v1";
 try{
  await db.query("BEGIN");
  await db.query("CREATE SCHEMA "+privateSchema+"; CREATE SCHEMA "+authSchema);
  await db.query("CREATE TABLE "+authSchema+".users (id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz)");
  await db.query("CREATE TABLE "+privateSchema+".role_assignments (email text,role text)");
  await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$");
  const migration=readFileSync("../../lib/db/drizzle/0030_strata_api_fee_rate_source_v1.sql","utf8")
    .replace("BEGIN;","").replace("COMMIT;","");
  await db.query(replaceSchemas(migration));
  for(const name of ["strata_api_fee_rate_reviews","strata_api_fee_source_grants","strata_api_fee_owner_consents"]){
    const initial=await db.query("SELECT count(*)::int AS n FROM "+privateSchema+"."+name);
    assert.equal(initial.rows[0]?.n,0);
  }
  const tick=String.fromCharCode(96);
  const source=readFileSync("src/lib/strata/apiFeeSourceStage.ts","utf8");
  const exact=source.split("export const READ_API_FEE_STAGE_SQL="+tick)[1]?.split(tick+";")[0];
  assert.ok(exact);
  const sql=replaceSchemas(exact);
  await db.query("INSERT INTO "+authSchema+".users VALUES ($1,'owner@example.invalid',now()),($2,'technical@example.invalid',now())",[owner,admin]);
  await db.query("INSERT INTO "+privateSchema+".role_assignments VALUES ('technical@example.invalid','ADMIN')");
  await db.query("INSERT INTO "+privateSchema+".strata_api_fee_rate_reviews (owner_user_id,reviewer_user_id,rate_decision_digest,fee_model_version,confirmation,review_note,verified_rate_source,signed_at,expires_at) VALUES ($1,$2,$3,$4,'I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1',$5,'kalshi_official_fee_publication',now()-interval '1 minute',now()+interval '30 minutes')",[owner,admin,digest,model,"The technical administrator independently verified Kalshi's current fee formula, coefficient, rounding, effective publication date and KXBTC15M market exceptions."]);
  await db.query("INSERT INTO "+privateSchema+".strata_api_fee_source_grants (grant_id,owner_user_id,issuer_admin_id,rate_decision_digest,fee_model_version,policy_version,authorized_stages,confirmation,issued_at,expires_at) VALUES ($1,$2,$3,$4,$5,'strata_api_fee_source_signed_review_v2',ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],'ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1',now()-interval '30 seconds',now()+interval '10 minutes')",[gid,owner,admin,digest,model]);
  await db.query("INSERT INTO "+privateSchema+".strata_api_fee_owner_consents (grant_id,owner_user_id,confirmation,confirmed_at) VALUES ($1,$2,'CONFIRM_REVIEWED_API_FEE_SOURCE_V1',now()-interval '15 seconds')",[gid,owner]);
  const args=[owner,null,"STEP_9",digest,model];
  const valid=await db.query(sql,args);
  assert.equal(valid.rows.length,1);
  assert.equal(valid.rows[0]?.first_reviewer,admin);
  assert.equal(valid.rows[0]?.consent_owner,owner);

  // Execute the REAL 0034 migration under isolated schema names and exercise
  // the ACTUAL standing observation UPDATE, not a hand-copied SQL approximation.
  const scopedPublic="strata_fee_sql_test_public";
  await db.query("CREATE SCHEMA "+scopedPublic);
  await db.query("CREATE TABLE "+scopedPublic+".v13_production_account (id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int,policy_id text)");
  await db.query("CREATE TABLE "+scopedPublic+".v13_live_money_policy (id text PRIMARY KEY,execution_account_id text,state text,policy_hash text,fee_source_url text)");
  const standingMigration=readFileSync("../../lib/db/drizzle/0034_strata_standing_api_fee_delegation.sql","utf8")
    .replace("BEGIN;","").replace("COMMIT;","");
  await db.query(replaceSchemas(standingMigration));
  // Staged migration is applied ONLY inside this disposable CI transaction.
  const lifetimeMigration=readFileSync("../../sql/strata_standing_fee_until_revoked.sql","utf8")
    .replace("BEGIN;","").replace("COMMIT;","");
  await db.query(replaceSchemas(lifetimeMigration));
  const modelId="77777777-7777-4777-8777-777777777777";
  const delegationId="88888888-8888-4888-8888-888888888888";
  const sha="b".repeat(40), policyHash="f".repeat(64);
  await db.query("INSERT INTO "+scopedPublic+".v13_production_account VALUES ('cash-account',$1,1,2,'policy')",[owner]);
  await db.query("INSERT INTO "+scopedPublic+".v13_live_money_policy VALUES ('policy','cash-account','APPROVED',$1,$2)",
    [policyHash,"strata-api-reviewed://kxbtc15m/"+gid]);
  await db.query("INSERT INTO "+privateSchema+".strata_api_fee_standing_models (model_id,reviewer_admin_id,rate_decision_digest,fee_model_version,scope,release_commit_sha,evidence_url,evidence_sha256,evidence_note,signed_at,valid_until) VALUES($1,$2,$3,$4,'KXBTC15M:INDEX2',$5,'https://kalshi.com/docs/kalshi-fee-schedule.pdf',$6,$7,now(),now()+interval '1 day')",
    [modelId,admin,digest,model,sha,"c".repeat(64),"Independently confirmed immutable provider publication, date, coefficient, rounding, event and series overrides, and supported rate vectors."]);
  await db.query("INSERT INTO "+privateSchema+".strata_api_fee_standing_delegations (delegation_id,owner_user_id,model_id,grant_id,policy_hash,release_commit_sha,confirmation,granted_at,valid_until,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,'I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1',now(),now()+interval '1 day',now()+interval '10 minutes')",
    [delegationId,owner,modelId,gid,policyHash,sha]);
  const continuation=replaceSchemas(CONTINUE_SQL).split("public.").join(scopedPublic+".");
  const renewArgs=[owner,gid,sha,"ORDER_ENTRY","strata_api_fee_source_signed_review_v2",model,digest];
  assert.equal((await db.query(continuation,renewArgs)).rows.length,1,
    "fresh official fee observation must be able to renew the bounded standing technical lease");
  // Opted-in V2 reviewer and owner scope: no calendar expiry, but provider
  // lease is still a short independent technical observation and revoke-able.
  await db.query("UPDATE "+privateSchema+".strata_api_fee_standing_models SET standing_until_revoked=true,valid_until='infinity'::timestamptz WHERE model_id=$1",[modelId]);
  await db.query("UPDATE "+privateSchema+".strata_api_fee_standing_delegations SET standing_until_revoked=true,confirmation='I_AUTHORIZE_MY_ACCOUNT_FOR_CURRENT_REVIEWED_KXBTC15M_FEE_MODEL_UNTIL_REVOKED_V2',valid_until='infinity'::timestamptz WHERE delegation_id=$1",[delegationId]);
  assert.equal((await db.query(continuation,renewArgs)).rows.length,1,
    "genuine provider evidence permits V2 standing consent without human renewal");
  // The old 15m bootstrap grant may expire: no person is silently re-signed,
  // and only the separately signed unrevoked standing delegation can continue.
  await db.query("UPDATE "+privateSchema+".strata_api_fee_source_grants SET expires_at=now()-interval '1 second' WHERE grant_id=$1",[gid]);
  assert.equal((await db.query(continuation,renewArgs)).rows.length,1);
  await db.query("UPDATE "+privateSchema+".strata_api_fee_standing_models SET revoked_at=now() WHERE model_id=$1",[modelId]);
  assert.equal((await db.query(continuation,renewArgs)).rows.length,0,"technical review revocation must immediately forbid renewal");
  await db.query("UPDATE "+privateSchema+".strata_api_fee_standing_models SET revoked_at=NULL WHERE model_id=$1",[modelId]);
  await db.query("UPDATE "+scopedPublic+".v13_live_money_policy SET policy_hash=$1 WHERE id='policy'",["e".repeat(64)]);
  assert.equal((await db.query(continuation,renewArgs)).rows.length,0,"amended owner risk policy must forbid renewal");
  await db.query("UPDATE "+scopedPublic+".v13_live_money_policy SET policy_hash=$1 WHERE id='policy'",[policyHash]);
  await db.query("UPDATE "+privateSchema+".strata_api_fee_owner_consents SET revoked_at=now() WHERE grant_id=$1",[gid]);
  assert.equal((await db.query(continuation,renewArgs)).rows.length,0,"owner revocation must immediately forbid renewal");
  // The original legacy stage remains fail-closed even after bootstrap expiry.
await db.query("UPDATE "+privateSchema+".strata_api_fee_owner_consents SET revoked_at=now() WHERE grant_id=$1",[gid]);
  assert.equal((await db.query(sql,args)).rows.length,0);
 }finally{
  await db.query("ROLLBACK").catch(()=>{});
  db.release();
 }
});
