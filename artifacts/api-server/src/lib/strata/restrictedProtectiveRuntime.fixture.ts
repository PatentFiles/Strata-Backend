import assert from 'node:assert/strict';
import {pool,installPoolCheckoutTiming,type Pool,type PoolClient} from '@workspace/db';
import {auditUnseenExpiredSignals,recordLiveSignalDecision} from '../v13-production/signalDecisionTrace';
import {reserveKalshiBalanceReadSlot} from './kalshiBalanceQuota';

// DISPOSABLE EXPERIMENT ONLY. This is a trusted service-role compatibility
// probe, NOT tenant authorization or a deployable permission migration.
const runtimeRole='held_protective_runtime';
// Native constructor and exported types come from the existing workspace DB
// dependency, as in runtimeRoleMatrix.postgres.test.ts.
const NativePool=pool.constructor as new(config:{connectionString:string;max:number;connectionTimeoutMillis:number})=>Pool;
type DB=Pick<Pool,'query'>;
const lockOnly:Record<string,string>={
 'public.v13_live_money_policy':'id',
 'public.live_execution_config':'id',
 'public.forward_test_evaluations':'id',
 'public.financial_accounts':'id',
 'private.provider_connections':'id',
 'private.kalshi_connection_credentials':'id',
 'private.strata_api_fee_source_grants':'grant_id',
 'private.strata_api_fee_rate_reviews':'review_id',
 'private.strata_api_fee_owner_consents':'consent_id',
 'private.strata_protective_exit_release':'release_id',
 'private.strata_owner_sha_approvals':'approval_id',
 'private.strata_continuous_execution_grants':'grant_id',
 'private.strata_standing_execution_reviews':'release_id',
};
const reads=[
 ...Object.keys(lockOnly),
 'public.v13_production_account','public.v13_production_intent','public.v13_production_position',
 'public.v13_production_event','public.v13_production_observation',
 'private.kalshi_account_worker_lease','private.strata_emergency_exit_reservations',
 'private.strata_protective_exit_reconciliations','private.strata_protective_exit_local_no_send',
 'private.strata_v13_signal_audit_progress','private.strata_v13_signal_decisions',
 'private.strata_v13_signal_trace_scope','public.strata_configured_stake',
 'private.strata_kalshi_balance_read_slots',
 'private.strata_api_fee_standing_delegations',
 'auth.users','private.role_assignments','vault.decrypted_secrets',
 'private.kalshi_owner_pilot_transfers','private.kalshi_owner_shard_allocations',
 'private.kalshi_owner_topups','private.strata_auto_withdrawal_maintenance',
 'private.strata_manual_profit_withdrawals',
];
const updates:Record<string,string[]>={
 'private.strata_kalshi_balance_read_slots':['next_slot_at'],
 'public.v13_production_account':['cash_micros','reserved_micros','blocked_reason','revision','reconciled_at','evidence_digest'],
 'public.v13_production_intent':['state','exchange_order_id','filled_hundredths','reserved_micros','terminal','dispatch_at'],
 'public.v13_production_position':['quantity_hundredths','basis_micros','realized_pnl_micros'],
 'private.kalshi_account_worker_lease':['holder_id','fencing_token','state','heartbeat_at','released_at','account_kill','arm_requested','credential_fingerprint','vault_secret_id','provider_connection_id','financial_account_id'],
 'private.strata_emergency_exit_reservations':['state','updated_at'],
 'private.strata_v13_signal_audit_progress':['cycle_cutoff','cursor_evaluated_at','cursor_evaluation_id','cycle_started_at','last_success_at','sources_examined','decisions_inserted','last_completed_cycle_at','completed_cycles'],
};
const inserts=[
 'private.strata_kalshi_balance_read_slots',
 'public.v13_production_intent','public.v13_production_event','public.v13_production_observation',
 'private.kalshi_account_worker_lease','private.strata_emergency_exit_reservations',
 'private.strata_protective_exit_reconciliations','private.strata_protective_exit_local_no_send',
 'private.strata_v13_signal_audit_progress','private.strata_v13_signal_decisions',
];
const authority=[
 'private.strata_owner_sha_approvals','private.strata_protective_exit_release',
 'private.strata_protective_release_qualification','private.strata_api_fee_source_grants',
 'private.strata_api_fee_rate_reviews','private.strata_api_fee_owner_consents',
 'private.strata_api_fee_standing_models','private.strata_api_fee_standing_delegations',
 'private.strata_standing_execution_reviews','private.strata_continuous_execution_grants',
];
type QueryFailure={sqlstate:string;operation:string;objects:string[]};
const queryFailures:QueryFailure[]=[];
export function restrictedRuntimeDiagnostics(){return queryFailures.map(row=>({...row,objects:[...row.objects]}));}
export function beginRestrictedRuntimeDiagnostics(){queryFailures.length=0;}
// BEGIN QUERY ERROR OBSERVER
// TEST ONLY: retain no query text, parameters, error message/detail or values.
// Observe actual native client calls (including pool.query's callback path),
// preserving the original thrown/rejected/callback error object unchanged.
function observeNativeQueryErrors(target:{query:Function},relations:readonly string[],record:(failure:{sqlstate:string;operation:string;objects:string[]})=>void){
 const original=target.query;
 target.query=function(this:unknown,...args:unknown[]){
  const config=args[0];
  const sql=typeof config==='string'?config:
   config&&typeof config==='object'&&'text' in config&&typeof config.text==='string'?config.text:'';
  const operation=/^\s*(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET|RESET|ALTER)\b/i.exec(sql)?.[1]?.toUpperCase()??'OTHER';
  const objects=relations.filter(name=>{
   const bare=name.split('.').at(-1)!;
   return new RegExp('\\b'+bare+'\\b','i').test(sql);
  }).slice(0,6);
  const report=(error:unknown)=>{
   if(!error)return;
   try{
    const code=typeof error==='object'&&error!==null&&'code' in error?error.code:undefined;
    const sqlstate=typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?code:'NON_SQL_ERROR';
    record({sqlstate,operation,objects});
   }catch{/* Diagnostics never replace the original failure. */}
  };
  const callback=args.at(-1);
  if(typeof callback==='function')args[args.length-1]=function(this:unknown,...values:unknown[]){
   report(values[0]);return Reflect.apply(callback,this,values);
  };
  try{
   const result=Reflect.apply(original,this,args);
   if(typeof callback!=='function'&&result&&typeof result.then==='function'){
    return result.catch((error:unknown)=>{report(error);throw error;});
   }
   return result;
  }catch(error){report(error);throw error;}
 };
}
// END QUERY ERROR OBSERVER

function canonicalUrl(){
 const url=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url));
 return new URL(url);
}
async function denied(db:DB,sql:string,args:unknown[]=[],rls=false){
 await assert.rejects(db.query(sql,args),(e:unknown)=>{
  assert.equal((e as {code?:string}).code,'42501');
  if(rls)assert.match((e as Error).message,/row-level security policy/);
  return true;
 });
}

// Preserve the original assertion/query failure and always release a checkout,
// destroying it if ROLLBACK failed. No cleanup error may strand another client.
async function rollbackOnly(db:Pool,work:(client:PoolClient)=>Promise<void>){
 const client=await db.connect(),errors:unknown[]=[];
 let discard=false;
 try{await client.query('BEGIN');await work(client);}catch(error){errors.push(error);}
 finally{
  try{await client.query('ROLLBACK');}catch(error){discard=true;errors.push(error);}
  try{client.release(discard);}catch(error){errors.push(error);}
 }
 if(errors.length===1)throw errors[0];
 if(errors.length>1)throw new AggregateError(errors,'restricted_probe_and_cleanup_failed');
}

export async function installRestrictedProtectiveRuntime(setup:Pool){
 const url=canonicalUrl();
 const actual=(await setup.query(`SELECT current_database() AS name,session_user AS user,
  host(inet_server_addr()) AS host,inet_server_port() AS port`)).rows[0];
 assert.deepEqual(actual,{name:url.pathname.slice(1),user:'v13_test',host:'127.0.0.1',port:Number(url.port)});
 // installFullRecoverySchema has already checked and installed the full chain.
 await setup.query(`CREATE ROLE ${runtimeRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  GRANT USAGE ON SCHEMA public,private,auth,vault TO ${runtimeRole}`);
 for(const table of reads){
  await setup.query(`GRANT SELECT ON ${table} TO ${runtimeRole}`);
  const enabled=(await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity;
  // Do not silently enable RLS on platform/maintenance stubs. Those receive
  // SELECT only. Every lock-only or genuinely mutable table must already use RLS.
  if(enabled)await setup.query(`CREATE POLICY held_runtime_read ON ${table} FOR SELECT TO ${runtimeRole} USING(true)`);
 }
 for(const table of [...Object.keys(lockOnly),...Object.keys(updates),...inserts]){
  assert.equal((await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true,table+' must already enable RLS');
 }
 for(const [table,column] of Object.entries(lockOnly)){
  await setup.query(`GRANT UPDATE(${column}) ON ${table} TO ${runtimeRole};
   CREATE POLICY held_runtime_lock ON ${table} FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(true);
   CREATE POLICY held_runtime_no_authority_update ON ${table} AS RESTRICTIVE FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(false)`);
 }
 for(const [table,columns] of Object.entries(updates)){
  await setup.query(`GRANT UPDATE(${columns.join(',')}) ON ${table} TO ${runtimeRole};
   CREATE POLICY held_runtime_update ON ${table} FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(true)`);
 }
 for(const table of inserts){
  // New ENTRY creation is outside this protective-only fixture role.
  const check=table==='public.v13_production_intent'?"kind='EXIT'":'true';
  await setup.query(`GRANT INSERT ON ${table} TO ${runtimeRole};
   CREATE POLICY held_runtime_insert ON ${table} FOR INSERT TO ${runtimeRole} WITH CHECK(${check})`);
 }
 await setup.query(`GRANT EXECUTE ON FUNCTION private.strata_exit_request_quantity_hundredths(jsonb) TO ${runtimeRole}`);
 url.username=runtimeRole;
 const runtime=new NativePool({connectionString:url.toString(),max:10,connectionTimeoutMillis:10000});
 runtime.on('connect',client=>observeNativeQueryErrors(client,reads,failure=>{if(queryFailures.length<32)queryFailures.push(failure);}));
 let ending:Promise<void>|undefined;
 const closeRuntime=()=>ending??=runtime.end();
 installPoolCheckoutTiming(runtime);
 runtime.on('error',(error:Error)=>{throw error;});
 try{
  const identity=(await runtime.query(`SELECT current_user AS name,session_user AS session,
   rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
   FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.deepEqual(identity,{name:runtimeRole,session:runtimeRole,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
  assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`)).rows[0].n,0);
  // Close EVERY original privileged global checkout before replacing methods.
  // Helpers that default to the singleton now hit this same genuine LOGIN.
  await pool.end();
  pool.query=runtime.query.bind(runtime) as typeof pool.query;
  pool.connect=runtime.connect.bind(runtime) as typeof pool.connect;
  pool.end=closeRuntime as typeof pool.end;
  assert.equal((await pool.query('SELECT session_user AS name')).rows[0].name,runtimeRole);
  const c=await pool.connect();try{assert.equal((await c.query('SELECT session_user AS name')).rows[0].name,runtimeRole);}finally{c.release();}
 }catch(error){
  try{await closeRuntime();}catch(cleanup){throw new AggregateError([error,cleanup],'restricted_pool_setup_and_cleanup_failed');}
  throw error;
 }
}

export async function assertRestrictedAuthority(setup:Pool,accountId:string,ownerId:string){
 const table='private.strata_owner_sha_approvals';
 const before=(await setup.query(`SELECT * FROM ${table} ORDER BY approval_id`)).rows;
 assert.equal(before.length,1,'negative UPDATE probes must match a real approval');
 for(const relation of authority){
  const acl=(await pool.query(`SELECT has_table_privilege(current_user,$1,'INSERT') AS insert,
   has_table_privilege(current_user,$1,'UPDATE') AS update,
   has_table_privilege(current_user,$1,'DELETE') AS delete`,[relation])).rows[0];
  assert.deepEqual(acl,{insert:false,update:false,delete:false},relation);
 }
 // Demonstrate SELECT-only failure, then the EXACT row-locking operation.
 await setup.query(`REVOKE UPDATE(approval_id) ON ${table} FROM ${runtimeRole}`);
 try{await denied(pool,`SELECT approval_id FROM ${table} FOR SHARE`);}
 finally{await setup.query(`GRANT UPDATE(approval_id) ON ${table} TO ${runtimeRole}`);}
 await rollbackOnly(pool,async c=>{
  assert.equal((await c.query(`SELECT approval_id FROM ${table} FOR SHARE`)).rows.length,1);
  // A competing authorized fixture writer must be fenced by the runtime lock.
  await rollbackOnly(setup,async writer=>{
   await writer.query("SET LOCAL lock_timeout='100ms'");
   await assert.rejects(writer.query(`UPDATE ${table} SET revoked_at=clock_timestamp() WHERE approval_id=$1`,[before[0].approval_id]),{code:'55P03'});
  });
 });
 // A second permissive UPDATE policy must NOT defeat the restrictive barrier.
 await setup.query(`CREATE POLICY held_accidental_widening ON ${table} FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(true)`);
 try{
  await denied(pool,`UPDATE ${table} SET approval_id=approval_id WHERE approval_id=$1`,[before[0].approval_id],true);
  await denied(pool,`UPDATE ${table} SET approval_id=$2::uuid WHERE approval_id=$1`,[before[0].approval_id,'99999999-9999-4999-8999-999999999999'],true);
  assert.equal((await pool.query(`UPDATE ${table} SET approval_id=approval_id WHERE approval_id='99999999-9999-4999-8999-999999999999'`)).rowCount,0,'an absent row is distinct from a WITH CHECK refusal');
  // Invalid UUID is a parser/type rejection, not proof of RLS enforcement.
  await assert.rejects(pool.query(`UPDATE ${table} SET approval_id='not-a-uuid' WHERE approval_id=$1`,[before[0].approval_id]),{code:'22P02'});
  await denied(pool,`UPDATE ${table} SET owner_user_id='99999999-9999-4999-8999-999999999999' WHERE approval_id=$1`,[before[0].approval_id]);
  await denied(pool,`UPDATE ${table} SET revoked_at=clock_timestamp() WHERE approval_id=$1`,[before[0].approval_id]);
  await denied(pool,`INSERT INTO ${table} SELECT * FROM ${table}`);
  await denied(pool,`ALTER TABLE ${table} OWNER TO ${runtimeRole}`);
  await denied(pool,`UPDATE public.v13_production_account SET owner_user_id='99999999-9999-4999-8999-999999999999' WHERE id=$1`,[accountId]);
  await denied(pool,'SET ROLE unknown_recovery_backend');
  await denied(pool,'SET ROLE v13_test');
  const identityClient=await pool.connect();
  try{await identityClient.query('RESET ROLE');
   assert.deepEqual((await identityClient.query('SELECT current_user AS name,session_user AS session')).rows[0],{name:runtimeRole,session:runtimeRole});
  }finally{identityClient.release();}
 }finally{await setup.query(`DROP POLICY held_accidental_widening ON ${table}`);}
 assert.deepEqual((await setup.query(`SELECT * FROM ${table} ORDER BY approval_id`)).rows,before,'authority bytes unchanged');
 // The actual signed balance reader reserves this database quota BEFORE HTTP.
 // Prove the missing-INSERT failure directly rather than masking the production
 // reader's kalshi_read_failed result or bypassing its normal 1.2s spacing.
 const quota='private.strata_kalshi_balance_read_slots';
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quota}`)).rows[0].n,0);
 await setup.query(`REVOKE INSERT ON ${quota} FROM ${runtimeRole}`);
 try{
  await assert.rejects(reserveKalshiBalanceReadSlot('offline-supervisor-only',ownerId),{code:'42501'});
 }finally{await setup.query(`GRANT INSERT ON ${quota} TO ${runtimeRole}`);}
 await reserveKalshiBalanceReadSlot('offline-supervisor-only',ownerId);
 const first=(await pool.query(`SELECT next_slot_at FROM ${quota}`)).rows;
 assert.equal(first.length,1,'real quota INSERT must persist');
 await reserveKalshiBalanceReadSlot('offline-supervisor-only',ownerId);
 const second=(await pool.query(`SELECT next_slot_at FROM ${quota}`)).rows;
 assert.equal(second.length,1,'conflict path must update the same member bucket');
 assert(second[0].next_slot_at.getTime()>first[0].next_slot_at.getTime(),'real quota UPDATE advances the slot');
 await denied(pool,`UPDATE ${quota} SET budget_key='fixture-forbidden-key-change'`);
 // No blanket sequence privileges: direct access is denied while actual worker
 // and definer-trigger INSERTs must generate their identities normally.
 for(const sequence of ['private.strata_v13_execution_trace_trace_id_seq','private.strata_v13_signal_decisions_decision_id_seq']){
  await denied(pool,'SELECT nextval($1::regclass)',[sequence]);
  await denied(pool,'SELECT setval($1::regclass,1)',[sequence]);
 }
 for(const fn of ['begin_trace_scope','capture_intent','capture_event','capture_transport']){
  assert.equal((await pool.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed',[`private.strata_v13_${fn}()`])).rows[0].allowed,false);
 }
}

export async function assertRestrictedOutcome(setup:Pool,accountId:string){
 assert.deepEqual((await pool.query('SELECT current_user AS name,session_user AS session')).rows[0],{name:runtimeRole,session:runtimeRole});
 // Exercise optional telemetry explicitly: a green exit alone can hide its
 // caught permission errors. No extra runtime sequence ACL is introduced.
 await auditUnseenExpiredSignals(accountId);
 assert((await pool.query('SELECT last_success_at FROM private.strata_v13_signal_audit_progress WHERE execution_account_id=$1',[accountId])).rows[0]?.last_success_at);
 const evaluation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 await setup.query(`INSERT INTO public.forward_test_evaluations SELECT
  (jsonb_populate_record(NULL::public.forward_test_evaluations,to_jsonb(e)||jsonb_build_object('id',$1::text))).*
  FROM public.forward_test_evaluations e WHERE id='supervisor-source'`,[evaluation]);
 assert.equal(await recordLiveSignalDecision({accountId,evaluationId:evaluation,phase:'UNSEEN_IN_WINDOW'}),true);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM private.strata_v13_signal_decisions WHERE execution_account_id=$1 AND evaluation_id=$2',[accountId,evaluation])).rows[0].n,1);
 // Owner observation is NOT an extra runtime SELECT/INSERT permission.
 const trace=(await setup.query(`SELECT count(*)::int AS n FROM private.strata_v13_execution_trace
  WHERE execution_account_id=$1 AND details->>'orderKind'='EXIT'`,[accountId])).rows[0].n;
 assert(trace>0,'real restricted EXIT must trigger definer-owned trace inserts');
 // Temporary diagnostic visibility is deliberately NOT in the runtime grant
 // manifest. It is added only after the real scenario, scoped to this marker,
 // and revoked after inspecting the same transaction's uncommitted outbox.
 await denied(pool,'SELECT * FROM private.strata_v13_execution_trace');
 assert.equal(accountId,'full-schema-synthetic');
 try{
  await setup.query(`GRANT SELECT ON private.strata_v13_execution_trace TO ${runtimeRole};
   CREATE POLICY held_rollback_diagnostic ON private.strata_v13_execution_trace FOR SELECT
   TO ${runtimeRole} USING(details->>'exchangeOrderId'='fixture-rollback-only' AND execution_account_id='full-schema-synthetic')`);
  await rollbackOnly(pool,async tx=>{
   const changed=await tx.query(`UPDATE public.v13_production_intent SET exchange_order_id='fixture-rollback-only'
    WHERE account_id=$1 AND kind='EXIT' RETURNING id`,[accountId]);
   assert(changed.rows.length>0);
   assert.equal((await tx.query(`SELECT count(*)::int AS n FROM private.strata_v13_execution_trace
    WHERE execution_account_id=$1 AND details->>'exchangeOrderId'='fixture-rollback-only'`,[accountId])).rows[0].n,changed.rows.length,
    'real UPDATE trigger must insert an outbox row in this exact transaction');
  });
 }finally{
  await setup.query(`REVOKE SELECT ON private.strata_v13_execution_trace FROM ${runtimeRole};
   DROP POLICY IF EXISTS held_rollback_diagnostic ON private.strata_v13_execution_trace`);
 }
 assert.equal((await setup.query(`SELECT count(*)::int AS n FROM private.strata_v13_execution_trace WHERE execution_account_id=$1 AND details->>'exchangeOrderId'='fixture-rollback-only'`,[accountId])).rows[0].n,0,'the rolled-back trace cannot persist even if another audit finishes');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.v13_production_intent WHERE exchange_order_id='fixture-rollback-only'")).rows[0].n,0);
 await denied(pool,'SELECT * FROM private.strata_v13_execution_trace');
}
