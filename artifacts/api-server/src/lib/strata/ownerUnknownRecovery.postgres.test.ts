import {createOwnerUnknownRecoveryService,OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT} from './ownerUnknownRecoveryService';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {digest,type Request} from '../v13-production/types';
import {dedicatedSignerFingerprint} from './commissioning';
import {readOwnedKalshiFeeds,type OwnedKalshiRead} from './personalExchangeRead';
import {fenceOwnerUnknownForAccounting} from './ownerUnknownRecoveryFence';
import {createHeldUnknownAccountingRecovery} from './ownerUnknownRecoveryHeld';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION} from './ownerUnknownRecoveryPlan';
import {entryCashRiskFeeFixture} from '../v13-production/entryCashRisk.fixture';
import {entryCashProof} from '../v13EntryCashRisk';

const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
 'only the canonical freshly-created disposable PostgreSQL destination is allowed');
const owner='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
const connection='33333333-3333-4333-8333-333333333333',provider='44444444-4444-4444-8444-444444444444';
const account='unknown-recovery-synthetic';
const material={keyId:'synthetic-only',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const fingerprint=dedicatedSignerFingerprint(material.keyId,material.privateKey)!;
const request:Request={market:'KXBTC15M-SYNTHETIC',side:'NO',action:'BUY',contracts:3,limitMicros:430000,
 timeInForce:'IOC',reduceOnly:false,clientOrderId:'synthetic-client'};
const initial={ownerId:owner,targetIntentId:target,confirmation:OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function reached(signal:Promise<void>,operation:Promise<unknown>){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([signal,operation.then(result=>{throw Error('recovery_completed_before_concurrency_hook: '+JSON.stringify(result));}),
  new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('concurrency_hook_timeout')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}
}

async function schema(){
 // The destination assertion above and canonical runner guarantee a new empty
 // isolated cluster. These minimal-schema fixtures do NOT qualify migrations.
 await pool.query(`DROP TABLE IF EXISTS public.v13_production_observation,public.v13_production_event,
  public.v13_production_position,public.v13_production_intent,public.v13_production_account,
  public.v13_live_money_policy CASCADE;
 CREATE SCHEMA IF NOT EXISTS private;
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,kalshi_connection_id uuid,
  policy_id text,subaccount bigint,exchange_index bigint,key_fingerprint text,revision bigint,
  cash_micros bigint,reserved_micros bigint,initial_cash_micros bigint,blocked_reason text,
  kill_switch boolean,execution_enabled boolean,commissioned boolean,cash_precision_verified boolean,
  reconciled_at timestamptz,evidence_digest text);
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,created_by text,state text);
 CREATE TABLE public.financial_accounts(id uuid PRIMARY KEY,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid PRIMARY KEY,financial_account_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,
  role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,key_fingerprint text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY,owner_user_id uuid,state text,
  fencing_token bigint,credential_fingerprint text,account_kill boolean,arm_requested boolean,released_at timestamptz,heartbeat_at timestamptz);
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text,evaluation_id text,crossing_key text,parent_id text,
  kind text,market text,side text,state text,request jsonb,decision jsonb,policy_hash text,fee_fingerprint text,
  capability_digest text,client_order_id text,exchange_order_id text,reserved_micros bigint,exit_fee_micros bigint,
  filled_hundredths bigint,terminal boolean,cancel_attempted boolean,dispatch_at timestamptz,created_at timestamptz);
 CREATE TABLE public.v13_production_position(id text PRIMARY KEY,account_id text,market text,side text,
  quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE public.v13_production_event(account_id text,event_id text,intent_id text,kind text,digest text,payload jsonb,
  cash_delta_micros bigint,pnl_micros bigint,occurred_at timestamptz,UNIQUE(account_id,event_id));
 CREATE TABLE public.v13_production_observation(id text PRIMARY KEY,account_id text,kind text,payload jsonb,digest text,
  observed_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text REFERENCES public.v13_production_account(id),state text);
 CREATE TABLE private.strata_manual_profit_withdrawals(execution_account_id text REFERENCES public.v13_production_account(id),state text);
 CREATE TABLE private.strata_auto_withdrawal_maintenance(execution_account_id text REFERENCES public.v13_production_account(id),state text);
 CREATE TABLE private.kalshi_owner_topups(execution_account_id text REFERENCES public.v13_production_account(id),state text);
 CREATE TABLE private.kalshi_owner_pilot_transfers(execution_account_id text REFERENCES public.v13_production_account(id),state text);
 CREATE TABLE private.kalshi_owner_shard_allocations(execution_account_id text REFERENCES public.v13_production_account(id),state text);`);
}
async function reset(){
 await pool.query(`TRUNCATE public.v13_production_observation,public.v13_production_event,public.v13_production_position,
  public.v13_production_intent,public.v13_production_account,public.v13_live_money_policy,public.financial_accounts,
  private.provider_connections,private.kalshi_connection_credentials,private.kalshi_account_worker_lease,
  private.strata_emergency_exit_reservations,private.strata_manual_profit_withdrawals,private.strata_auto_withdrawal_maintenance,
  private.kalshi_owner_topups,private.kalshi_owner_pilot_transfers,private.kalshi_owner_shard_allocations;
 DROP TRIGGER IF EXISTS unknown_recovery_injected_fault ON public.v13_production_observation;`);
 const at=Date.now();
 await pool.query(`INSERT INTO public.v13_production_account VALUES($1,$2,$3,'synthetic-policy',1,2,$4,7,
  25000000,6000000,25000000,'personal_exchange_history_unreconciled',false,true,true,true,NULL,NULL)`,[account,owner,connection,fingerprint]);
 await pool.query(`INSERT INTO public.v13_live_money_policy VALUES('synthetic-policy',$1,$2,'APPROVED')`,[account,owner]);
 await pool.query('INSERT INTO public.financial_accounts VALUES($1,$2,\'kalshi\')',[connection,owner]);
 await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[provider,connection]);
 await pool.query(`INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,'restricted_execution',NULL,now(),'credential_verified',$4)`,
  [owner,connection,provider,fingerprint]);
 await pool.query(`INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,'owned',7,$3,false,true,NULL,now()-interval '1 hour')`,[account,owner,fingerprint]);
 const decision={},policyHash='synthetic-policy-hash',fee='synthetic-fee';
 const capability=digest({id:target,request,decision,policyHash,fee});
 await pool.query(`INSERT INTO public.v13_production_intent(id,account_id,evaluation_id,crossing_key,parent_id,kind,market,side,state,
  request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,exchange_order_id,reserved_micros,
  exit_fee_micros,filled_hundredths,terminal,cancel_attempted,dispatch_at,created_at)
  VALUES($1,$2,'synthetic-evaluation','synthetic-crossing',NULL,'ENTRY',$3,'NO','UNKNOWN',$4::jsonb,$5::jsonb,$6,$7,$8,$9,
   'synthetic-order',6000000,50000,0,false,false,$10,$10)`,
  [target,account,request.market,JSON.stringify(request),JSON.stringify(decision),policyHash,fee,capability,request.clientOrderId,new Date(at-100000)]);
 await pool.query(`INSERT INTO public.v13_production_position VALUES($1,$2,$3,'NO',0,0,0)`,[target,account,request.market]);
 return at;
}
async function frozenInput(){
 const result=await fenceOwnerUnknownForAccounting(initial,{db:pool,isScheduled:()=>false});
 assert.equal(result.ok,true,JSON.stringify(result));
 return {...initial,fenceReceiptId:result.attemptId!};
}
async function pinVersionedCashRisk(){
 const policyHash='a'.repeat(64),fee=entryCashRiskFeeFixture({now:Date.now(),market:request.market,side:'NO',price:.43,contracts:3,policyHash});
 const cashRisk=entryCashProof(fee,3,600);assert.ok(cashRisk);
 const decision={book:{fee},preflight:{cashRisk}},capability=digest({id:target,request,decision,policyHash,fee:fee.fingerprint});
 await pool.query(`UPDATE public.v13_production_intent SET decision=$2,policy_hash=$3,fee_fingerprint=$4,capability_digest=$5 WHERE id=$1`,
  [target,JSON.stringify(decision),policyHash,fee.fingerprint,capability]);
}
function raw(at:number,baseAt=Date.now()):OwnedKalshiRead{
 return {ok:true,historicalCoverageComplete:true,observedAtMs:at,cashMicros:'23720000',
  orders:[{order_id:'synthetic-order',client_order_id:request.clientOrderId,ticker:request.market,status:'executed',
   book_side:'ask',side:'no',action:'buy',yes_price_dollars:'0.5700',initial_count_fp:'3.00',fill_count_fp:'3.00'}],
  fills:[{trade_id:'synthetic-fill',order_id:'synthetic-order',ticker:request.market,count_fp:'3.00',
   yes_price_dollars:'0.5900',no_price_dollars:'0.4100',fee_cost:'0.0500',ts:Math.floor((baseAt-99000)/1000)}],
  positions:[],settlements:[{ticker:request.market,yes_count_fp:'0.00',no_count_fp:'3.00',market_result:'yes',revenue:0,
   settled_time:new Date(baseAt-50000).toISOString()}]};
}
function run(options:{db?:Pool;clock?:()=>number;mutate?:(r:OwnedKalshiRead)=>void;afterRead?:()=>Promise<void>}={}){
 let feeds=0,signers=0;
 const recover=createHeldUnknownAccountingRecovery({db:options.db??pool,now:options.clock??Date.now,isScheduled:()=>false,
  material:async()=>{signers++;return material;},readFeeds:async(creds,at)=>{
   const f=raw(at);options.mutate?.(f);
   const result=await readOwnedKalshiFeeds(creds,at,async(_material,path)=>{
    feeds++;
    if(path.endsWith('/balance'))return {balance_dollars:(Number(f.cashMicros)/1000000).toFixed(4),subaccount:1,exchange_index:2};
    if(path.includes('/historical/'))return {orders:[],fills:[],cursor:''};
    if(path.endsWith('/orders'))return {orders:f.orders,cursor:''};
    if(path.endsWith('/fills'))return {fills:f.fills,cursor:''};
    if(path.endsWith('/positions'))return {market_positions:f.positions,cursor:''};
    if(path.endsWith('/settlements'))return {settlements:f.settlements,cursor:''};
    throw Error('unexpected_provider_path');
   });
   if(result.ok)result.historicalCoverageComplete=f.historicalCoverageComplete;
   await options.afterRead?.();return result;
  }});
 return {recover,feeds:()=>feeds,signers:()=>signers};
}
async function state(){
 return {a:(await pool.query(`SELECT cash_micros::text,reserved_micros::text,revision::text,blocked_reason,
  kill_switch,execution_enabled FROM public.v13_production_account WHERE id=$1`,[account])).rows[0],
  i:(await pool.query(`SELECT state,terminal,reserved_micros::text,filled_hundredths::text FROM public.v13_production_intent WHERE id=$1`,[target])).rows[0],
  p:(await pool.query(`SELECT quantity_hundredths::text,basis_micros::text,realized_pnl_micros::text FROM public.v13_production_position WHERE id=$1`,[target])).rows[0],
  events:(await pool.query(`SELECT event_id,cash_delta_micros::text,pnl_micros::text,digest FROM public.v13_production_event ORDER BY event_id`)).rows,
  observations:(await pool.query(`SELECT id,kind,digest FROM public.v13_production_observation ORDER BY id`)).rows,
  lease:(await pool.query(`SELECT state,account_kill,arm_requested,fencing_token::text FROM private.kalshi_account_worker_lease`)).rows[0]};
}
function wrapped(hook:(sql:string,args:unknown[]|undefined,client:PoolClient,invoke:()=>Promise<unknown>)=>Promise<unknown>):Pool{
 return {query:pool.query.bind(pool),connect:async()=>{
  const client=await pool.connect();
  return new Proxy(client,{get(target,key){
   if(key==='query')return (sql:string,args?:unknown[])=>hook(sql,args,client,()=>client.query(sql,args));
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
 }} as unknown as Pool;
}
async function fault(kind:string,body="RAISE EXCEPTION 'synthetic_audit_failure';"){
 await pool.query(`CREATE OR REPLACE FUNCTION public.unknown_recovery_fault() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.kind='${kind}' THEN ${body} END IF; RETURN NEW; END $$;
 CREATE TRIGGER unknown_recovery_injected_fault BEFORE INSERT ON public.v13_production_observation
 FOR EACH ROW EXECUTE FUNCTION public.unknown_recovery_fault();`);
}

test('isolated owner UNKNOWN recovery uses actual mapper, ledger, transaction and PostgreSQL locks',async t=>{
 try{
  await schema();
  await t.test('complete synthetic losing settlement accounts exactly once and leaves kill/freeze intact',async()=>{
   await reset();const input=await frozenInput();let accountWrites=0;
   const db=wrapped(async(sql,args,_client,invoke)=>{
    if(sql.startsWith('UPDATE v13_production_account')){accountWrites++;assert.equal(args?.[3],'personal_exchange_history_unreconciled');}
    return invoke();});
   const r=run({db}),result=await r.recover(input);assert.equal(accountWrites,1,'prior freeze is never bound as NULL');
   assert.equal(result.ok,true,JSON.stringify(result));assert.equal(r.feeds(),7);assert.equal(r.signers(),1);
   const s=await state();assert.equal(s.a.cash_micros,'23720000');assert.equal(s.a.reserved_micros,'0');
   assert.equal(s.a.kill_switch,true);assert.equal(s.a.execution_enabled,false);
   assert.equal(s.a.blocked_reason,'personal_exchange_history_unreconciled');
   assert.deepEqual(s.i,{state:'TERMINAL',terminal:true,reserved_micros:'0',filled_hundredths:'300'});
   assert.deepEqual(s.p,{quantity_hundredths:'0',basis_micros:'0',realized_pnl_micros:'-1280000'});
   assert.equal(s.events.length,2);assert.equal(s.lease.state,'killed');assert.equal(s.lease.fencing_token,'8');
   assert.equal(s.observations.filter(o=>o.kind==='OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION').length,1);
   assert.equal((await r.recover(input)).ok,false);assert.deepEqual(await state(),s,'no duplicate financial events on replay');
  });
  await t.test('explicit terminal zero-fill cancellation releases reserve only through existing ledger',async()=>{
   await reset();const input=await frozenInput(),r=run({mutate:f=>{f.cashMicros='25000000';f.fills=[];f.settlements=[];
    Object.assign(f.orders[0] as object,{status:'canceled',fill_count_fp:'0.00'});}});
   const result=await r.recover(input);assert.equal(result.ok,true,JSON.stringify(result));
   const s=await state();assert.equal(s.a.cash_micros,'25000000');assert.equal(s.a.reserved_micros,'0');
   assert.equal(s.i.state,'TERMINAL');assert.equal(s.events.length,0);
  });
  const invalids:Array<[string,(f:OwnedKalshiRead)=>void]>=[
   ['absent order',f=>{f.cashMicros='25000000';f.orders=[];f.fills=[];f.settlements=[];}],
   ['missing fill',f=>{f.fills=[];}],['incomplete archive',f=>{f.historicalCoverageComplete=false;}],
   ['wrong cash',f=>{f.cashMicros='24000000';}],
   ['future fill',f=>{(f.fills[0] as Record<string,unknown>).ts=Math.floor(Date.now()/1000)+120;}],
   ['open exposure',f=>{f.positions=[{ticker:request.market,position_fp:'-3.00'}];f.settlements=[];}],
   ['new reservation-overrun risk',f=>{f.cashMicros='18470000';(f.fills[0] as Record<string,unknown>).fee_cost='5.3000';}],
  ];
  for(const [name,mutate] of invalids)await t.test(`${name} preserves UNKNOWN, cash, $6 reserve and all prior rows`,async()=>{
   await reset();const input=await frozenInput(),before=await state(),r=run({mutate});
   assert.equal((await r.recover(input)).ok,false);assert.deepEqual(await state(),before);
  });
  await t.test('versioned per-fill fee overrun cannot hide behind preexisting freeze',async()=>{
   await reset();await pinVersionedCashRisk();const input=await frozenInput(),before=await state();
   const result=await run({mutate:f=>{(f.fills[0] as Record<string,unknown>).fee_cost='0.1000';f.cashMicros='23670000';}}).recover(input);
   assert.equal(result.ok,false);assert.equal(result.reason,'recovery_new_risk_hold_requires_review');assert.deepEqual(await state(),before);
  });
  await t.test('fragmented aggregate cash excess rolls back with existing freeze retained',async()=>{
   await reset();await pinVersionedCashRisk();const input=await frozenInput(),before=await state();
   const result=await run({mutate:f=>{
    const template=f.fills[0] as Record<string,unknown>;
    f.fills=Array.from({length:300},(_,n)=>({...template,trade_id:`fragment-${n}`,count_fp:'0.01',fee_cost:'0.0060'}));
    f.cashMicros='21970000';
   }}).recover(input);
   assert.equal(result.ok,false);assert.equal(result.reason,'recovery_new_risk_hold_requires_review');assert.deepEqual(await state(),before);
  });
  await t.test('safety fence audit failure rolls back account kill and lease token together',async()=>{
   await reset();await fault('OWNER_UNKNOWN_ACCOUNTING_KILL_FENCE');const before=await state();
   assert.equal((await fenceOwnerUnknownForAccounting(initial,{db:pool,isScheduled:()=>false})).ok,false);
   assert.deepEqual(await state(),before);
  });
  await t.test('accounting audit failure rolls back financial events, terminal state and reserve release',async()=>{
   await reset();const input=await frozenInput();await fault('OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION');
   const before=await state();assert.equal((await run().recover(input)).ok,false);assert.deepEqual(await state(),before);
  });
  await t.test('foreign owner cannot obtain signer or signed feeds',async()=>{
   await reset();const input=await frozenInput(),r=run();
   assert.equal((await r.recover({...input,ownerId:'55555555-5555-4555-8555-555555555555'})).ok,false);
   assert.equal(r.signers(),0);assert.equal(r.feeds(),0);
  });
  await t.test('durable kill waits for an older final account lock before committing fence',async()=>{
   await reset();const blocker=await pool.connect();let finished=false;
   try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE',[account]);
    const operation=fenceOwnerUnknownForAccounting(initial,{db:pool,isScheduled:()=>false}).then(r=>{finished=true;return r;});
    await delay(75);assert.equal(finished,false);await blocker.query('COMMIT');assert.equal((await operation).ok,true);
   }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
  });
  await t.test('credential revision change during signed read aborts before accounting',async()=>{
   await reset();const input=await frozenInput(),before=await state();
   const r=run({afterRead:async()=>{await pool.query('UPDATE private.kalshi_connection_credentials SET verified_at=clock_timestamp()');}});
   assert.equal((await r.recover(input)).ok,false);assert.deepEqual(await state(),before);
  });
  await t.test('lease ABA during signed read aborts despite identical final flag values',async()=>{
   await reset();const input=await frozenInput(),before=await state();
   const r=run({afterRead:async()=>{await pool.query(`UPDATE private.kalshi_account_worker_lease SET arm_requested=true;
    UPDATE private.kalshi_account_worker_lease SET arm_requested=false;`);}});
   assert.equal((await r.recover(input)).ok,false);assert.deepEqual(await state(),before);
  });
  await t.test('concurrent lease writer waits behind the locked accounting transaction',async()=>{
   await reset();const input=await frozenInput(),entered=deferred(),resume=deferred();let paused=false,acquired=false;
   const db=wrapped(async(sql,_args,_client,invoke)=>{if(!paused&&sql.startsWith('INSERT INTO v13_production_event')){
    paused=true;entered.resolve();await resume.promise;}return invoke();});
   const operation=run({db}).recover(input);await reached(entered.promise,operation);
   const concurrent=pool.connect().then(async c=>{try{await c.query('BEGIN');
    const l=(await c.query('SELECT * FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 FOR UPDATE',[account])).rows[0];
    acquired=true;assert.equal(l.state,'killed');await c.query('ROLLBACK');}finally{c.release();}});
   try{await delay(75);assert.equal(acquired,false);}finally{resume.resolve();}
   assert.equal((await operation).ok,true);await concurrent;
  });
  await t.test('credential revocation waits until committed accounting releases shared metadata lock',async()=>{
   await reset();const input=await frozenInput(),entered=deferred(),resume=deferred();let paused=false,changed=false;
   const db=wrapped(async(sql,_args,_client,invoke)=>{if(!paused&&sql.startsWith('INSERT INTO v13_production_event')){
    paused=true;entered.resolve();await resume.promise;}return invoke();});
   const operation=run({db}).recover(input);await reached(entered.promise,operation);
   const revoke=pool.query('UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp()').then(()=>{changed=true;});
   try{await delay(75);assert.equal(changed,false);}finally{resume.resolve();}
   assert.equal((await operation).ok,true);await revoke;
  });
  await t.test('completed maintenance reactivation waits behind owned inactive-row lock',async()=>{
   await reset();await pool.query(`INSERT INTO private.strata_auto_withdrawal_maintenance VALUES($1,'completed')`,[account]);
   const input=await frozenInput(),entered=deferred(),resume=deferred();let paused=false,changed=false;
   const db=wrapped(async(sql,_args,_client,invoke)=>{if(!paused&&sql.startsWith('INSERT INTO v13_production_event')){
    paused=true;entered.resolve();await resume.promise;}return invoke();});
   const operation=run({db}).recover(input);await reached(entered.promise,operation);
   const change=pool.query(`UPDATE private.strata_auto_withdrawal_maintenance SET state='pause_requested' WHERE execution_account_id=$1`,[account]).then(()=>{changed=true;});
   try{await delay(75);assert.equal(changed,false);}finally{resume.resolve();}
   assert.equal((await operation).ok,true);await change;
  });
  await t.test('new maintenance row insertion waits on validated parent-account FK lock',async()=>{
   await reset();const input=await frozenInput(),entered=deferred(),resume=deferred();let paused=false,inserted=false;
   const db=wrapped(async(sql,_args,_client,invoke)=>{if(!paused&&sql.startsWith('INSERT INTO v13_production_event')){
    paused=true;entered.resolve();await resume.promise;}return invoke();});
   const operation=run({db}).recover(input);await reached(entered.promise,operation);
   const insert=pool.query(`INSERT INTO private.strata_auto_withdrawal_maintenance VALUES($1,'pause_requested')`,[account]).then(()=>{inserted=true;});
   try{await delay(75);assert.equal(inserted,false);}finally{resume.resolve();}
   assert.equal((await operation).ok,true);await insert;
  });
  await t.test('missing FK serialization contract refuses financial accounting',async()=>{
   await reset();const input=await frozenInput(),before=await state();
   const name=(await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='private.strata_auto_withdrawal_maintenance'::regclass AND contype='f'`)).rows[0].conname as string;
   const quoted='"'+name.replace(/"/g,'""')+'"';
   try{await pool.query(`ALTER TABLE private.strata_auto_withdrawal_maintenance DROP CONSTRAINT ${quoted}`);
    const result=await run().recover(input);assert.equal(result.ok,false);
    assert.equal(result.reason,'recovery_independent_activity_fencing_schema_unverified');assert.deepEqual(await state(),before);
   }finally{await pool.query(`ALTER TABLE private.strata_auto_withdrawal_maintenance ADD CONSTRAINT ${quoted} FOREIGN KEY(execution_account_id) REFERENCES public.v13_production_account(id)`);}
  });
  await t.test('evidence expiring during account-lock wait rolls back before financial writes',async()=>{
   await reset();const input=await frozenInput(),blocker=await pool.connect(),readDone=deferred();let clock=Date.now();
   try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE',[account]);
    const operation=run({clock:()=>clock,afterRead:async()=>{readDone.resolve();}}).recover(input);
    await reached(readDone.promise,operation);await delay(75);clock+=16000;await blocker.query('COMMIT');
    const before=await state();assert.equal((await operation).ok,false);assert.deepEqual(await state(),before);
   }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
  });
  await t.test('lost COMMIT acknowledgement returns uncertain receipt, without automatic replay',async()=>{
   await reset();const input=await frozenInput();let commits=0;
   const db=wrapped(async(sql,_args,_client,invoke)=>{const result=await invoke();if(sql==='COMMIT'){commits++;throw Error('synthetic_lost_commit_ack');}return result;});
   const result=await run({db}).recover(input);assert.equal(result.ok,false);
   assert.equal(result.reason,'recovery_accounting_commit_outcome_unverified');assert.equal('outcomeUnknown' in result&&result.outcomeUnknown,true);
   const s=await state();assert.equal(commits,1);assert.equal(s.i.state,'TERMINAL');assert.equal(s.a.reserved_micros,'0');
   assert.equal(s.events.length,2);assert.equal(s.observations.filter(o=>o.kind==='OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION').length,1);
  });
  await t.test('owner service enforces protective acknowledgment and verifies committed fence/accounting receipts in SQL',async()=>{
   await reset();let signerReads=0,feedReads=0;
   const service=createOwnerUnknownRecoveryService({db:pool,now:Date.now,isScheduled:()=>false,
    material:async()=>{signerReads++;return material;},readFeeds:async(_m,at)=>{feedReads++;return raw(at);}});
   const before=await state();
   assert.equal((await service.fence(owner,{targetIntentId:target,confirmation:initial.confirmation})).ok,false);
   assert.deepEqual(await state(),before);assert.equal(signerReads,0);assert.equal(feedReads,0);
   const f=await service.fence(owner,{targetIntentId:target,confirmation:initial.confirmation,
    protectiveAutomationAcknowledgment:OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT});
   assert.equal(f.ok,true);assert.ok('attemptId' in f&&f.attemptId);
   const fenceReceiptId=String('attemptId' in f?f.attemptId:'');
   const verifiedFence=await service.receipt(owner,fenceReceiptId);assert.equal(verifiedFence.ok,true,JSON.stringify(verifiedFence));
   assert.equal('accountingCommitted' in verifiedFence&&verifiedFence.accountingCommitted,false);
   assert.equal((await service.receipt('55555555-5555-4555-8555-555555555555',fenceReceiptId)).ok,false);
   const r=await service.reconcile(owner,{targetIntentId:target,fenceReceiptId,confirmation:initial.confirmation});
   assert.equal(r.ok,true,JSON.stringify(r));assert.ok('receiptId' in r&&typeof r.receiptId==='string');
   const receiptId=String('receiptId' in r?r.receiptId:'');
   const verified=await service.receipt(owner,receiptId);assert.equal(verified.ok,true,JSON.stringify(verified));
   assert.equal(verified.accountingCommitted,true);assert.equal('localAccountingTerminalAndFlat' in verified&&verified.localAccountingTerminalAndFlat,true);
   assert.equal(signerReads,1);assert.equal(feedReads,1);
   assert.equal((await service.receipt(owner,fenceReceiptId)).ok,false,'old fence revision cannot represent current state');
   await pool.query('UPDATE private.kalshi_account_worker_lease SET fencing_token=fencing_token+1');
   const drift=await service.receipt(owner,receiptId);assert.equal(drift.ok,false);
   assert.equal(drift.accountingCommitted,true,'historical commit remains truthful despite current drift');
   assert.equal(signerReads,1);assert.equal(feedReads,1,'receipt inspection never calls the provider');
  });
  await t.test('winning settlement imports exact proceeds without clearing freeze or restarting',async()=>{
   await reset();const input=await frozenInput();
   const r=await run({mutate:f=>{f.cashMicros='26720000';const settlement=f.settlements[0] as Record<string,unknown>;
    settlement.market_result='no';settlement.revenue=300;}}).recover(input);
   assert.equal(r.ok,true,JSON.stringify(r));const s=await state();assert.equal(s.a.cash_micros,'26720000');
   assert.equal(s.a.reserved_micros,'0');assert.equal(s.a.kill_switch,true);
   assert.equal(s.a.blocked_reason,'personal_exchange_history_unreconciled');
  });
  await t.test('partially filled canceled entry with losing settlement releases only ledger-proven remainder',async()=>{
   await reset();const input=await frozenInput();
   const r=await run({mutate:f=>{f.cashMicros='24570000';
    Object.assign(f.orders[0] as object,{status:'canceled',fill_count_fp:'1.00'});
    Object.assign(f.fills[0] as object,{count_fp:'1.00',fee_cost:'0.0200'});
    Object.assign(f.settlements[0] as object,{no_count_fp:'1.00'});}}).recover(input);
   assert.equal(r.ok,true,JSON.stringify(r));const s=await state();assert.equal(s.a.cash_micros,'24570000');
   assert.equal(s.a.reserved_micros,'0');assert.equal(s.i.terminal,true);assert.equal(s.i.filled_hundredths,'100');
  });
 }finally{await pool.end();}
});
