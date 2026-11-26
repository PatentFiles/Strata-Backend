/** Real PostgreSQL mechanics only; Unix socket in the existing disposable,
 * network-fenced economic runner. No production state or venue is reachable. */
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {economicDischargeFixture} from './economicExitDischargeFixture';
import {proveEconomicDischarge,economicDischargePlan} from './economicExitDischargeEvidence';
import {commitEconomicDischarge,economicDischargeOutcome,cancelEconomicDischarge,type DischargeScope} from './economicExitDischargeCommit';
import {economicExitNotDischarged,readEconomicExitDischarges,assertNoEconomicExitContradiction} from './economicExitDischargeScope';
import {readUnresolvedIntentMode} from './workerUncertainOrderGate';
const url=new URL(process.env.DATABASE_URL??'');
if(process.env.NODE_ENV!=='test'||process.env.STRATA_ISOLATED_ECONOMIC_TEST!=='1'||url.pathname!=='/strata_economic_fixture'||
 url.searchParams.get('host')!==process.env.STRATA_ECONOMIC_SOCKET||!/^\/tmp\/strata-economic-[A-Za-z0-9]+\/socket$/.test(process.env.STRATA_ECONOMIC_SOCKET??'')||url.hostname!=='')throw Error('disposable_unix_socket_database_required');
process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED='true';
const schema=`CREATE SCHEMA auth;CREATE SCHEMA private;
 DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','strata_api_runtime','strata_paper_runtime'] LOOP IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',role_name); END IF; END LOOP; END $$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid REFERENCES auth.users(id),subaccount integer,exchange_index integer,
 key_fingerprint text,revision bigint,owner_control_epoch bigint DEFAULT 0,cash_micros bigint,reserved_micros bigint,initial_cash_micros bigint,
 execution_enabled boolean DEFAULT true,kill_switch boolean DEFAULT false,blocked_reason text,reconciled_at timestamptz,evidence_digest text);
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text REFERENCES public.v13_production_account(id),parent_id text,
 kind text,state text,terminal boolean,exchange_order_id text,filled_hundredths bigint,reserved_micros bigint,client_order_id text,
 request jsonb,decision jsonb,capability_digest text,dispatch_at timestamptz);
 CREATE TABLE public.v13_production_position(id text PRIMARY KEY,account_id text REFERENCES public.v13_production_account(id),market text,side text,
 quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE public.v13_production_event(account_id text REFERENCES public.v13_production_account(id),event_id text,intent_id text,
 kind text,digest text,payload jsonb,cash_delta_micros bigint,pnl_micros bigint,occurred_at timestamptz,PRIMARY KEY(account_id,event_id));
 CREATE TABLE private.strata_emergency_exit_reservations(reservation_id uuid PRIMARY KEY,owner_user_id uuid,
 execution_account_id text REFERENCES public.v13_production_account(id),client_order_id text,state text,trading_authorized boolean,order_digest text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),owner_user_id uuid,
 state text,arm_requested boolean,fencing_token bigint,heartbeat_at timestamptz,account_kill boolean DEFAULT false,released_at timestamptz);
 CREATE TABLE public.v13_production_observation(id uuid PRIMARY KEY,account_id text,kind text,payload jsonb,digest text);`;
async function seed(){
 await pool.query('TRUNCATE public.v13_production_account,auth.users CASCADE');
 const f=economicDischargeFixture(),a=f.account,b=f.booking;
 // Use current clock while keeping the fixture's exact original financial times.
 const fresh=Date.now();f.snapshot.observedAtMs=fresh;f.nowMs=fresh;
 await pool.query('INSERT INTO auth.users VALUES($1)',[a.owner_user_id]);
 await pool.query('INSERT INTO public.v13_production_account(id,owner_user_id,subaccount,exchange_index,key_fingerprint,revision,cash_micros,reserved_micros,initial_cash_micros) VALUES($1,$2,1,2,$3,$4,$5,$6,$7)',[a.id,a.owner_user_id,a.key_fingerprint,a.revision,a.cash_micros,a.reserved_micros,a.initial_cash_micros]);
 for(const i of f.history.rows)await pool.query('INSERT INTO public.v13_production_intent VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[i.id,a.id,i.parent_id,i.kind,i.state,i.terminal,i.exchange_order_id,i.filled_hundredths,i.reserved_micros,i.client_order_id,i.request,i.decision,i.capability_digest,i.dispatch_at]);
 const p=f.history.positions[0]!;await pool.query('INSERT INTO public.v13_production_position VALUES($1,$2,$3,$4,$5,$6,$7)',[p.id,a.id,p.market,p.side,p.quantity_hundredths,p.basis_micros,p.realized_pnl_micros]);
 for(const e of f.history.events)await pool.query('INSERT INTO public.v13_production_event VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[a.id,e.event_id,e.intent_id,e.kind,e.digest,e.payload,e.cash_delta_micros,e.pnl_micros,e.occurred_at]);
 const m=f.history.markers[0]!;await pool.query("INSERT INTO private.strata_emergency_exit_reservations VALUES($1,$2,$3,$4,'UNKNOWN',false,$5)",[m.reservation_id,a.owner_user_id,a.id,m.client_order_id,m.order_digest]);
 await pool.query("INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,state,arm_requested,fencing_token,heartbeat_at) VALUES($1,$2,'owned',false,61,clock_timestamp()-interval '1 hour')",[a.id,a.owner_user_id]);
 await pool.query(`INSERT INTO private.strata_economic_settlement_receipt(request_id,owner_user_id,execution_account_id,entry_intent_id,exit_intent_id,reservation_id,settlement_event_id,
 settlement_digest,scope_digest,release_sha,prior_revision,posted_revision,control_epoch,worker_fencing_token,payload,payload_digest)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,61,$13,$14)`,[b.request_id,b.owner_user_id,b.execution_account_id,b.entry_intent_id,b.exit_intent_id,b.reservation_id,b.settlement_event_id,
 b.settlement_digest,'a'.repeat(64),'b'.repeat(40),b.prior_revision,b.posted_revision,b.payload,b.payload_digest]);
 const proof=proveEconomicDischarge(f),scope:DischargeScope={ownerId:a.owner_user_id,requestId:randomUUID(),scopeDigest:'c'.repeat(64),releaseSha:'d'.repeat(40),controlEpoch:'0',workerFence:'61'};
 return {f,proof,scope};
}
const locked=async(tx:PoolClient)=>{await tx.query('SELECT * FROM private.kalshi_account_worker_lease FOR UPDATE');};
async function current(){return (await pool.query(`SELECT a.cash_micros::text,a.reserved_micros::text,a.revision::text,a.owner_control_epoch::text,a.execution_enabled,a.kill_switch,
 w.state AS lease,w.fencing_token::text,w.arm_requested,(SELECT count(*)::int FROM private.strata_economic_exit_discharge) receipts,
 (SELECT count(*)::int FROM public.v13_production_event) events,(SELECT state FROM public.v13_production_intent WHERE kind='EXIT') exit,
 (SELECT state FROM private.strata_emergency_exit_reservations) marker FROM public.v13_production_account a JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id`)).rows[0];}
const run=(x:Awaited<ReturnType<typeof seed>>,extra:Partial<Parameters<typeof commitEconomicDischarge>[2]>={})=>commitEconomicDischarge(x.proof,x.scope,{db:pool,verifyLocked:locked,...extra});
test('native economic discharge atomicity, original UNKNOWN, cancellation, ownership and late contradictions',async t=>{
 try{
  await pool.query(schema);
  await pool.query(readFileSync('../../supabase/migrations/20261126004500_economic_settlement_receipt.sql','utf8'));
  await pool.query(readFileSync('../../supabase/migrations/20261126113609_economic_exit_obligation_discharge.sql','utf8'));
  await t.test('PIN absent-receipt fast path has exact canonical parity and cannot exempt missing or corrupted proof',async()=>{
   const x=await seed();
   const read=async(fast:boolean)=>(await pool.query('SELECT r.id FROM public.v13_production_intent r WHERE r.account_id=$1'+economicExitNotDischarged('r.account_id','r.client_order_id',fast)+' ORDER BY r.id',[x.f.account.id])).rows;
   assert.deepEqual(await read(true),await read(false));assert.equal((await read(true)).length,2);
   assert.equal((await run(x)).ok,true);
   assert.deepEqual(await read(true),await read(false));assert.equal((await read(true)).length,1);
   await pool.query("UPDATE public.v13_production_intent SET exchange_order_id='late-provider-evidence' WHERE kind='EXIT'");
   assert.deepEqual(await read(true),await read(false));assert.equal((await read(true)).length,2);
   assert.throws(()=>economicExitNotDischarged('account_id','client_order_id',true),/qualified_outer_alias_required/);
   assert.throws(()=>economicExitNotDischarged('economic_candidate.account_id','r.client_order_id',true),/qualified_outer_alias_required/);
   process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED='false';
   try{assert.equal(economicExitNotDischarged('r.account_id','r.client_order_id',true),'');}finally{process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED='true';}
  });
  await t.test('one immutable discharge; cash/events unchanged; reserve zero, stopped fence advances',async()=>{
   const x=await seed(),before=await current(),result=await run(x);assert.equal(result.ok,true,JSON.stringify(result));
   const after=await current();assert.equal(after.cash_micros,before.cash_micros);assert.equal(after.events,2);assert.equal(after.reserved_micros,'0');assert.equal(after.receipts,1);
   assert.equal(after.exit,'DISPATCHED');assert.equal(after.marker,'UNKNOWN');assert.equal(after.lease,'released');assert.equal(after.fencing_token,'62');assert.equal(after.owner_control_epoch,'1');assert.equal(after.execution_enabled,false);assert.equal(after.kill_switch,true);assert.equal(after.arm_requested,false);
   const receipt=await economicDischargeOutcome(x.scope.ownerId,x.scope.requestId,pool);assert.equal(receipt.ok,true);assert.equal(receipt.status,'RECORDED');
   assert.equal((await run(x)).ok,false);assert.deepEqual(await current(),after);
   assert.deepEqual(await readUnresolvedIntentMode(pool.query.bind(pool),x.f.account.id),{ok:true,mode:'entries'});
  });
  await t.test('submillisecond original dispatch is copied exactly into the receipt, never rewritten',async()=>{
   const x=await seed(),before=await current();
   await pool.query("UPDATE public.v13_production_intent SET dispatch_at=dispatch_at+interval '500 microseconds' WHERE kind='EXIT'");
   const result=await run(x);assert.equal(result.ok,true,JSON.stringify(result));
   const {rows:[match]}=await pool.query(`SELECT i.dispatch_at=d.exit_dispatch_at AS exact,
    i.dispatch_at<>date_trunc('milliseconds',i.dispatch_at) AS has_submillisecond,d.transport_outcome
    FROM private.strata_economic_exit_discharge d JOIN public.v13_production_intent i ON i.id=d.exit_intent_id`);
   assert.deepEqual(match,{exact:true,has_submillisecond:true,transport_outcome:'UNKNOWN'});
   assert.equal((await current()).cash_micros,before.cash_micros);
  });
  await t.test('a dispatch changed beyond the proved millisecond cannot silently release',async()=>{
   const x=await seed();await pool.query("UPDATE public.v13_production_intent SET dispatch_at=dispatch_at+interval '1 millisecond' WHERE kind='EXIT'");
   const before=await current(),result=await run(x);assert.equal(result.ok,false);
   assert.deepEqual(await current(),before);
  });
  await t.test('simultaneous discharges cannot release reserve twice',async()=>{
   const x=await seed(),results=await Promise.all([run(x),run(x)]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal((await current()).receipts,1);assert.equal((await current()).events,2);
  });
  await t.test('stale proof, changed stop epoch, wrong worker fence and unrelated hold refuse atomically',async()=>{
   for(const kind of ['stale','epoch','worker','hold']){const x=await seed();
    if(kind==='epoch')await pool.query('UPDATE public.v13_production_account SET owner_control_epoch=1');
    if(kind==='worker')await pool.query('UPDATE private.kalshi_account_worker_lease SET fencing_token=62');
    if(kind==='hold')await pool.query("UPDATE public.v13_production_account SET blocked_reason='loss_limit'");
    const before=await current();assert.equal((await run(x,kind==='stale'?{now:()=>x.f.nowMs+5001}:{})).ok,false);assert.deepEqual(await current(),before);
   }
  });
  await t.test('a failed worker fence rolls back the earlier guarded parent write',async()=>{
   const x=await seed();
   await pool.query('UPDATE private.kalshi_account_worker_lease SET fencing_token=62');
   const before=(await pool.query("SELECT reserved_micros::text FROM public.v13_production_intent WHERE kind='ENTRY'")).rows;
   const result=await run(x);assert.equal(result.reason,'economic_discharge_worker_fence_changed');
   const after=(await pool.query("SELECT reserved_micros::text FROM public.v13_production_intent WHERE kind='ENTRY'")).rows;
   assert.deepEqual(after,before);assert.equal(after[0]?.reserved_micros,x.f.account.reserved_micros);
   assert.equal((await current()).receipts,0);
  });
  await t.test('lost acknowledgement after real COMMIT is UNKNOWN, resolved by exact readback only',async()=>{
   const x=await seed();const db={connect:async()=>{const c=await pool.connect();return new Proxy(c,{get(target,key){if(key==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(args[0]==='COMMIT')throw Error('synthetic_ack_lost');return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}} as unknown as Pool;
   const result=await run(x,{db});assert.equal(result.status,'UNKNOWN');assert.equal(result.reserveReleased,null);assert.equal((await current()).receipts,1);
   const outcome=await economicDischargeOutcome(x.scope.ownerId,x.scope.requestId,pool);assert.equal(outcome.ok,true);assert.equal(outcome.status,'RECORDED');
  });
  await t.test('cancellation tombstone defeats a delayed writer, not a recorded discharge',async()=>{
   const x=await seed(),before=await current();assert.equal((await cancelEconomicDischarge(x.scope.ownerId,x.scope.requestId,pool)).status,'CANCELED');assert.equal((await run(x)).ok,false);assert.deepEqual(await current(),before);
   const y=await seed();assert.equal((await run(y)).ok,true);assert.equal((await cancelEconomicDischarge(y.scope.ownerId,y.scope.requestId,pool)).status,'RECORDED');assert.equal((await current()).receipts,1);
  });
  await t.test('waited cancellation becomes visible before the reserve writer proceeds',async()=>{
   const x=await seed(),before=await current(),c=await pool.connect();
   try{
    await c.query('BEGIN');
    await c.query('SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE',[x.f.account.id]);
    await c.query('INSERT INTO private.strata_economic_exit_discharge_cancel(owner_user_id,request_id) VALUES($1,$2)',
     [x.scope.ownerId,x.scope.requestId]);
    const writer=run(x);let waiting=false;
    for(let i=0;i<30&&!waiting;i++){
     const r=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
       AND query LIKE '%economic-discharge:%' LIMIT 1`);
     waiting=r.rows.length===1;if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
    }
    await c.query('COMMIT');const result=await writer;
    assert.equal(waiting,true);assert.equal(result.reason,'economic_discharge_request_canceled');
    assert.deepEqual(await current(),before);
   }finally{await c.query('ROLLBACK');c.release();}
  });
  await t.test('owner isolation and immutable receipts survive direct readback/cancel attempts',async()=>{
   const x=await seed();assert.equal((await run(x)).ok,true);const foreign=randomUUID();await pool.query('INSERT INTO auth.users VALUES($1)',[foreign]);
   assert.equal((await economicDischargeOutcome(foreign,x.scope.requestId,pool)).status,'NOT_RECORDED');assert.equal((await cancelEconomicDischarge(foreign,x.scope.requestId,pool)).status,'CANCELED');assert.equal((await current()).receipts,1);
   await assert.rejects(pool.query('UPDATE private.strata_economic_exit_discharge SET payload=payload'),/immutable/);await assert.rejects(pool.query('DELETE FROM private.strata_economic_exit_discharge'),/immutable/);
  });
  await t.test('late order/fill or altered stored evidence cannot borrow historical discharge',async()=>{
   const x=await seed();assert.equal((await run(x)).ok,true);const ds=await readEconomicExitDischarges(pool,x.f.account.id);
   const client=String(economicDischargePlan(x.proof).exitRequest.clientOrderId);
   assert.throws(()=>assertNoEconomicExitContradiction(ds,{orders:[{request:{clientOrderId:client}}],fills:[]}));
   assert.throws(()=>assertNoEconomicExitContradiction(ds,{orders:[],fills:[{clientOrderId:client}]}));
   await pool.query("UPDATE public.v13_production_intent SET exchange_order_id='late-order' WHERE kind='EXIT'");
   assert.equal((await pool.query('SELECT private.strata_has_economic_exit_discharge($1,$2) verified',[x.f.account.id,client])).rows[0].verified,false);
   await assert.rejects(readEconomicExitDischarges(pool,x.f.account.id),/contradiction/);
   assert.deepEqual(await readUnresolvedIntentMode(pool.query.bind(pool),x.f.account.id),{ok:true,mode:'recovery'});
   assert.equal((await economicDischargeOutcome(x.scope.ownerId,x.scope.requestId,pool)).status,'UNKNOWN');
  });
  await t.test('changed canonical cash, P&L or settlement time revokes discharge recognition',async()=>{
   // A digest column alone cannot bless modified event economics. Both the
   // direct SQL gate and durable readback must reject even a one-micro change.
   for(const mutation of ["cash_delta_micros=cash_delta_micros+1","pnl_micros=pnl_micros+1","occurred_at=occurred_at+interval '1 millisecond'"]){
    const x=await seed();assert.equal((await run(x)).ok,true);
    const client=String(economicDischargePlan(x.proof).exitRequest.clientOrderId);
    await pool.query("UPDATE public.v13_production_event SET "+mutation+" WHERE kind='SETTLEMENT'");
    assert.equal((await pool.query('SELECT private.strata_has_economic_exit_discharge($1,$2) verified',[x.f.account.id,client])).rows[0].verified,false);
    await assert.rejects(readEconomicExitDischarges(pool,x.f.account.id),/contradiction/);
    assert.deepEqual(await readUnresolvedIntentMode(pool.query.bind(pool),x.f.account.id),{ok:true,mode:'recovery'});
    assert.equal((await economicDischargeOutcome(x.scope.ownerId,x.scope.requestId,pool)).status,'UNKNOWN');
   }
  });
  await t.test('browser and paper roles have no discharge read/write privileges',async()=>{
   const rows=(await pool.query("SELECT role,has_table_privilege(role,'private.strata_economic_exit_discharge','SELECT') AS can_read,has_table_privilege(role,'private.strata_economic_exit_discharge','INSERT') AS can_write FROM unnest(ARRAY['anon','authenticated','strata_paper_runtime']) role")).rows;
   assert.equal(rows.length,3);assert.ok(rows.every(r=>!r.can_read&&!r.can_write));
   assert.equal((await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_economic_exit_discharge'::regclass")).rows[0].relrowsecurity,true);
  });
 }finally{await pool.end();}
});
