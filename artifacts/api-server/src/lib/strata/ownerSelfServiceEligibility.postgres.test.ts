import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {openCredentialFixture} from "./credentialFixtureDb.testHelper";
import {resolveOwnerSelfScope,readOwnedSelfServiceScope,initializePublicStoppedLease} from "./ownerSelfServiceEligibility";
import {qualifyPublicIndependentLiveScope,independentLiveRolloutAllowed} from "../v13-production/liveEntryContainment";
const fingerprint=(v:string)=>createHash("sha256").update(v).digest("hex");
test("new STANDARD owners admitted independently after deployment without customer configuration (native PostgreSQL)",async t=>{
 const f=await openCredentialFixture();
 if(!f?.nativePool){if(f)await f.close();assert.notEqual(process.env.STRATA_CREDENTIAL_NATIVE_TESTS,"1");t.skip("native isolated database required");return;}
 t.after(()=>f.close());
 const sha="a".repeat(40);
 // Set ONLY the platform flags before creating either customer identity.
 const env={NODE_ENV:"production",RAILWAY_GIT_COMMIT_SHA:sha,STRATA_PUBLIC_SELF_SERVICE_ENABLED:"true",
  STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA:sha,STRATA_INDEPENDENT_LIVE_SOURCE_V1:"true"};
 const a=randomUUID(),b=randomUUID(),c=randomUUID();
 await f.exec(`
 CREATE SCHEMA auth;CREATE SCHEMA private;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz);
 CREATE TABLE public.profiles(id uuid PRIMARY KEY,role text);
 CREATE TABLE public.financial_accounts(id uuid PRIMARY KEY,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid PRIMARY KEY,financial_account_id uuid,vault_secret_id uuid);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int,
   kalshi_connection_id uuid,policy_id text,key_fingerprint text,commissioned boolean,execution_enabled boolean,kill_switch boolean,
   blocked_reason text,cash_precision_verified boolean,cash_micros bigint,initial_cash_micros bigint,reserved_micros bigint,reconciled_at timestamptz);
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,created_by text,approved_by text,state text,
   policy_hash text,max_entry_stake_cents int,max_entry_all_in_cents int);
 CREATE TABLE public.strata_configured_stake(execution_account_id text,configured_stake_cents int);
 CREATE TABLE public.v13_production_event(account_id text,cash_delta_micros bigint);
 CREATE TABLE public.v13_production_intent(account_id text);
 CREATE TABLE public.v13_production_position(account_id text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY,owner_user_id uuid,
  financial_account_id uuid,provider_connection_id uuid,holder_id text,fencing_token bigint,state text,
  heartbeat_at timestamptz,released_at timestamptz,account_kill boolean,arm_requested boolean,
  credential_fingerprint text,vault_secret_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,
   role text,key_fingerprint text,vault_secret_id uuid,revoked_at timestamptz,verified_at timestamptz,verification_reason text);
 `);
 const add=async(owner:string,account:string)=>{
  const fa=randomUUID(),pc=randomUUID(),primary=randomUUID(),policy=randomUUID();
  await f.query("INSERT INTO auth.users VALUES($1,now(),NULL)",[owner]);
  await f.query("INSERT INTO public.profiles VALUES($1,'STANDARD')",[owner]);
  await f.query("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[fa,owner]);
  await f.query("INSERT INTO private.provider_connections VALUES($1,$2,$3)",[pc,fa,primary]);
  await f.query("INSERT INTO public.v13_production_account VALUES($1,$2,1,2,$3,$4,$5,true,true,false,NULL,true,25000000,25000000,0,now())",[account,owner,fa,policy,fingerprint(owner+"restricted_execution")]);
  await f.query("INSERT INTO public.v13_live_money_policy VALUES($1,$2,$3,$3,'APPROVED',$4,500,625)",[policy,account,owner,fingerprint(policy)]);
  await f.query("INSERT INTO public.strata_configured_stake VALUES($1,500)",[account]);
  for(const role of ["provisioning","verification","account_setup_execution","restricted_execution"])
   await f.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,$5,$6,NULL,now(),'credential_verified')",[owner,fa,pc,role,fingerprint(owner+role),randomUUID()]);
  return {ownerId:owner,accountId:account,releaseSha:sha};
 };
 const one=await add(a,"account-a"),two=await add(b,"account-b");
 assert.equal(await resolveOwnerSelfScope(f,c,sha,"authority",env),undefined);
 const admitted=await Promise.all([one,two].map(x=>qualifyPublicIndependentLiveScope(f,x,env)));
 assert.ok(admitted[0]&&admitted[1]);
 assert.deepEqual(await resolveOwnerSelfScope(f,a,sha,"authority",env),{ownerId:a,accountId:one.accountId});
 assert.deepEqual(await resolveOwnerSelfScope(f,b,sha,"authority",env),{ownerId:b,accountId:two.accountId});
 assert.equal(independentLiveRolloutAllowed(one,env,admitted[0]),true);
 assert.equal(independentLiveRolloutAllowed(two,env,admitted[1]),true);
 assert.equal(independentLiveRolloutAllowed(two,env,admitted[0]),false);
 assert.equal(independentLiveRolloutAllowed(one,env,{...admitted[0]}),false);
 assert.equal(await qualifyPublicIndependentLiveScope(f,{...one,accountId:two.accountId},env),null);
 assert.equal(await qualifyPublicIndependentLiveScope(f,one,{...env,STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA:"b".repeat(40)}),null);
 // Existing grants are not manufactured; this exercises only admission.
 const invalidations=[
  ["UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=$1","UPDATE auth.users SET banned_until=NULL WHERE id=$1"],
  ["UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1","UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1"],
  ["UPDATE private.kalshi_connection_credentials SET revoked_at=now() WHERE owner_user_id=$1 AND role='verification'","UPDATE private.kalshi_connection_credentials SET revoked_at=NULL WHERE owner_user_id=$1"],
  ["UPDATE public.v13_live_money_policy SET state='DRAFT' WHERE created_by=$1::text","UPDATE public.v13_live_money_policy SET state='APPROVED' WHERE created_by=$1::text"],
  ["UPDATE public.v13_production_account SET cash_micros=25000001 WHERE owner_user_id=$1","UPDATE public.v13_production_account SET cash_micros=25000000 WHERE owner_user_id=$1"],
  ["UPDATE public.v13_production_account SET kill_switch=true WHERE owner_user_id=$1","UPDATE public.v13_production_account SET kill_switch=false WHERE owner_user_id=$1"],
  ["UPDATE public.v13_production_account SET blocked_reason='production_external_cash_mismatch' WHERE owner_user_id=$1","UPDATE public.v13_production_account SET blocked_reason=NULL WHERE owner_user_id=$1"],
 ];
 for(const [mutate,restore] of invalidations){
  await f.query(mutate!,[a]);assert.equal(await qualifyPublicIndependentLiveScope(f,one,env),null,mutate);
  assert.ok(await qualifyPublicIndependentLiveScope(f,two,env),"other customer remains isolated");
  await f.query(restore!,[a]);
 }
 // Initial release preparation can create a stopped lease without an
 // administrator, but must not enable a worker, reset a fence or erase history.
 await f.query("UPDATE public.v13_production_account SET execution_enabled=false,kill_switch=true WHERE owner_user_id=$1",[a]);
 await f.exec("BEGIN");
 try{
  await f.query("SELECT id FROM public.v13_production_account WHERE owner_user_id=$1 FOR UPDATE",[a]);
  assert.equal(await initializePublicStoppedLease(f,a,two.accountId,sha,env),false);
  assert.equal(await initializePublicStoppedLease(f,a,one.accountId,sha,env),true);
  assert.equal(await initializePublicStoppedLease(f,a,one.accountId,sha,env),false);
  await f.exec("COMMIT");
 }catch(e){await f.exec("ROLLBACK");throw e;}
 const lease=await f.query("SELECT owner_user_id::text,state,account_kill,arm_requested,fencing_token::text FROM private.kalshi_account_worker_lease");
 assert.deepEqual(lease.rows,[{owner_user_id:a,state:"killed",account_kill:true,arm_requested:false,fencing_token:"1"}]);
 assert.equal(await qualifyPublicIndependentLiveScope(f,one,env),null);
 assert.ok(await qualifyPublicIndependentLiveScope(f,two,env));
 await f.query("UPDATE public.v13_production_account SET initial_cash_micros=0 WHERE owner_user_id=$1",[a]);
 const recovery=await readOwnedSelfServiceScope(f,a,sha,"recovery",{...env,STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA:undefined});
 assert.ok(recovery);assert.equal(recovery.cashConserved,false);assert.equal(await qualifyPublicIndependentLiveScope(f,one,env),null);
 console.info("PUBLIC_OWNER_ADMISSION_NATIVE_RESULT",{standardCustomers:2,withoutCustomerEnvironmentVariables:true,crossOwnerRefused:true,negativeCases:invalidations.length,ordersSubmitted:0});
});
