import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {createRoutineStopFence} from './routineStopFence';

const url=process.env.V13_DISPOSABLE_DATABASE_URL;
if(!url||url!==process.env.DATABASE_URL||new URL(url).hostname!=='127.0.0.1'||
 !/^\/v13_disposable_\d+$/.test(new URL(url).pathname))throw Error('explicit_disposable_only');
const owner='11111111-1111-4111-8111-111111111111',other='55555555-5555-4555-8555-555555555555',
 account='main',fa='22222222-2222-4222-8222-222222222222',pc='33333333-3333-4333-8333-333333333333',
 vault='44444444-4444-4444-8444-444444444444',sha='a'.repeat(40),fingerprint='b'.repeat(64);

test('native read-only routine STOP accepts normal and mismatch-held scope, refuses exposure and lease drift',async()=>{
 let transactionCount=0,scheduled=false;
 const read=createRoutineStopFence({releaseSha:()=>sha,isScheduled:()=>scheduled,connect:async()=>{
  const c=await pool.connect();return {query:async(s:string,p?:unknown[])=>{
   assert.match(s.trim(),/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL|WITH\s+scoped\s+AS|COMMIT|ROLLBACK)\b/i);
   assert.doesNotMatch(s,/\b(?:UPDATE|INSERT|DELETE|FOR\s+SHARE|decrypted_secrets)\b/i);
   const out=await c.query(s,p);
   if(s.startsWith('BEGIN')){
    const a=(await c.query("SELECT current_setting('transaction_isolation') AS mode,current_setting('transaction_read_only') AS ro")).rows[0];
    assert.deepEqual(a,{mode:'repeatable read',ro:'on'});transactionCount++;
   }
   return out;
  },release:(discard?:boolean)=>c.release(discard)};
 }});
 try{
  await pool.query(`CREATE SCHEMA private;
  CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,kalshi_connection_id uuid,key_fingerprint text,commissioned boolean,kill_switch boolean,blocked_reason text,cash_precision_verified boolean,cash_micros bigint,initial_cash_micros bigint,reserved_micros bigint,policy_id text,subaccount int,exchange_index int,execution_enabled boolean);
  CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,created_by text,state text,fee_policy_version text);
  CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,fencing_token bigint,holder_id text,state text,arm_requested boolean,account_kill boolean,credential_fingerprint text);
  CREATE TABLE public.financial_accounts(id uuid,user_id uuid,provider text);
  CREATE TABLE private.provider_connections(id uuid,financial_account_id uuid);
  CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,key_fingerprint text,vault_secret_id uuid);
  CREATE TABLE public.v13_production_position(account_id text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
  CREATE TABLE public.v13_production_intent(account_id text,terminal boolean,state text,reserved_micros bigint,request jsonb,created_at timestamptz,id text,kind text,client_order_id text,exchange_order_id text,filled_hundredths bigint);
  CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);`);
  await pool.query("INSERT INTO public.v13_production_account VALUES($1,$2,$3,$4,true,false,NULL,true,25000000,25000000,0,'policy',1,2,true)",[account,owner,fa,fingerprint]);
  await pool.query("INSERT INTO public.v13_live_money_policy VALUES('policy',$1,$2,'APPROVED','fee')",[account,owner]);
  await pool.query("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[fa,owner]);
  await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[pc,fa]);
  await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,'restricted_execution',NULL,now(),'credential_verified',$4,$5)",[owner,fa,pc,fingerprint,vault]);
  await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,24,'held','released',false,false,$3)",[account,owner,fingerprint]);
  const clean=await read(owner);assert.equal(clean?.status,'LOCAL_STOP_SCOPE_ONLY');assert.equal(clean?.cashMismatchHold,false);
  assert.equal(await read(other),null);
  await pool.query("UPDATE public.v13_production_account SET blocked_reason='production_external_cash_mismatch'");
  const held=await read(owner);assert.equal(held?.cashMismatchHold,true);assert.notEqual(clean?.fence,held?.fence);
  assert.equal(held?.holdCleared,false);assert.equal(held?.tradingAuthorized,false);
  await pool.query("UPDATE private.kalshi_account_worker_lease SET state='owned'");
  assert.equal(await read(owner),null,'protective owner still owns lease');
  await pool.query("UPDATE private.kalshi_account_worker_lease SET state='released'");
  assert.notEqual((await read(owner))?.fence,held?.fence,'lease ABA changes fence');
  await pool.query("INSERT INTO public.v13_production_intent(account_id,terminal,state,reserved_micros) VALUES($1,true,'UNKNOWN',0)",[account]);
  assert.equal(await read(owner),null,'UNKNOWN is not terminal for diagnostic purposes');
  await pool.query("DELETE FROM public.v13_production_intent");
  await pool.query("INSERT INTO private.strata_emergency_exit_reservations VALUES($1,'DISPATCHED')",[account]);
  assert.equal(await read(owner),null,'in-flight protective exit');
  await pool.query("DELETE FROM private.strata_emergency_exit_reservations");
  await pool.query("INSERT INTO public.v13_production_position(account_id,quantity_hundredths) VALUES($1,-1)",[account]);
  assert.equal(await read(owner),null,'signed nonzero quantity');
  await pool.query("DELETE FROM public.v13_production_position");
  await pool.query("UPDATE public.v13_production_account SET exchange_index=1");
  assert.equal(await read(owner),null,'wrong exchange index');
  await pool.query("UPDATE public.v13_production_account SET exchange_index=2");
  assert.equal((await read(owner))?.status,'LOCAL_STOP_SCOPE_ONLY');
  scheduled=true;assert.equal(await read(owner),null);
  assert.ok(transactionCount>=10);
 }finally{await pool.end();}
});
