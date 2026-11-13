import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,type Pool} from '@workspace/db';
import {installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';
import {createProductionPersonalSession} from './personalExecutionSupervisor';

// DISPOSABLE ACL EXPERIMENT ONLY. No encryption, extension, real key or token.
// The managed owner is a synthetic NOLOGIN role, not supabase_admin itself.
export const vaultOwner='platform_vault_owner_fixture';
export const vaultRuntime='restricted_platform_vault';
export const vaultUnrelated='unrelated_platform_vault';
export const vaultHelper='vault.fixture_invoker_decode(bytea,bytea,bigint,bytea,bytea)';
const NativePool=pool.constructor as new(config:{connectionString:string;max:number;connectionTimeoutMillis:number})=>Pool;
export const signerTables=['public.v13_production_account','private.kalshi_connection_credentials',
 'public.v13_live_money_policy','public.strata_configured_stake'];

export function canonicalVaultUrl(){
 const url=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
  'only the unchanged canonical disposable runner may install this fixture');
 return new URL(url);
}

export async function assertVaultIdentity(db:Pick<Pool,'query'>,role=vaultRuntime){
 assert.deepEqual((await db.query(`SELECT current_user AS name,session_user AS session,
  rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
  FROM pg_roles WHERE rolname=current_user`)).rows[0],{name:role,session:role,rolsuper:false,
  rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolinherit:false});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
}

export async function openRestrictedPlatformVault(){
 const url=canonicalVaultUrl();
 const setup=new NativePool({connectionString:url.toString(),max:3,connectionTimeoutMillis:10000});
 let runtime:Pool|undefined,unrelated:Pool|undefined,singletonClosed=false;
 try{
  const bootstrap=await setup.connect();
  try{await installFullRecoverySchema(bootstrap);}finally{bootstrap.release();}
  const actual=(await setup.query(`SELECT current_database() AS name,session_user AS user,
   host(inet_server_addr()) AS host,inet_server_port() AS port`)).rows[0];
  assert.deepEqual(actual,{name:url.pathname.slice(1),user:'v13_test',host:'127.0.0.1',port:Number(url.port)});
  await setup.query(`CREATE ROLE ${vaultOwner} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   CREATE ROLE ${vaultRuntime} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   CREATE ROLE ${vaultUnrelated} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   ALTER SCHEMA vault OWNER TO ${vaultOwner};
   ALTER TABLE vault.secrets ADD COLUMN secret text NOT NULL DEFAULT 'dummy-not-encrypted';
   ALTER TABLE vault.secrets OWNER TO ${vaultOwner};
   REVOKE ALL ON vault.secrets FROM PUBLIC,anon,authenticated,service_role;
   CREATE FUNCTION vault.fixture_invoker_decode(bytea,bytea,bigint,bytea,bytea)
    RETURNS bytea LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    BEGIN RETURN $1; END $$;
   ALTER FUNCTION ${vaultHelper} OWNER TO ${vaultOwner};
   REVOKE ALL ON FUNCTION ${vaultHelper} FROM PUBLIC,anon,authenticated,service_role;
   CREATE VIEW vault.decrypted_secrets AS SELECT id,
    pg_catalog.convert_from(vault.fixture_invoker_decode(pg_catalog.convert_to(secret,'UTF8'),
     ''::bytea,0::bigint,''::bytea,''::bytea),'UTF8') AS decrypted_secret FROM vault.secrets;
   ALTER VIEW vault.decrypted_secrets OWNER TO ${vaultOwner};
   REVOKE ALL ON vault.decrypted_secrets FROM PUBLIC,anon,authenticated,service_role;
   GRANT USAGE ON SCHEMA public,private,vault TO ${vaultRuntime};
   GRANT USAGE ON SCHEMA vault TO ${vaultUnrelated};
   GRANT SELECT(id,decrypted_secret) ON vault.decrypted_secrets TO ${vaultRuntime};
   GRANT EXECUTE ON FUNCTION ${vaultHelper} TO ${vaultRuntime},${vaultUnrelated}`);
  // Only the real signer query's four application relations. This service-wide
  // synthetic read policy is not caller authentication or a tenant RLS design.
  for(const table of signerTables){
   await setup.query(`GRANT SELECT ON ${table} TO ${vaultRuntime}`);
   const rls=(await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity;
   if(table==='public.strata_configured_stake')assert.equal(rls,false,'source fixture shape, not a production catalog claim');
   else{
    assert.equal(rls,true,table);
    await setup.query(`CREATE POLICY platform_vault_signer_read ON ${table} FOR SELECT TO ${vaultRuntime} USING(true)`);
   }
  }
  await pool.end();singletonClosed=true;
  url.username=vaultRuntime;
  runtime=new NativePool({connectionString:url.toString(),max:1,connectionTimeoutMillis:10000});
  url.username=vaultUnrelated;
  unrelated=new NativePool({connectionString:url.toString(),max:1,connectionTimeoutMillis:10000});
  await assertVaultIdentity(runtime);await assertVaultIdentity(unrelated,vaultUnrelated);
  return {setup,runtime,unrelated};
 }catch(error){
  const cleanup=await Promise.allSettled([setup.end(),runtime?.end(),unrelated?.end(),singletonClosed?undefined:pool.end()]);
  const failures=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
  if(failures.length)throw new AggregateError([error,...failures],'platform_vault_setup_cleanup_failed');
  throw error;
 }
}

export async function seedVaultSigner(setup:Pool,label:string){
 const s={owner:randomUUID(),financial:randomUUID(),provider:randomUUID(),credential:randomUUID(),secret:randomUUID(),
  account:'platform-vault-'+randomUUID(),fingerprint:'a'.repeat(64),dummy:'dummy-not-a-key-'+label};
 await setup.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1::uuid,($1::uuid)::text||'@example.invalid',now())",[s.owner]);
 await setup.query('INSERT INTO vault.secrets(id,secret) VALUES($1,$2)',[s.secret,s.dummy]);
 await setup.query("INSERT INTO public.financial_accounts(id,user_id,provider) VALUES($1,$2,'kalshi')",[s.financial,s.owner]);
 await setup.query('INSERT INTO private.provider_connections(id,financial_account_id) VALUES($1,$2)',[s.provider,s.financial]);
 await setup.query(`INSERT INTO private.kalshi_connection_credentials(id,owner_user_id,financial_account_id,
  provider_connection_id,role,vault_secret_id,key_fingerprint,verified_at,verification_reason)
  VALUES($1,$2,$3,$4,'restricted_execution',$5,$6,now(),'credential_verified')`,
 [s.credential,s.owner,s.financial,s.provider,s.secret,s.fingerprint]);
 await setup.query(`INSERT INTO public.v13_production_account(id,owner_user_id,kalshi_connection_id,subaccount,
  exchange_index,key_fingerprint,cash_micros,reserved_micros,initial_cash_micros,revision,blocked_reason)
  VALUES($1,$2,$3,1,2,$4,25000000,0,25000000,0,'synthetic-do-not-start')`,[s.account,s.owner,s.financial,s.fingerprint]);
 return s;
}

// Invoke the production loader unchanged. Record only native result counts,
// dummy projection values and SQLSTATE, never substitute a result or an error.
export async function probeVaultSigner(db:Pool,owner:string,account:string){
 const rows:Record<string,unknown>[][]=[],errors:string[]=[];let providerCalls=0,queries=0;
 const session=createProductionPersonalSession({query:async(sql:string,params?:unknown[])=>{
  queries++;assert.match(sql,/-- personal-session:signer/);
  try{const result=await db.query(sql,params);rows.push(result.rows);return result;}
  catch(error){errors.push(String((error as {code?:string}).code??'NON_SQL_ERROR'));throw error;}
 }},{kalshiGet:async()=>{providerCalls++;throw Error('platform_vault_provider_forbidden');},
  verifyFee:async()=>{throw Error('platform_vault_fee_io_forbidden');}});
 const result=await session.start({userId:owner,accountId:account,action:'START'});
 assert.deepEqual(result,{ok:false,reason:'personal_signer_unavailable',workerStarted:false});
 assert.equal(queries,1);assert.equal(providerCalls,0);assert.equal(session.isScheduled(owner,account),false);
 return {rows,errors};
}

export async function vaultDenied(db:Pick<Pool,'query'>,sql:string,args:unknown[]=[]){
 await assert.rejects(db.query(sql,args),(error:unknown)=>{
  assert.equal((error as {code?:string}).code,'42501');return true;
 });
}
