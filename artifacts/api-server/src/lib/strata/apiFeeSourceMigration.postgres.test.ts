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
