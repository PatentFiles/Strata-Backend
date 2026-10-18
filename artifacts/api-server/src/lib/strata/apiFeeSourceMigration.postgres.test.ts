import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFileSync} from "node:fs";

test("API fee-source migration is additive, empty, scoped, and RLS enabled",async(t)=>{
 let PGlite:new()=>{exec(sql:string):Promise<unknown>;
 query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;close():Promise<void>};
 try{
  PGlite=(createRequire(process.cwd()+"/package.json")("@electric-sql/pglite") as
   {PGlite:typeof PGlite}).PGlite;
 }catch{t.skip("pglite unavailable");return;}
 const db=new PGlite();
 try{
  await db.exec(`CREATE SCHEMA auth;CREATE SCHEMA private;
   CREATE TABLE auth.users(id uuid PRIMARY KEY);
   CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;`);
  const migration=readFileSync("../../lib/db/drizzle/0030_strata_api_fee_rate_source_v1.sql","utf8");
  await db.exec(migration);
  for(const name of ["strata_api_fee_rate_reviews",
    "strata_api_fee_source_grants","strata_api_fee_owner_consents"]){
   const count=await db.query(`SELECT count(*)::integer AS n
     FROM private.${name}`);
   assert.equal(Number(count.rows[0]?.n),0,name+" must start with no signed approvals");
  }
  const rls=await db.query(`SELECT relname,relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='private' AND relname LIKE 'strata_api_fee_%'`);
  assert.equal(rls.rows.length,3);
  for(const row of rls.rows)assert.equal(row.relrowsecurity,true);
  const wrong=await db.query(`SELECT EXISTS(
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='private' AND table_name='strata_api_fee_source_grants'
      AND grantee='authenticated' AND privilege_type='INSERT') AS allowed`);
  assert.equal(wrong.rows[0]?.allowed,false);
 }finally{await db.close();}
});


test("two-person source-stage SQL runs on the migrated PostgreSQL schema and revocation fails closed",async(t)=>{
 let PGlite:new()=>{exec(sql:string):Promise<unknown>;
   query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;close():Promise<void>};
 try {
   PGlite=(createRequire(process.cwd()+"/package.json")("@electric-sql/pglite") as
     {PGlite:typeof PGlite}).PGlite;
 }catch{t.skip("pglite unavailable");return;}
 const db=new PGlite();
 const owner="11111111-1111-4111-8111-111111111111";
 const admin="22222222-2222-4222-8222-222222222222";
 const grant="55555555-5555-4555-8555-555555555555";
 const decision="a".repeat(64);
 const model="kalshi_quadratic_007_whole_cent_conservative_reference_v1";
 try{
  await db.exec([
    "CREATE SCHEMA auth; CREATE SCHEMA private;",
    "CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);",
    "CREATE TABLE private.role_assignments(email text NOT NULL,role text NOT NULL);",
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;"
  ].join("\n"));
  const migration=readFileSync("../../lib/db/drizzle/0030_strata_api_fee_rate_source_v1.sql","utf8");
  await db.exec(migration);
  const stageSource=readFileSync("src/lib/strata/apiFeeSourceStage.ts","utf8");
  const tick=String.fromCharCode(96);
  const marker="export const READ_API_FEE_STAGE_SQL="+tick;
  const sql=stageSource.split(marker)[1]?.split(tick+";")[0];
  assert.ok(sql && sql.includes("FOR SHARE OF g,c,r1"),"use actual production stage fence SQL");
  await db.exec([
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES "+
     "('"+owner+"','owner@example.invalid',now()),"+
     "('"+admin+"','technical@example.invalid',now());",
    "INSERT INTO private.role_assignments(email,role) "+
     "VALUES('technical@example.invalid','ADMIN');",
    "INSERT INTO private.strata_api_fee_rate_reviews "+
     "(owner_user_id,reviewer_user_id,rate_decision_digest,fee_model_version,"+
     "confirmation,review_note,verified_rate_source,signed_at,expires_at) "+
     "VALUES('"+owner+"','"+admin+"','"+decision+"','"+model+"',"+
     "'I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1',"+
     "'I independently verified the current monetary fee coefficient, rate, "+
       "rounding, applicable BTC market exceptions and effective date from Kalshi official sources.',"+
     "'kalshi_official_fee_publication',now()-interval '1 minute',now()+interval '30 minutes');",
    "INSERT INTO private.strata_api_fee_source_grants "+
     "(grant_id,owner_user_id,issuer_admin_id,rate_decision_digest,fee_model_version,"+
     "policy_version,authorized_stages,confirmation,issued_at,expires_at) "+
     "VALUES('"+grant+"','"+owner+"','"+admin+"','"+decision+"','"+model+"',"+
     "'strata_api_fee_source_signed_review_v2',"+
     "ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],"+
     "'ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1',now()-interval '30 seconds',now()+interval '10 minutes');",
    "INSERT INTO private.strata_api_fee_owner_consents "+
     "(grant_id,owner_user_id,confirmation,confirmed_at) "+
     "VALUES('"+grant+"','"+owner+"','CONFIRM_REVIEWED_API_FEE_SOURCE_V1',"+
     "now()-interval '15 seconds');"
  ].join("\n"));
  const args=[owner,null,"STEP_9",decision,model];
  const active=await db.query(sql,args);
  assert.equal(active.rows.length,1,"exact signed owner/technical review and consent must match");
  assert.equal(String(active.rows[0]?.first_reviewer),admin);
  assert.equal(String(active.rows[0]?.consent_owner),owner);
  await db.exec("UPDATE private.strata_api_fee_owner_consents SET revoked_at=now() "+
    "WHERE grant_id='"+grant+"';");
  const revoked=await db.query(sql,args);
  assert.equal(revoked.rows.length,0,"revoked owner consent must fail closed at DB");
 }finally{await db.close();}
});
