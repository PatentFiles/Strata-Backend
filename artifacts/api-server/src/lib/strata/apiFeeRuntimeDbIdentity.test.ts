import test from "node:test";
import assert from "node:assert/strict";
import {inspectRuntimeDbIdentity,RUNTIME_DB_IDENTITY_SQL} from "./apiFeeRuntimeDbIdentity";
const admin="22222222-2222-4222-8222-222222222222";
test("runtime identity denies missing and unconfirmed administrators, never reads connection metadata",async()=>{
 const calls:string[]=[];
 const db={query:async(sql:string)=>{
   calls.push(sql);
   return {rows:[{is_admin:false}]};
 }};
 const malformed=await inspectRuntimeDbIdentity("not-an-actor",db);
 assert.equal(malformed.ok,false);
 assert.equal(calls.length,0);
 const rejected=await inspectRuntimeDbIdentity(admin,db);
 assert.equal(rejected.ok,false);
 assert.equal(rejected.reason,"confirmed_administrator_required");
 assert.equal(calls.length,1);
 assert.equal(calls[0]!.includes("auth.users"),true);
 assert.equal(JSON.stringify(rejected).includes("runtimeRole"),false);
});
test("confirmed admin receives only nonsecret read-only flags and stable fingerprint",async()=>{
 const calls:string[]=[];
 const db={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.includes("FROM auth.users u"))return {rows:[{is_admin:true}]};
  return {rows:[{
   runtime_role:"postgres",database_name:"postgres",private_schema_usable:true,
   reviews_ready:true,grants_ready:true,consents_ready:true,
   account_fingerprint:"a".repeat(32),
  }]};
 }};
 const result=await inspectRuntimeDbIdentity(admin,db);
 assert.equal(result.ok,true);
 assert.equal(result.privateSchemaUsable,true);
 assert.equal(result.accountFingerprint,"a".repeat(32));
 assert.equal(result.policyApproved,false);
 assert.equal(result.commissioningApproved,false);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(calls.length,2);
 assert.equal(calls[1],RUNTIME_DB_IDENTITY_SQL);
 assert.equal(/\b(INSERT|UPDATE|DELETE|GRANT|CREATE|ALTER|DROP)\b/.test(RUNTIME_DB_IDENTITY_SQL),false);
 for(const banned of ["DATABASE_URL","password","apiKey","connectionString","server_address"]){
   assert.equal(JSON.stringify(result).includes(banned),false);
 }
});
test("database query failure fails closed without leaking error details",async()=>{
 const db={query:async()=>{throw new Error("password=sensitive");}};
 const result=await inspectRuntimeDbIdentity(admin,db);
 assert.equal(result.ok,false);
 assert.equal(result.reason,"runtime_db_identity_unavailable");
 assert.equal(JSON.stringify(result).includes("sensitive"),false);
});
