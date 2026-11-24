import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {withTechnicalSetupDatabaseAdmission} from "./technicalSetupAdmissionDb";
import {technicalSetupResult} from "./technicalSetupAdvance";
import type {PgPoolLike} from "./accountCredentialStore";
const owners=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"];
const expected="postgresql://postgres:postgres@127.0.0.1:5432/strata_setup_ci";
test("separate pools serialize one owner, cap global admissions and release on completion",async()=>{
  if(process.env.STRATA_CREDENTIAL_NATIVE_TESTS!=="1"||process.env.DATABASE_URL!==expected||
    process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true")throw Error("disposable native fixture required");
  const {Pool}=createRequire(resolve("../../lib/db/package.json"))("pg") as {Pool:new(config:Record<string,unknown>)=>PgPoolLike&{end():Promise<void>}};
  const a=new Pool({connectionString:expected,max:4}),b=new Pool({connectionString:expected,max:4});
  const hold=()=>{let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>release=r);return {ready,release,work:async(check:()=>Promise<void>)=>{await check();entered();await done;await check();return technicalSetupResult("EXISTING_ACCOUNT","ok");}};};
  const first=hold(),second=hold();
  const p=withTechnicalSetupDatabaseAdmission(a,owners[0]!,first.work);
  try{
    await Promise.race([first.ready,p.then(r=>{throw Error(r.reason);})]);
    const reject=async()=>{throw Error("duplicate work must not run");};
    assert.equal((await withTechnicalSetupDatabaseAdmission(b,owners[0]!,reject)).stage,"BUSY");
    const q=withTechnicalSetupDatabaseAdmission(b,owners[1]!,second.work);
    try{
      await Promise.race([second.ready,q.then(r=>{throw Error(r.reason);})]);
      assert.equal((await withTechnicalSetupDatabaseAdmission(a,owners[2]!,reject)).stage,"BUSY");
    }finally{second.release();assert.equal((await q).stage,"EXISTING_ACCOUNT");}
    first.release();assert.equal((await p).stage,"EXISTING_ACCOUNT");
    assert.equal((await withTechnicalSetupDatabaseAdmission(b,owners[0]!,async(check)=>{await check();return technicalSetupResult("EXISTING_ACCOUNT","ok");})).stage,"EXISTING_ACCOUNT");
    assert.equal((await withTechnicalSetupDatabaseAdmission(a,owners[0]!,async()=>{throw Error("lost outcome");})).stage,"UNKNOWN");
    assert.equal((await withTechnicalSetupDatabaseAdmission(b,owners[0]!,async()=>technicalSetupResult("EXISTING_ACCOUNT","ok"))).stage,"EXISTING_ACCOUNT");
  }finally{first.release();second.release();await p;await a.end();await b.end();}
});
