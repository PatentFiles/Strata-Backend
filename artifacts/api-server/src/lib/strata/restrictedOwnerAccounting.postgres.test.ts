import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {digest,type Request} from '../v13-production/types';
import {dedicatedSignerFingerprint} from './commissioning';
import {readOwnedKalshiFeeds} from './personalExchangeRead';
import {fenceOwnerUnknownForAccounting} from './ownerUnknownRecoveryFence';
import {createHeldUnknownAccountingRecovery} from './ownerUnknownRecoveryHeld';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION} from './ownerUnknownRecoveryPlan';
import {activityTables,installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';
import {observeNativeQueryErrors,seedRestrictedInactiveActivity} from './restrictedProtectiveRuntime.fixture';

// TEST ONLY: full application migration chain, fake GET evidence, ephemeral key.
// No worker, activation, POST, provider account or production credential exists.
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url));
const NativePool=pool.constructor as new(config:{connectionString:string;max:number;connectionTimeoutMillis?:number})=>Pool;
const setup=new NativePool({connectionString:url,max:3}),db=pool;
const role='restricted_owner_accounting';
const queryFailures:Array<{sqlstate:string;operation:string;objects:string[]}>=[];
globalThis.fetch=async()=>{throw Error('restricted_accounting_external_io_forbidden');};
const readTables=[
 'public.v13_production_account','public.v13_live_money_policy','public.v13_production_intent',
 'public.v13_production_position','public.v13_production_event','public.v13_production_observation',
 'public.financial_accounts','private.provider_connections','private.kalshi_connection_credentials',
 'private.kalshi_account_worker_lease',...activityTables.map(table=>`private.${table}`),
];
const lockOnly:Record<string,string>={
 'public.v13_live_money_policy':'id','public.financial_accounts':'id',
 'private.provider_connections':'id','private.kalshi_connection_credentials':'id',
 ...Object.fromEntries(activityTables.map(table=>[`private.${table}`,'execution_account_id'])),
};
const updates:Record<string,string[]>={
 'public.v13_production_account':['cash_micros','reserved_micros','blocked_reason','revision','reconciled_at','evidence_digest','kill_switch','execution_enabled'],
 'public.v13_production_intent':['state','exchange_order_id','filled_hundredths','reserved_micros','terminal'],
 'public.v13_production_position':['quantity_hundredths','basis_micros','realized_pnl_micros'],
 'private.kalshi_account_worker_lease':['state','account_kill','arm_requested','fencing_token','released_at','heartbeat_at'],
};
async function installRuntime(){
 const parsed=new URL(url!);
 assert.deepEqual((await setup.query(`SELECT current_database() AS name,session_user AS user,
  host(inet_server_addr()) AS host,inet_server_port() AS port`)).rows[0],
  {name:parsed.pathname.slice(1),user:'v13_test',host:'127.0.0.1',port:Number(parsed.port)});
 await setup.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  GRANT USAGE ON SCHEMA public,private TO ${role}`);
 // Explicit disposable-only corrections for the same two source/catalog RLS
 // differences qualified in PR323. No other schema/platform RLS changes.
 for(const table of ['private.kalshi_owner_pilot_transfers','private.kalshi_owner_shard_allocations']){
  assert.equal((await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,false);
  await setup.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
 }
 for(const table of readTables){
  assert.equal((await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true);
  await setup.query(`GRANT SELECT ON ${table} TO ${role};
   CREATE POLICY accounting_read ON ${table} FOR SELECT TO ${role} USING(true)`);
 }
 for(const [table,column] of Object.entries(lockOnly))await setup.query(`
  GRANT UPDATE(${column}) ON ${table} TO ${role};
  CREATE POLICY accounting_lock ON ${table} FOR UPDATE TO ${role} USING(true) WITH CHECK(true);
  CREATE POLICY accounting_no_metadata_write ON ${table} AS RESTRICTIVE FOR UPDATE TO ${role} USING(true) WITH CHECK(false)`);
 for(const [table,columns] of Object.entries(updates))await setup.query(`
  GRANT UPDATE(${columns.join(',')}) ON ${table} TO ${role};
  CREATE POLICY accounting_update ON ${table} FOR UPDATE TO ${role} USING(true) WITH CHECK(true)`);
 // Bounded killed-account semantics, not a general production policy design.
 await setup.query(`CREATE POLICY accounting_never_reenable ON public.v13_production_account AS RESTRICTIVE FOR UPDATE
  TO ${role} USING(true) WITH CHECK(kill_switch=true AND execution_enabled=false);
  CREATE POLICY accounting_never_rearm ON private.kalshi_account_worker_lease AS RESTRICTIVE FOR UPDATE
  TO ${role} USING(true) WITH CHECK(state='killed' AND account_kill=true AND arm_requested=false)`);
 for(const table of ['public.v13_production_event','public.v13_production_observation'])await setup.query(`
  GRANT INSERT ON ${table} TO ${role}; CREATE POLICY accounting_insert ON ${table} FOR INSERT TO ${role} WITH CHECK(true)`);
 parsed.username=role;
 const runtime=new NativePool({connectionString:parsed.toString(),max:4,connectionTimeoutMillis:5000});
 runtime.on('connect',client=>observeNativeQueryErrors(client,readTables,failure=>{if(queryFailures.length<32)queryFailures.push(failure);}));
 runtime.on('error',(error:Error)=>{throw error;});
 let closing:Promise<void>|undefined;const close=()=>closing??=runtime.end();
 try{
  assert.deepEqual((await runtime.query(`SELECT current_user AS name,session_user AS session,rolsuper,rolcreatedb,
   rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0],
   {name:role,session:role,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
  await pool.end();pool.query=runtime.query.bind(runtime) as typeof pool.query;
  pool.connect=runtime.connect.bind(runtime) as typeof pool.connect;pool.end=close as typeof pool.end;
 }catch(error){await close();throw error;}
}
const owner='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
const financial='33333333-3333-4333-8333-333333333333',provider='44444444-4444-4444-8444-444444444444';
const secret='55555555-5555-4555-8555-555555555555',credential='66666666-6666-4666-8666-666666666666';
const account='full-schema-synthetic',hash='a'.repeat(64),policy='full-schema-policy';
const material={keyId:'offline-full-schema-only',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const fingerprint=dedicatedSignerFingerprint(material.keyId,material.privateKey)!;
const request:Request={market:'KXBTC15M-SYNTHETIC',side:'NO',action:'BUY',contracts:3,limitMicros:430000,
 timeInForce:'IOC',reduceOnly:false,clientOrderId:`v13p-${target}`};
const input={ownerId:owner,targetIntentId:target,confirmation:OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION};

async function reset(){
 const db=setup;
 queryFailures.length=0;
 // Fresh disposable cluster only. TRUNCATE is fixture reset, not a recovery path.
 await db.query(`TRUNCATE public.v13_production_account,public.v13_live_money_policy,
  public.financial_accounts,auth.users,vault.secrets,public.forward_test_evaluations CASCADE`);
 await db.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,\'owner@example.invalid\',now())',[owner]);
 await db.query('INSERT INTO vault.secrets(id) VALUES($1)',[secret]);
 await db.query('INSERT INTO public.financial_accounts(id,user_id,provider) VALUES($1,$2,\'kalshi\')',[financial,owner]);
 await db.query('INSERT INTO private.provider_connections(id,financial_account_id) VALUES($1,$2)',[provider,financial]);
 await db.query(`INSERT INTO private.kalshi_connection_credentials(id,owner_user_id,financial_account_id,
  provider_connection_id,role,vault_secret_id,key_fingerprint,verified_at,verification_reason)
  VALUES($1,$2,$3,$4,'restricted_execution',$5,$6,now(),'credential_verified')`,[credential,owner,financial,provider,secret,fingerprint]);
 await db.query(`INSERT INTO public.v13_production_account(id,owner_user_id,kalshi_connection_id,subaccount,
  exchange_index,key_fingerprint,cash_micros,reserved_micros,initial_cash_micros,revision,blocked_reason)
  VALUES($1,$2,$3,1,2,$4,25000000,6000000,25000000,7,'personal_exchange_history_unreconciled')`,[account,owner,financial,fingerprint]);
 await db.query(`INSERT INTO public.v13_live_money_policy(id,version,state,execution_account_id,created_by,
  champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,champion_selected_at,
  capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_daily_loss_cents,max_total_loss_cents,
  max_quote_age_ms,max_fee_evidence_age_ms,fee_policy_version,fee_source_url,fee_formula_version,
  approved_by,approved_at,policy_hash)
  VALUES($1,1,'APPROVED',$2,$3,'offline-review',$4,$3,now(),2500,500,600,500,500,
   1000,1000,'synthetic-only','https://example.invalid/fee','synthetic-only',$3,now(),$4)`,[policy,account,owner,hash]);
 await db.query(`UPDATE public.v13_production_account SET policy_id=$2,commissioning_digest=$3,
  minimum_exit_micros=10000,commissioned=true,cash_precision_verified=true,kill_switch=false,execution_enabled=true WHERE id=$1`,[account,policy,hash]);
 await db.query(`INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,financial_account_id,
  provider_connection_id,holder_id,fencing_token,state,heartbeat_at,credential_fingerprint,vault_secret_id,arm_requested)
  VALUES($1,$2,$3,$4,'offline-worker',7,'owned',now()-interval '1 hour',$5,$6,true)`,[account,owner,financial,provider,fingerprint,secret]);
 await db.query(`INSERT INTO public.forward_test_evaluations(id,evaluated_at,market_ticker,btc_price,target,signed_buffer,
  absolute_buffer,seconds_remaining,feed_freshness,previous_side,current_side,fresh_cross,crossing_consumed,
  signal,direction,qualifying_trigger,reason,position_was_open)
  VALUES('offline-evaluation',now()-interval '2 minutes',$1,100,101,-1,1,100,'fresh','UP','DOWN',true,false,
   'CONFIRM','DOWN',true,'synthetic-only',false)`,[request.market]);
 const decision={},capability=digest({id:target,request,decision,policyHash:hash,fee:hash});
 await db.query(`INSERT INTO public.v13_production_intent(id,account_id,evaluation_id,crossing_key,kind,market,side,state,
  request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,exchange_order_id,
  reserved_micros,exit_fee_micros,created_at,dispatch_at)
  VALUES($1,$2,'offline-evaluation','offline-crossing','ENTRY',$3,'NO','UNKNOWN',$4::jsonb,'{}',$5,$5,$6,$7,
   'offline-order',6000000,50000,now()-interval '100 seconds',now()-interval '100 seconds')`,
  [target,account,request.market,JSON.stringify(request),hash,capability,request.clientOrderId]);
 await db.query(`INSERT INTO public.v13_production_position(id,account_id,market,side) VALUES($1,$2,$3,'NO')`,[target,account,request.market]);
}
async function frozen(){
 const fence=await fenceOwnerUnknownForAccounting(input,{db,isScheduled:()=>false});
 assert.equal(fence.ok,true,JSON.stringify(fence));return {...input,fenceReceiptId:fence.attemptId!};
}
function recovery(zeroFill=false,database=db,beforeBalance?:()=>Promise<void>){
 let signers=0,reads=0;
 const recover=createHeldUnknownAccountingRecovery({db:database,now:Date.now,isScheduled:()=>false,
  material:async()=>{signers++;return material;},readFeeds:(creds,at)=>readOwnedKalshiFeeds(creds,at,async(_material,path)=>{
   reads++;
   if(path.endsWith('/balance')){await beforeBalance?.();return {balance_dollars:zeroFill?'25.0000':'23.7200',subaccount:1,exchange_index:2};}
   if(path.includes('/historical/'))return {orders:[],fills:[],cursor:''};
   if(path.endsWith('/orders'))return {orders:[{order_id:'offline-order',client_order_id:request.clientOrderId,
    ticker:request.market,status:zeroFill?'canceled':'executed',book_side:'ask',side:'no',action:'buy',
    yes_price_dollars:'0.5700',initial_count_fp:'3.00',fill_count_fp:zeroFill?'0.00':'3.00'}],cursor:''};
   if(path.endsWith('/fills'))return {fills:zeroFill?[]:[{trade_id:'offline-fill',order_id:'offline-order',ticker:request.market,
    count_fp:'3.00',yes_price_dollars:'0.5900',no_price_dollars:'0.4100',fee_cost:'0.0500',ts:Math.floor((at-99000)/1000)}],cursor:''};
   if(path.endsWith('/positions'))return {market_positions:[],cursor:''};
   if(path.endsWith('/settlements'))return {settlements:zeroFill?[]:[{ticker:request.market,yes_count_fp:'0.00',no_count_fp:'3.00',
    market_result:'yes',revenue:0,settled_time:new Date(at-50000).toISOString()}],cursor:''};
   throw Error('unexpected_provider_path');
  })});
 return {recover,signers:()=>signers,reads:()=>reads};
}
async function financialState(){
 const db=setup;
 const result={};for(const table of ['v13_production_account','v13_production_intent','v13_production_position',
  'v13_production_event','v13_production_observation']){
  Object.assign(result,{[table]:(await db.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows});
 }
 Object.assign(result,{lease:(await db.query('SELECT to_jsonb(t) AS row FROM private.kalshi_account_worker_lease t')).rows,
  trace:(await db.query('SELECT to_jsonb(t) AS row FROM private.strata_v13_execution_trace t ORDER BY trace_id')).rows});
 return result;
}
function wrapped(hook:(sql:string,args:unknown[]|undefined,invoke:()=>Promise<unknown>,client:PoolClient)=>Promise<unknown>):Pool{
 return {query:db.query.bind(db),connect:async()=>{
  const client=await db.connect();
  return new Proxy(client,{get(target,key){
   if(key==='query')return (sql:string,args?:unknown[])=>hook(sql,args,()=>client.query(sql,args),client);
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
 }} as unknown as Pool;
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function reached(signal:Promise<void>,operation:Promise<unknown>){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([signal,operation.then(result=>{throw Error('recovery_finished_before_lock_hook: '+JSON.stringify(result));}),
  new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('lock_hook_timeout')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}
}
const detail=(result:unknown)=>JSON.stringify({result,queryFailures});
async function unchangedAfter(work:()=>Promise<{ok:boolean}>,before?:Awaited<ReturnType<typeof financialState>>){
 const expected=before??await financialState();
 const result=await work();assert.equal(result.ok,false,detail(result));assert.deepEqual(await financialState(),expected);return result;
}
async function waitForDatabaseLock(pid:number){
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){
  const row=(await setup.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
  if(row?.wait_event_type==='Lock')return;
  await delay(10);
 }
 assert.fail('synthetic competing writer did not reach a PostgreSQL lock wait');
}
async function raceWriter(sql:string,args:unknown[],seedInactive:boolean){
 await reset();if(seedInactive)await seedRestrictedInactiveActivity(setup,account,owner);
 const held=await frozen(),entered=deferred(),resume=deferred();let paused=false;
 const writer=await setup.connect();
 const operation=recovery(false,wrapped(async(statement,_args,invoke)=>{
  if(!paused&&statement.startsWith('INSERT INTO v13_production_event')){paused=true;entered.resolve();await resume.promise;}
  return invoke();
 })).recover(held);
 let write:Promise<unknown>|undefined,settled=false;
 try{
  await reached(entered.promise,operation);
  const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await writer.query("SET statement_timeout='8s'");
  write=writer.query(sql,args).then(result=>{settled=true;return result;});
  void write.catch(()=>{});
  await waitForDatabaseLock(pid);assert.equal(settled,false);
  resume.resolve();const result=await operation;assert.equal(result.ok,true,detail(result));
  await write;assert.equal(settled,true);
 }finally{
  resume.resolve();await Promise.allSettled([operation,...(write?[write]:[])]);writer.release(true);
 }
}

test('restricted owner accounting: real killed ledger recovery without execution authority',{timeout:120000},async t=>{
 try{
  const bootstrap=await setup.connect();try{await installFullRecoverySchema(bootstrap);}finally{bootstrap.release();}
  await installRuntime();
  await t.test('real LOGIN cannot regain bootstrap or issue policy, intent, lease or reservation rows',async()=>{
   await reset();
   const client=await db.connect();try{
    await client.query('RESET ROLE');
    assert.deepEqual((await client.query('SELECT current_user AS name,session_user AS session')).rows[0],{name:role,session:role});
    for(const targetRole of ['v13_test','unknown_recovery_backend'])await assert.rejects(client.query(`SET ROLE ${targetRole}`),{code:'42501'});
   }finally{client.release();}
   for(const table of ['public.v13_live_money_policy','public.v13_production_intent','private.kalshi_account_worker_lease','private.strata_emergency_exit_reservations','private.strata_owner_sha_approvals']){
    await assert.rejects(db.query(`INSERT INTO ${table} DEFAULT VALUES`),{code:'42501'});
    assert.equal((await db.query("SELECT has_table_privilege(current_user,$1,'DELETE') AS allowed",[table])).rows[0].allowed,false);
   }
   await assert.rejects(db.query('SELECT * FROM vault.secrets'),{code:'42501'});
  });
  await t.test('missing kill-column privilege fails atomically before receipt or accounting',async()=>{
   await reset();await setup.query(`REVOKE UPDATE(kill_switch) ON public.v13_production_account FROM ${role}`);
   try{
    await unchangedAfter(()=>fenceOwnerUnknownForAccounting(input,{db,isScheduled:()=>false}));
    assert(queryFailures.some(f=>f.sqlstate==='42501'&&f.operation==='UPDATE'&&f.objects.includes('public.v13_production_account')));
   }finally{await setup.query(`GRANT UPDATE(kill_switch) ON public.v13_production_account TO ${role}`);}
  });
  await t.test('owner confirmation and durable kill are required before loading synthetic material',async()=>{
   await reset();const r=recovery();
   await unchangedAfter(()=>fenceOwnerUnknownForAccounting({...input,confirmation:'invalid'},{db,isScheduled:()=>false}));
   await unchangedAfter(()=>fenceOwnerUnknownForAccounting({...input,ownerId:'99999999-9999-4999-8999-999999999999'},{db,isScheduled:()=>false}));
   await unchangedAfter(()=>r.recover({...input,fenceReceiptId:'99999999-9999-4999-8999-999999999999'}));
   assert.equal(r.signers(),0);assert.equal(r.reads(),0);
  });
  await t.test('native losing settlement reconciles under restricted role and preserves kill and freeze',async()=>{
   await reset();const held=await frozen(),r=recovery();const result=await r.recover(held);
   assert.equal(result.ok,true,detail(result));assert.equal(r.signers(),1);assert.equal(r.reads(),7);
   assert.deepEqual((await db.query(`SELECT cash_micros::text,reserved_micros::text,kill_switch,execution_enabled,blocked_reason
    FROM public.v13_production_account WHERE id=$1`,[account])).rows[0],
    {cash_micros:'23720000',reserved_micros:'0',kill_switch:true,execution_enabled:false,blocked_reason:'personal_exchange_history_unreconciled'});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM public.v13_production_event')).rows[0].n,2);
   assert.equal((await setup.query("SELECT count(*)::int AS n FROM private.strata_v13_execution_trace WHERE kind='EXCHANGE_EVENT'")).rows[0].n,2);
   await unchangedAfter(()=>r.recover(held));
   for(const sql of ["UPDATE public.v13_production_account SET kill_switch=false", "UPDATE public.v13_production_account SET execution_enabled=true", "UPDATE private.kalshi_account_worker_lease SET arm_requested=true", "UPDATE private.kalshi_account_worker_lease SET state='owned',account_kill=false"]){
    await assert.rejects(db.query(sql),(e:unknown)=>{assert.equal((e as {code:string}).code,'42501');assert.match((e as Error).message,/row-level security/);return true;});
   }
  });
  await t.test('zero-fill cancellation releases reserve without a fill event or activation',async()=>{
   await reset();const result=await recovery(true).recover(await frozen());assert.equal(result.ok,true,detail(result));
   assert.equal((await db.query('SELECT count(*)::int AS n FROM public.v13_production_event')).rows[0].n,0);
   assert.equal((await db.query('SELECT reserved_micros::text FROM public.v13_production_account')).rows[0].reserved_micros,'0');
   assert.equal((await db.query('SELECT account_kill FROM private.kalshi_account_worker_lease')).rows[0].account_kill,true);
  });
  await t.test('a changed fencing token during GET collection refuses all financial writes',async()=>{
   await reset();const held=await frozen(),before=await financialState();
   const r=recovery(false,db,async()=>{await setup.query('UPDATE private.kalshi_account_worker_lease SET fencing_token=fencing_token+1');});
   const result=await r.recover(held);assert.equal(result.ok,false,detail(result));
   assert.equal(result.reason,'recovery_kill_receipt_binding_changed');
   const after=await financialState();
   assert.deepEqual({...after,lease:undefined},{...before,lease:undefined});
  });
  await t.test('missing accounting permission rolls back native ledger, events and trace outbox',async()=>{
   await reset();const held=await frozen();await setup.query(`REVOKE UPDATE(cash_micros) ON public.v13_production_account FROM ${role}`);
   try{
    await unchangedAfter(()=>recovery().recover(held));
    assert(queryFailures.some(f=>f.sqlstate==='42501'&&f.operation==='UPDATE'&&f.objects.includes('public.v13_production_account')));
   }finally{await setup.query(`GRANT UPDATE(cash_micros) ON public.v13_production_account TO ${role}`);}
  });
  await t.test('final receipt failure rolls back positively observed in-transaction trace and ledger rows',async()=>{
   await reset();const held=await frozen(),before=await financialState();let observed=false,observedTraceRows:number|undefined;
   // The append-only trace has no account FK, so account TRUNCATE deliberately
   // leaves earlier committed outbox rows. Observe only this transaction's new
   // rows while retaining the full historical snapshot for the rollback check.
   const traceBaseline=(await setup.query('SELECT COALESCE(max(trace_id),0)::text AS id FROM private.strata_v13_execution_trace')).rows[0].id;
   try{
   await setup.query(`GRANT SELECT ON private.strata_v13_execution_trace TO ${role};
    CREATE POLICY accounting_trace_diagnostic ON private.strata_v13_execution_trace FOR SELECT TO ${role} USING(execution_account_id='full-schema-synthetic');
    CREATE FUNCTION private.restricted_accounting_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF NEW.kind='OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION' THEN RAISE EXCEPTION 'synthetic_receipt_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER restricted_accounting_receipt_fault BEFORE INSERT ON public.v13_production_observation
     FOR EACH ROW EXECUTE FUNCTION private.restricted_accounting_receipt_fault()`);
    const result=await recovery(false,wrapped(async(sql,_args,invoke,client)=>{
     if(sql.includes("'OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION'")){
      observedTraceRows=(await client.query("SELECT count(*)::int AS n FROM private.strata_v13_execution_trace WHERE kind='EXCHANGE_EVENT' AND trace_id>$1::bigint",[traceBaseline])).rows[0].n;
      assert.equal(observedTraceRows,2);observed=true;
     }
     return invoke();
    })).recover(held);
    assert.equal(result.ok,false,detail(result));assert.equal(observed,true,detail({result,observedTraceRows}));assert.deepEqual(await financialState(),before);
   }finally{await setup.query(`DROP TRIGGER IF EXISTS restricted_accounting_receipt_fault ON public.v13_production_observation;
    DROP FUNCTION IF EXISTS private.restricted_accounting_receipt_fault();
    REVOKE SELECT ON private.strata_v13_execution_trace FROM ${role};DROP POLICY IF EXISTS accounting_trace_diagnostic ON private.strata_v13_execution_trace`);}
   await assert.rejects(db.query('SELECT * FROM private.strata_v13_execution_trace'),{code:'42501'});
  });
  const reactivations=[
   "UPDATE private.kalshi_owner_pilot_transfers SET state='attempted',completed_at=NULL WHERE execution_account_id=$1",
   "UPDATE private.kalshi_owner_shard_allocations SET state='attempted',completed_at=NULL,verified_at=NULL WHERE execution_account_id=$1",
   "UPDATE private.kalshi_owner_topups SET state='active',completed_at=NULL WHERE execution_account_id=$1",
   "UPDATE private.strata_auto_withdrawal_maintenance SET state='waiting_flat',completed_at=NULL WHERE execution_account_id=$1",
   "UPDATE private.strata_manual_profit_withdrawals SET state='prepared' WHERE execution_account_id=$1",
  ];
  for(const sql of reactivations)await t.test('inactive maintenance writer waits behind restricted recovery: '+sql.split(' ')[1],async()=>{
   await raceWriter(sql,[account],true);
  });
  await t.test('new reservation INSERT waits on the parent account FK until restricted recovery commits',async()=>{
   const reservation='99999999-9999-4999-8999-999999999999';
   await raceWriter(`INSERT INTO private.strata_emergency_exit_reservations
    (reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,
     quantity_hundredths,order_digest,worker_fencing_token,worker_holder_id,initial_position_fp,position_observed_at_ms,order_request_json)
    VALUES($1,$2,$3,'KXBTC15M-SYNTHETIC',$4,'NO',300,$5,8,'synthetic-adversary','-3.00',1,$6)`,
    [reservation,owner,account,'v13p-'+reservation,hash,JSON.stringify({synthetic:true,purpose:'FK-lock-only-no-order'})],false);
  });
  await t.test('lost COMMIT acknowledgment is reported unknown without pretending financial rollback',async()=>{
   await reset();const held=await frozen();let committed=0;
   const result=await recovery(false,wrapped(async(sql,_args,invoke)=>{
    const out=await invoke();if(sql==='COMMIT'){committed++;throw Error('synthetic_commit_ack_lost');}return out;
   })).recover(held);
   assert.equal(result.ok,false);assert.equal(result.reason,'recovery_accounting_commit_outcome_unverified');
   assert.equal((result as Record<string,unknown>).accountingCommitted,null);assert.equal((result as Record<string,unknown>).outcomeUnknown,true);assert.equal(committed,1);
   assert.equal((await db.query('SELECT reserved_micros::text FROM public.v13_production_account')).rows[0].reserved_micros,'0');
   assert.equal((await db.query("SELECT count(*)::int AS n FROM public.v13_production_observation WHERE kind='OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION'")).rows[0].n,1);
  });
 }finally{
  const ended=await Promise.allSettled([db.end(),setup.end()]);
  const failures=ended.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
  if(failures.length)throw new AggregateError(failures,'restricted_accounting_pool_cleanup_failed');
 }
});
