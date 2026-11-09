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
import {activityTables,backendRole,installFullRecoverySchema,recoveryTables} from './ownerUnknownRecoverySchema.fixture';

const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
 'only the canonical freshly-created disposable PostgreSQL destination is allowed');
const NativePool=pool.constructor as new (config:{connectionString:string;options:string})=>Pool;
const db=new NativePool({connectionString:url,options:`-c role=${backendRole}`});
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
function recovery(zeroFill=false,database=db){
 let signers=0,reads=0;
 const recover=createHeldUnknownAccountingRecovery({db:database,now:Date.now,isScheduled:()=>false,
  material:async()=>{signers++;return material;},readFeeds:(creds,at)=>readOwnedKalshiFeeds(creds,at,async(_material,path)=>{
   reads++;
   if(path.endsWith('/balance'))return {balance_dollars:zeroFill?'25.0000':'23.7200',subaccount:1,exchange_index:2};
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
 const result={};for(const table of ['v13_production_account','v13_production_intent','v13_production_position',
  'v13_production_event','v13_production_observation']){
  Object.assign(result,{[table]:(await db.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows});
 }
 Object.assign(result,{lease:(await db.query('SELECT to_jsonb(t) AS row FROM private.kalshi_account_worker_lease t')).rows,
  trace:(await db.query('SELECT to_jsonb(t) AS row FROM private.strata_v13_execution_trace t ORDER BY trace_id')).rows});
 return result;
}
function wrapped(hook:(sql:string,args:unknown[]|undefined,invoke:()=>Promise<unknown>)=>Promise<unknown>):Pool{
 return {query:db.query.bind(db),connect:async()=>{
  const client=await db.connect();
  return new Proxy(client,{get(target,key){
   if(key==='query')return (sql:string,args?:unknown[])=>hook(sql,args,()=>client.query(sql,args));
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
async function insertWithdrawal(client:PoolClient,id:string,state='expired'){
 return client.query(`INSERT INTO private.strata_manual_profit_withdrawals(id,owner_user_id,execution_account_id,
  state,amount_cents,retain_cents,bot_before_cents,cashier_before_cents,authority_fingerprint)
  VALUES($1,$2,$3,$4,100,0,2500,0,$5)`,[id,owner,account,state,fingerprint]);
}

test('all checked-in migrations, production constraints, RLS and backend-owner grants',async t=>{
 try{
  const admin=await pool.connect();let sources;
  try{sources=await installFullRecoverySchema(admin);}finally{admin.release();}
  console.info('FULL_SCHEMA_SOURCES',JSON.stringify(sources));
  await t.test('non-superuser table-owner backend, not service_role, is the documented execution model',async()=>{
   const role=(await db.query(`SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
   assert.deepEqual(role,{name:backendRole,rolsuper:false,rolbypassrls:false});
   for(const table of recoveryTables){
    const r=(await db.query(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass`,[table])).rows[0];
    assert.equal(r.owner,backendRole,table);
    for(const privilege of ['SELECT','INSERT','UPDATE'])assert.equal((await db.query(
     `SELECT has_table_privilege(current_user,$1,$2) AS allowed`,[table,privilege])).rows[0].allowed,true,`${table} ${privilege}`);
   }
   assert.equal((await db.query(`SELECT has_table_privilege('service_role','private.kalshi_connection_credentials','SELECT') AS allowed`)).rows[0].allowed,false);
  });
  await t.test('every independent table has enabled validated immediate insert/update account FK checks',async()=>{
   const result=await db.query(`SELECT c.conname,t.relname,c.convalidated,c.condeferrable,
    (SELECT count(*)::int FROM pg_trigger tr WHERE tr.tgconstraint=c.oid AND tr.tgrelid=t.oid
     AND tr.tgenabled IN ('O','A') AND (tr.tgtype::int & 20)>0) AS checks
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND n.nspname='private' AND t.relname=ANY($1::text[])
     AND c.confrelid='public.v13_production_account'::regclass`,[activityTables]);
   assert.equal(result.rows.length,activityTables.length);
   for(const r of result.rows){assert.equal(r.convalidated,true);assert.equal(r.condeferrable,false);assert.equal(r.checks,2);}
  });
  await t.test('browser roles have neither table DML grants nor private schema access',async()=>{
   for(const role of ['anon','authenticated']){
    assert.equal((await db.query(`SELECT has_schema_privilege($1,'private','USAGE') AS allowed`,[role])).rows[0].allowed,false);
    for(const table of recoveryTables)for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
     assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,table,privilege])).rows[0].allowed,false,`${role} ${table} ${privilege}`);
    }
    const session=await pool.connect();try{
     await session.query(`SET ROLE ${role}`);
     await assert.rejects(session.query('SELECT * FROM public.v13_production_account'),{code:'42501'});
     await assert.rejects(session.query('SELECT * FROM private.kalshi_connection_credentials'),{code:'42501'});
    }finally{await session.query('RESET ROLE');session.release();}
   }
  });
  await t.test('RLS protects public recovery tables; inherited private transfer omissions are explicitly visible',async()=>{
   const missing=[];for(const table of recoveryTables){
    const r=(await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass`,[table])).rows[0];
    if(!r.relrowsecurity)missing.push(table);
   }
   // Existing source debt, not silently repaired or claimed to have RLS.
   assert.deepEqual(missing,['private.kalshi_owner_pilot_transfers','private.kalshi_owner_shard_allocations']);
  });
  await t.test('migrations create no account, intent, financial event, approval or trading authority',async()=>{
   for(const table of ['public.v13_production_account','public.v13_production_intent','public.v13_production_event',
    'private.strata_continuous_execution_grants','private.strata_owner_sha_approvals'])
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0,table);
   const gate=(await db.query('SELECT manual_kill_switch,live_execution_enabled FROM live_execution_config')).rows[0];
   assert.deepEqual(gate,{manual_kill_switch:true,live_execution_enabled:false});
  });
  await t.test('actual durable KILL and ledger reconcile losing settlement under complete application constraints',async()=>{
   await reset();const held=await frozen(),r=recovery();const result=await r.recover(held);
   assert.equal(result.ok,true,JSON.stringify(result));assert.equal(r.signers(),1);assert.equal(r.reads(),7);
   const a=(await db.query(`SELECT cash_micros::text,reserved_micros::text,kill_switch,execution_enabled,blocked_reason
    FROM public.v13_production_account WHERE id=$1`,[account])).rows[0];
   assert.deepEqual(a,{cash_micros:'23720000',reserved_micros:'0',kill_switch:true,execution_enabled:false,
    blocked_reason:'personal_exchange_history_unreconciled'});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM v13_production_event')).rows[0].n,2);
   assert.equal((await db.query(`SELECT count(*)::int AS n FROM private.strata_v13_execution_trace WHERE kind='EXCHANGE_EVENT'`)).rows[0].n,2);
   assert.equal((await db.query(`SELECT count(*)::int AS n FROM private.strata_v13_execution_trace WHERE kind='INTENT_STATE'`)).rows[0].n,2);
   assert.equal((await db.query(`SELECT state FROM private.kalshi_account_worker_lease`)).rows[0].state,'killed');
   const before=await financialState();assert.equal((await r.recover(held)).ok,false);assert.deepEqual(await financialState(),before);
  });
  await t.test('zero-fill terminal cancellation also satisfies real schema without financial events',async()=>{
   await reset();const result=await recovery(true).recover(await frozen());assert.equal(result.ok,true,JSON.stringify(result));
   assert.equal((await db.query('SELECT count(*)::int AS n FROM v13_production_event')).rows[0].n,0);
   assert.equal((await db.query('SELECT reserved_micros::text FROM v13_production_account')).rows[0].reserved_micros,'0');
  });
  await t.test('real FK integrity rejects orphan history and contradictory account cash',async()=>{
   await reset();
   await assert.rejects(db.query(`UPDATE v13_production_intent SET evaluation_id='absent' WHERE id=$1`,[target]),{code:'23503'});
   await assert.rejects(db.query(`UPDATE v13_production_position SET account_id='absent' WHERE id=$1`,[target]),{code:'23503'});
   await assert.rejects(db.query(`UPDATE v13_production_account SET reserved_micros=cash_micros+1 WHERE id=$1`,[account]),{code:'23514'});
  });
  await t.test('removing a real required FK refuses reconciliation and preserves all financial rows',async()=>{
   await reset();const held=await frozen();
   const c=(await db.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='private.kalshi_owner_topups'::regclass AND confrelid='public.v13_production_account'::regclass`)).rows[0];
   await db.query(`ALTER TABLE private.kalshi_owner_topups DROP CONSTRAINT "${c.conname}"`);
   try{const before=await financialState(),result=await recovery().recover(held);
    assert.equal(result.ok,false);assert.equal(result.reason,'recovery_independent_activity_fencing_schema_unverified');
    assert.deepEqual(await financialState(),before);
   }finally{await db.query(`ALTER TABLE private.kalshi_owner_topups ADD CONSTRAINT "${c.conname}" ${c.definition}`);}
  });
  await t.test('deferrable and unvalidated real FK replacements are each refused, not assumed equivalent',async()=>{
   for(const replacement of ['DEFERRABLE INITIALLY IMMEDIATE','NOT VALID']){
    await reset();const held=await frozen();
    const c=(await db.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid='private.kalshi_owner_topups'::regclass AND confrelid='public.v13_production_account'::regclass`)).rows[0];
    await db.query(`ALTER TABLE private.kalshi_owner_topups DROP CONSTRAINT "${c.conname}";
     ALTER TABLE private.kalshi_owner_topups ADD CONSTRAINT "${c.conname}" ${c.definition} ${replacement}`);
    try{const before=await financialState(),result=await recovery().recover(held);
     assert.equal(result.reason,'recovery_independent_activity_fencing_schema_unverified',replacement);
     assert.equal(result.ok,false);assert.deepEqual(await financialState(),before);
    }finally{await db.query(`ALTER TABLE private.kalshi_owner_topups DROP CONSTRAINT "${c.conname}";
     ALTER TABLE private.kalshi_owner_topups ADD CONSTRAINT "${c.conname}" ${c.definition}`);}
   }
  });
  await t.test('disabled FK checks are refused even when the constraint itself remains validated',async()=>{
   await reset();const held=await frozen();
   await pool.query('ALTER TABLE private.kalshi_owner_topups DISABLE TRIGGER ALL');
   try{const before=await financialState(),result=await recovery().recover(held);
    assert.equal(result.reason,'recovery_independent_activity_fencing_schema_unverified');
    assert.equal(result.ok,false);assert.deepEqual(await financialState(),before);
   }finally{await pool.query('ALTER TABLE private.kalshi_owner_topups ENABLE TRIGGER ALL');}
  });
  await t.test('new maintenance INSERT waits behind the real recovery parent-account lock',async()=>{
   await reset();const held=await frozen(),entered=deferred(),resume=deferred();let paused=false,inserted=false;
   const database=wrapped(async(sql,_args,invoke)=>{
    if(!paused&&sql.startsWith('INSERT INTO v13_production_event')){paused=true;entered.resolve();await resume.promise;}
    return invoke();
   });
   const operation=recovery(false,database).recover(held);const other=await db.connect();
   let insertion:Promise<unknown>|undefined;
   try{
    await reached(entered.promise,operation);
    insertion=insertWithdrawal(other,'77777777-7777-4777-8777-777777777777').then(()=>{inserted=true;});
    await delay(75);assert.equal(inserted,false,'the FK must conflict with recovery FOR UPDATE');
    resume.resolve();assert.equal((await operation).ok,true);await insertion;assert.equal(inserted,true);
   }finally{resume.resolve();await operation;await insertion;other.release();}
  });
  await t.test('inactive maintenance UPDATE waits behind the real recovery child-row lock',async()=>{
   await reset();const other=await db.connect();await insertWithdrawal(other,'88888888-8888-4888-8888-888888888888');
   const held=await frozen(),entered=deferred(),resume=deferred();let paused=false,updated=false;
   const operation=recovery(false,wrapped(async(sql,_args,invoke)=>{
    if(!paused&&sql.startsWith('INSERT INTO v13_production_event')){paused=true;entered.resolve();await resume.promise;}
    return invoke();
   })).recover(held);
   let update:Promise<unknown>|undefined;
   try{
    await reached(entered.promise,operation);
    update=other.query(`UPDATE private.strata_manual_profit_withdrawals SET state='prepared'
     WHERE id='88888888-8888-4888-8888-888888888888'`).then(()=>{updated=true;});
    await delay(75);assert.equal(updated,false,'inactive rows must be locked too');
    resume.resolve();assert.equal((await operation).ok,true);await update;assert.equal(updated,true);
   }finally{resume.resolve();await operation;await update;other.release();}
  });
  await t.test('receipt failure rolls back real ledger events, terminal transition, trigger outbox and account update',async()=>{
   await reset();const held=await frozen(),before=await financialState();
   await db.query(`CREATE FUNCTION private.unknown_recovery_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind='OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER unknown_recovery_test_audit_fault BEFORE INSERT ON public.v13_production_observation
     FOR EACH ROW EXECUTE FUNCTION private.unknown_recovery_test_audit_fault()`);
   try{assert.equal((await recovery().recover(held)).ok,false);assert.deepEqual(await financialState(),before);}
   finally{await db.query(`DROP TRIGGER unknown_recovery_test_audit_fault ON public.v13_production_observation;
    DROP FUNCTION private.unknown_recovery_test_audit_fault()`);}
  });
  await t.test('trace evidence remains immutable with actual production trigger functions',async()=>{
   await reset();await recovery().recover(await frozen());
   await assert.rejects(db.query(`UPDATE private.strata_v13_execution_trace SET details='{}'`),{code:'23514'});
   await assert.rejects(db.query(`DELETE FROM private.strata_v13_execution_trace`),{code:'23514'});
  });
 }finally{await db.end();await pool.end();}
});
