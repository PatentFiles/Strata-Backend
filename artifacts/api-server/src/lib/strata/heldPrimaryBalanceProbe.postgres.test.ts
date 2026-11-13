import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {HELD_PRIMARY_SQL,PRIMARY_CREDENTIAL_SQL,PRIMARY_OBSERVATION_SQL,PRIMARY_SECRET_SQL} from './heldPrimaryBalanceProbe';
test('real disposable PostgreSQL enforces held owner/role/binding and atomic observation scope',async()=>{
 assert.ok(process.env.V13_DISPOSABLE_DATABASE_URL,'requires isolated runner');
 const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',account='strata-account-'+'a'.repeat(24),fa='33333333-3333-4333-8333-333333333333',pc='44444444-4444-4444-8444-444444444444',vault='55555555-5555-4555-8555-555555555555';
 const q=(sql:string,params?:unknown[])=>pool.query(sql.replaceAll('public.','probe_public.').replaceAll('private.','probe_private.').replaceAll('vault.','probe_vault.'),params);
 try{
 await q(`CREATE SCHEMA probe_vault; CREATE TABLE vault.decrypted_secrets(id uuid,decrypted_secret text); CREATE SCHEMA probe_private; CREATE SCHEMA probe_public;
 CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,kalshi_connection_id uuid,subaccount int,exchange_index int,reserved_micros bigint);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,arm_requested boolean);
 CREATE TABLE public.v13_production_position(account_id text,quantity_hundredths bigint);
 CREATE TABLE public.v13_production_intent(account_id text,terminal boolean,state text,reserved_micros bigint);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
 CREATE TABLE public.financial_accounts(id uuid,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid,financial_account_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,vault_secret_id uuid,key_fingerprint text);
 CREATE TABLE public.v13_production_observation(id text,account_id text,kind text,payload jsonb,digest text);`);
 await q(`INSERT INTO public.v13_production_account VALUES($1,$2,$3,1,2,0)`,[account,owner,fa]);
 await q(`INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,'released',false)`,[account,owner]);
 await q(`INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')`,[fa,owner]);
 await q(`INSERT INTO private.provider_connections VALUES($1,$2)`,[pc,fa]);
 await q(`INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,'account_setup_execution',NULL,now(),'credential_verified',$4,'fp')`,[owner,fa,pc,vault]);
 await q('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[vault,'fixture-private']);
 const params=[account,owner];
 const secret=()=>q(PRIMARY_SECRET_SQL,[...params,vault,'fp']);
 assert.equal((await secret()).rowCount,1);
 assert.equal((await q(HELD_PRIMARY_SQL,params)).rowCount,1);
 assert.equal((await q(PRIMARY_CREDENTIAL_SQL,params)).rowCount,1);
 for(const wrong of [[account,other],['legacy',owner]]){assert.equal((await q(HELD_PRIMARY_SQL,wrong)).rowCount,0);assert.equal((await q(PRIMARY_CREDENTIAL_SQL,wrong)).rowCount,0);}
 const save=()=>q(PRIMARY_OBSERVATION_SQL,[...params,'observation','{}','digest',vault,'fp']);
 assert.equal((await save()).rowCount,1);
 await q('BEGIN');await q('INSERT INTO private.kalshi_connection_credentials SELECT * FROM private.kalshi_connection_credentials');assert.equal((await secret()).rowCount,0);assert.equal((await save()).rowCount,0);await q('ROLLBACK');
 for(const mutation of ["role='restricted_execution'",'revoked_at=now()',"verification_reason='unverified'",'verified_at=NULL',`owner_user_id='${other}'`,`provider_connection_id='${other}'`,`financial_account_id='${other}'`,"key_fingerprint='replacement'"]){
  await q('BEGIN');await q('UPDATE private.kalshi_connection_credentials SET '+mutation);assert.equal((await save()).rowCount,0);assert.equal((await secret()).rowCount,0);await q('ROLLBACK');
 }
 for(const statement of ["UPDATE private.kalshi_account_worker_lease SET state='active'",'UPDATE private.kalshi_account_worker_lease SET arm_requested=true','UPDATE public.v13_production_account SET reserved_micros=1',`INSERT INTO public.v13_production_position VALUES('${account}',1)`,`INSERT INTO public.v13_production_intent VALUES('${account}',false,'UNKNOWN',0)`,`INSERT INTO private.strata_emergency_exit_reservations VALUES('${account}','PREPARED')`]){
  await q('BEGIN');await q(statement);assert.equal((await q(HELD_PRIMARY_SQL,params)).rowCount,0);assert.equal((await save()).rowCount,0);assert.equal((await secret()).rowCount,0);await q('ROLLBACK');
 }
 }finally{await pool.end();}
});
