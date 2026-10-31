import test from 'node:test';import assert from 'node:assert/strict';import {pool} from '@workspace/db';
import {HELD_LIFECYCLE_CREDENTIAL_SQL,HELD_LIFECYCLE_SECRET_SQL} from './heldLifecycleShadowProbe';
test('held lifecycle exact SQL denies unsafe scope, reservations and credential drift',async()=>{
 assert.ok(process.env.V13_DISPOSABLE_DATABASE_URL,'requires isolated runner');
 const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',account='strata-account-'+'a'.repeat(24),fa='33333333-3333-4333-8333-333333333333',pc='44444444-4444-4444-8444-444444444444',vault='55555555-5555-4555-8555-555555555555',fingerprint='c'.repeat(64);
 const client=await pool.connect();
 const q=(sql:string,params?:unknown[])=>client.query(sql.replaceAll('public.','lifecycle_public.').replaceAll('private.','lifecycle_private.').replaceAll('vault.','lifecycle_vault.'),params);
 try{
 await q(`CREATE SCHEMA lifecycle_vault; CREATE TABLE vault.decrypted_secrets(id uuid,decrypted_secret text); CREATE SCHEMA lifecycle_private; CREATE SCHEMA lifecycle_public;
 CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,kalshi_connection_id uuid,subaccount int,exchange_index int,reserved_micros bigint,key_fingerprint text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,arm_requested boolean);
 CREATE TABLE public.v13_production_position(account_id text,quantity_hundredths bigint);
 CREATE TABLE public.v13_production_intent(account_id text,terminal boolean,state text,reserved_micros bigint);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
 CREATE TABLE public.financial_accounts(id uuid,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid,financial_account_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,vault_secret_id uuid,key_fingerprint text);`);
 await q('INSERT INTO public.v13_production_account VALUES($1,$2,$3,1,2,0,$4)',[account,owner,fa,fingerprint]);
 await q("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,'released',false)",[account,owner]);
 await q("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[fa,owner]);await q('INSERT INTO private.provider_connections VALUES($1,$2)',[pc,fa]);
 await q("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,'restricted_execution',NULL,now(),'credential_verified',$4,$5)",[owner,fa,pc,vault,fingerprint]);await q('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[vault,'fixture-only']);
 const credential=(params=[account,owner])=>q(HELD_LIFECYCLE_CREDENTIAL_SQL,params),secret=()=>q(HELD_LIFECYCLE_SECRET_SQL,[account,owner,fingerprint]);
 assert.equal((await credential()).rowCount,1);assert.equal((await secret()).rowCount,1);
 for(const wrong of [[account,other],['legacy',owner]])assert.equal((await credential(wrong)).rowCount,0);
 const statements=["UPDATE private.kalshi_account_worker_lease SET state='owned'",'UPDATE private.kalshi_account_worker_lease SET arm_requested=true','UPDATE private.kalshi_account_worker_lease SET arm_requested=NULL',
 'UPDATE public.v13_production_account SET reserved_micros=1','UPDATE public.v13_production_account SET exchange_index=1',
 `INSERT INTO public.v13_production_position VALUES('${account}',1)`,`INSERT INTO public.v13_production_intent VALUES('${account}',false,'UNKNOWN',0)`,`INSERT INTO private.strata_emergency_exit_reservations VALUES('${account}','PREPARED')`,
 "UPDATE private.kalshi_connection_credentials SET role='account_setup_execution'",'UPDATE private.kalshi_connection_credentials SET revoked_at=now()',"UPDATE private.kalshi_connection_credentials SET key_fingerprint='changed'",'UPDATE private.kalshi_connection_credentials SET verified_at=NULL',`UPDATE private.kalshi_connection_credentials SET provider_connection_id='${other}'`,`UPDATE public.financial_accounts SET user_id='${other}'`];
 for(const statement of statements){await q('BEGIN');await q(statement);assert.equal((await credential()).rowCount,0,statement);assert.equal((await secret()).rowCount,0,statement);await q('ROLLBACK');}
 await q('INSERT INTO private.kalshi_connection_credentials SELECT * FROM private.kalshi_connection_credentials');assert.equal((await credential()).rowCount,2);assert.equal((await secret()).rowCount,0);
 }finally{client.release();await pool.end();}
});
