import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pool} from "@workspace/db";
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
  await db.query("UPDATE "+privateSchema+".strata_api_fee_owner_consents SET revoked_at=now() WHERE grant_id=$1",[gid]);
  assert.equal((await db.query(sql,args)).rows.length,0);
 }finally{
  await db.query("ROLLBACK").catch(()=>{});
  db.release();
 }
});
