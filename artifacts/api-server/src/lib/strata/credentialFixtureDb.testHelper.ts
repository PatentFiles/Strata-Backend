import {randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {resolve} from "node:path";

export interface CredentialFixtureDb {
  exec(sql:string):Promise<unknown>;
  query(sql:string,params?:unknown[]):Promise<{rows:Array<Record<string,unknown>>}>;
  close():Promise<void>;
}
type Client={connect():Promise<void>;end():Promise<void>;query(sql:string,params?:unknown[]):Promise<{rows:Array<Record<string,unknown>>}>};
type ClientFactory=new(config:{connectionString:string;connectionTimeoutMillis:number;statement_timeout:number;application_name:string})=>Client;

/** Native integration mode is explicitly CI-only and uses the fixed disposable
 * PostgreSQL service, never an ambient or hosted database. Each test owns a
 * newly named empty database. Optional local PGlite remains supported. */
export async function openCredentialFixture():Promise<CredentialFixtureDb|null>{
  if(process.env.STRATA_CREDENTIAL_NATIVE_TESTS!=="1"){
    let PGlite:new()=>CredentialFixtureDb;
    try{PGlite=createRequire(resolve("package.json"))("@electric-sql/pglite").PGlite;}
    catch{return null;}
    return new PGlite();
  }
  const expected="postgresql://postgres:postgres@127.0.0.1:5432/strata_setup_ci";
  if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true"||process.env.NODE_ENV!=="test"||
     process.env.DATABASE_URL!==expected)throw Error("credential_native_fixture_requires_disposable_ci_service");
  const {Client}=createRequire(resolve("../../lib/db/package.json"))("pg") as {Client:ClientFactory};
  const cfg={connectionTimeoutMillis:5000,statement_timeout:15000,application_name:"strata_credential_fixture"};
  const admin=new Client({...cfg,connectionString:expected});
  const name="credential_fixture_"+randomUUID().replace(/-/g,"");
  let created=false,child:Client|null=null;
  const cleanup=async()=>{
    try{if(child)await child.end();}
    finally{try{if(created)await admin.query('DROP DATABASE "'+name+'"');}finally{await admin.end();}}
  };
  try{
    await admin.connect();
    const pin=await admin.query("SELECT current_database() AS db, current_user AS username, inet_server_addr()::text AS address");
    if(pin.rows.length!==1||pin.rows[0]?.db!=="strata_setup_ci"||pin.rows[0]?.username!=="postgres"||typeof pin.rows[0]?.address!=="string")throw Error("credential_native_fixture_identity_mismatch");
    await admin.query('CREATE DATABASE "'+name+'"');created=true;
    const url=new URL(expected);url.pathname="/"+name;
    child=new Client({...cfg,connectionString:url.toString()});
    await child.connect();
    const client=child;
    return {exec:sql=>client.query(sql),query:(sql,params)=>client.query(sql,params),close:cleanup};
  }catch(error){await cleanup();throw error;}
}
