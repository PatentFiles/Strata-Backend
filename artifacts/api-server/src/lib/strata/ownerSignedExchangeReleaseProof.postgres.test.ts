import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {inspectOwnerSignedExchangeReleaseProof,OWNER_SIGNED_PROOF_ACCOUNT_SQL} from './ownerSignedExchangeReleaseProof';

test('owner signed diagnostic uses concurrent committed row revisions without locks or authority writes',async()=>{
 assert.ok(process.env.V13_DISPOSABLE_DATABASE_URL,'isolated runner required');
 const owner='11111111-1111-4111-8111-111111111111',account='main',fa='22222222-2222-4222-8222-222222222222',pc='33333333-3333-4333-8333-333333333333';
 const at=Date.parse('2026-10-31T15:00:00Z');let now=at;
 const reader=await pool.connect(),writer=await pool.connect();
 const rewrite=(s:string)=>s.replaceAll('public.','proof_public.').replaceAll('private.','proof_private.');
 const q=(s:string,p?:unknown[])=>writer.query(rewrite(s),p);
 const db={query:async(s:string,p?:unknown[])=>{assert.doesNotMatch(s,/\b(UPDATE|INSERT|DELETE|FOR UPDATE|FOR SHARE)\b/i);return reader.query(rewrite(s),p)}};
 try{
 await q(`CREATE SCHEMA proof_public;CREATE SCHEMA proof_private;
 CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,kalshi_connection_id uuid,key_fingerprint text,commissioned boolean,kill_switch boolean,blocked_reason text,cash_precision_verified boolean,cash_micros bigint,reserved_micros bigint,policy_id text,subaccount int,exchange_index int,execution_enabled boolean);
 CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,created_by text,state text,fee_policy_version text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,fencing_token bigint,holder_id text,state text,arm_requested boolean,account_kill boolean);
 CREATE TABLE public.financial_accounts(id uuid,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid,financial_account_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,key_fingerprint text,vault_secret_id uuid);
 CREATE TABLE public.v13_production_position(account_id text,quantity_hundredths bigint);
 CREATE TABLE public.v13_production_intent(account_id text,terminal boolean,state text,reserved_micros bigint,request jsonb,created_at timestamptz,id text,evaluation_id text);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text,market_ticker text);`);
 await q("INSERT INTO public.v13_production_account VALUES($1,$2,$3,'key',true,false,NULL,true,25000000,0,'policy',1,2,true)",[account,owner,fa]);
 await q("INSERT INTO public.v13_live_money_policy VALUES('policy',$1,$2,'APPROVED','fee')",[account,owner]);
 await q("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[fa,owner]);await q('INSERT INTO private.provider_connections VALUES($1,$2)',[pc,fa]);
 await q("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,'restricted_execution',NULL,now(),'credential_verified','key',$4)",[owner,fa,pc,'44444444-4444-4444-8444-444444444444']);
 const addLease=()=>q("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,24,'held','released',false,false)",[account,owner]);await addLease();
 // Match reviewed production index shapes. Disabling seqscan locally tests
 // index eligibility, not a production latency/performance claim.
 await q(`CREATE UNIQUE INDEX account_pair ON public.v13_production_account(owner_user_id,subaccount,exchange_index) WHERE owner_user_id IS NOT NULL;
 CREATE UNIQUE INDEX policy_id ON public.v13_live_money_policy(id);
 CREATE UNIQUE INDEX lease_account ON private.kalshi_account_worker_lease(execution_account_id);
 CREATE UNIQUE INDEX financial_id ON public.financial_accounts(id);
 CREATE UNIQUE INDEX provider_id_account ON private.provider_connections(id,financial_account_id);
 CREATE INDEX credential_owner ON private.kalshi_connection_credentials(owner_user_id,provider_connection_id);
 CREATE INDEX owned_positions ON public.v13_production_position(account_id) WHERE quantity_hundredths>0;
 CREATE UNIQUE INDEX account_intents ON public.v13_production_intent(account_id,evaluation_id);
 CREATE INDEX unresolved_exits ON private.strata_emergency_exit_reservations(execution_account_id,market_ticker) WHERE state IN ('PREPARED','DISPATCHED','UNKNOWN');`);
 await reader.query('BEGIN');await reader.query('SET LOCAL enable_seqscan=off');
 const plan=JSON.stringify((await reader.query('EXPLAIN (FORMAT JSON) '+rewrite(OWNER_SIGNED_PROOF_ACCOUNT_SQL),[owner])).rows);
 await reader.query('ROLLBACK');
 for(const name of ['owned_positions','account_intents','unresolved_exits'])assert.ok(plan.includes(name),name);
 assert.doesNotMatch(OWNER_SIGNED_PROOF_ACCOUNT_SQL,/production_observation|jsonb_agg|string_agg|FOR UPDATE|FOR SHARE/i);
 console.log('Exact held revision query: indexed position/intent/unresolved-exit probes eligible; no history aggregate');
 let mutate:()=>Promise<unknown>=async()=>{},late:()=>Promise<unknown>=async()=>{};let reads=0;
 const run=()=>inspectOwnerSignedExchangeReleaseProof(owner,{db,now:()=>now,material:async()=>({keyId:'fixture',privateKey:'fixture'}),
  read:async()=>{reads++;await mutate();return {ok:true,observedAtMs:at,cashMicros:'25000000',orders:[],fills:[],positions:[],settlements:[]}},
  feeProbe:async()=>({ok:true}),v4:async()=>{await late();return {ok:true,checks:{protectiveExitRelease:false,ownerShaApproval:false}}}
 } as never);
 assert.equal((await run()).ok,true,'STOP while saved execution_enabled=true');
 const races=[
  "UPDATE private.kalshi_account_worker_lease SET arm_requested=true",
  "UPDATE private.kalshi_account_worker_lease SET arm_requested=true; UPDATE private.kalshi_account_worker_lease SET arm_requested=false",
  "UPDATE private.kalshi_account_worker_lease SET fencing_token=26",
  "UPDATE private.kalshi_connection_credentials SET revoked_at=now(); UPDATE private.kalshi_connection_credentials SET revoked_at=NULL",
  "UPDATE private.kalshi_connection_credentials SET key_fingerprint='new'",
  "UPDATE public.financial_accounts SET provider='kalshi'",
  "UPDATE private.provider_connections SET financial_account_id=financial_account_id",
  "UPDATE public.v13_production_account SET cash_micros=cash_micros",
  "INSERT INTO public.v13_production_position VALUES('main',100)",
  "INSERT INTO private.strata_emergency_exit_reservations (execution_account_id,state) VALUES('main','UNKNOWN')"
 ];
 for(const sql of races){
  mutate=async()=>{for(const statement of sql.split(";").filter(x=>x.trim()))await q(statement)};const result=await run();assert.equal(result.ok,false,sql);assert.equal(result.reason,'account_changed_during_signed_diagnostic',sql);assert.equal(result.signedExchangeReadAttempted,true);
  await q("UPDATE private.kalshi_account_worker_lease SET arm_requested=false,state='released';UPDATE private.kalshi_connection_credentials SET key_fingerprint='key',revoked_at=NULL;DELETE FROM public.v13_production_position;DELETE FROM private.strata_emergency_exit_reservations");
 }
 mutate=async()=>{};late=async()=>{await q('UPDATE private.kalshi_account_worker_lease SET arm_requested=true')};assert.equal((await run()).ok,false,'post-fee/readiness race caught');
 await q('UPDATE private.kalshi_account_worker_lease SET arm_requested=false');late=async()=>{now=at+45001};assert.equal((await run()).reason,'signed_exchange_read_stale');now=at;late=async()=>{};
 await q('DELETE FROM private.kalshi_account_worker_lease;UPDATE public.v13_production_account SET kill_switch=true');assert.equal((await run()).ok,true,'legitimate KILL no-worker onboarding');
 mutate=addLease;assert.equal((await run()).reason,'account_changed_during_signed_diagnostic','absent worker created during read');
 mutate=async()=>{};assert.equal((await run()).ok,true,'existing KILL released worker');
 await q("UPDATE private.kalshi_account_worker_lease SET state='owned'");const before=reads;assert.equal((await run()).ok,false);assert.equal(reads,before,'unsafe killed worker never loads exchange');
 }finally{reader.release();writer.release();await pool.end();}
});
