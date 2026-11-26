/** Native PostgreSQL, disposable Unix-socket database ONLY. No production client,
 * external network, live credential, venue operation, or owner action is used. */
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {hasHeldExitReceipt,heldExitReceiptTimeLeft,keepHeldExitReceipt,moveHeldExitReceipt,recheckHeldExitReceipt} from './protectiveExitSettledCarry';
import {runtimeSettledExitReceipt} from './runtimeSettledExitGuard';
import {stoppedArmExposure,verifyDisposedExitAgainstSnapshot} from './armSettledReserveScope';
import {disposeSettledExitReserve,readSettledExitReserveOutcome} from './settledExitReserveDisposition';
import {inspectSettledExitReserve} from './settledExitReserveEvidence';
import {economicSettlementFixture} from './ownerEconomicSettlementFixture';
import {proveEconomicSettlement,economicSettlementPlan} from './ownerEconomicSettlementProof';
import {commitEconomicSettlement,economicSettlementOutcome,cancelEconomicSettlement,type EconomicCommitScope} from './ownerEconomicSettlementCommit';

const url=new URL(process.env.DATABASE_URL??'');
if(process.env.NODE_ENV!=='test'||process.env.STRATA_ISOLATED_ECONOMIC_TEST!=='1'||url.pathname!=='/strata_economic_fixture'||
 url.searchParams.get('host')!==process.env.STRATA_ECONOMIC_SOCKET||!/^\/tmp\/strata-economic-[A-Za-z0-9]+\/socket$/.test(process.env.STRATA_ECONOMIC_SOCKET??'')||url.hostname!=='')throw Error('disposable_unix_socket_database_required');
const schema=`CREATE SCHEMA auth;CREATE SCHEMA private;
 DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','strata_api_runtime','strata_paper_runtime'] LOOP IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',role_name); END IF; END LOOP; END $$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid REFERENCES auth.users(id),subaccount integer,exchange_index integer,
  key_fingerprint text,revision bigint,owner_control_epoch bigint DEFAULT 0,cash_micros bigint,reserved_micros bigint,initial_cash_micros bigint,
  execution_enabled boolean DEFAULT true,kill_switch boolean DEFAULT false,blocked_reason text DEFAULT 'retained-incident',reconciled_at timestamptz);
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text REFERENCES public.v13_production_account(id),parent_id text,
  kind text,state text,terminal boolean,exchange_order_id text,filled_hundredths bigint,reserved_micros bigint,client_order_id text);
 CREATE TABLE public.v13_production_position(id text PRIMARY KEY,account_id text REFERENCES public.v13_production_account(id),market text,side text,
  quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE public.v13_production_event(account_id text REFERENCES public.v13_production_account(id),event_id text,intent_id text,
  kind text,digest text,payload jsonb,cash_delta_micros bigint,pnl_micros bigint,occurred_at timestamptz,PRIMARY KEY(account_id,event_id));
 CREATE TABLE private.strata_emergency_exit_reservations(reservation_id uuid PRIMARY KEY,owner_user_id uuid,
  execution_account_id text REFERENCES public.v13_production_account(id),client_order_id text,state text,trading_authorized boolean,market_ticker text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),owner_user_id uuid,
  state text,arm_requested boolean,fencing_token bigint,heartbeat_at timestamptz);
 CREATE TABLE public.v13_production_observation(id uuid PRIMARY KEY,account_id text,kind text,payload jsonb,digest text);`;

async function seed(){
 await pool.query('TRUNCATE public.v13_production_account,auth.users CASCADE');
 const f=economicSettlementFixture(Date.now()),a=f.account;
 await pool.query('INSERT INTO auth.users VALUES($1)',[a.owner_user_id]);
 await pool.query(`INSERT INTO public.v13_production_account(id,owner_user_id,subaccount,exchange_index,key_fingerprint,revision,cash_micros,reserved_micros,initial_cash_micros)
  VALUES($1,$2,1,2,$3,$4,$5,$6,$7)`,[a.id,a.owner_user_id,a.key_fingerprint,a.revision,a.cash_micros,a.reserved_micros,a.initial_cash_micros]);
 for(const i of f.history.rows)await pool.query(`INSERT INTO public.v13_production_intent(id,account_id,parent_id,kind,state,terminal,exchange_order_id,filled_hundredths,reserved_micros,client_order_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[i.id,a.id,i.parent_id,i.kind,i.state,i.terminal,i.exchange_order_id,i.filled_hundredths,i.reserved_micros,i.client_order_id]);
 const p=f.history.positions[0]!;await pool.query('INSERT INTO public.v13_production_position VALUES($1,$2,$3,$4,$5,$6,$7)',[p.id,a.id,p.market,p.side,p.quantity_hundredths,p.basis_micros,p.realized_pnl_micros]);
 for(const e of f.history.events)await pool.query('INSERT INTO public.v13_production_event VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[a.id,e.event_id,e.intent_id,e.kind,e.digest,JSON.stringify(e.payload),e.cash_delta_micros,e.pnl_micros,e.occurred_at]);
 const m=f.history.markers[0]!;await pool.query('INSERT INTO private.strata_emergency_exit_reservations VALUES($1,$2,$3,$4,$5,false,$6)',[m.reservation_id,a.owner_user_id,a.id,m.client_order_id,'UNKNOWN',m.market_ticker]);
 await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,'owned',false,61,clock_timestamp()-interval '1 hour')",[a.id,a.owner_user_id]);
 const proof=proveEconomicSettlement(f),scope:EconomicCommitScope={requestId:randomUUID(),ownerId:a.owner_user_id,scopeDigest:'b'.repeat(64),releaseSha:'c'.repeat(40),controlEpoch:'0',workerFence:'61'};
 return {f,proof,scope};
}
const locked=async(tx:PoolClient)=>{await tx.query('SELECT * FROM private.kalshi_account_worker_lease FOR UPDATE');};
async function unchanged(f:ReturnType<typeof economicSettlementFixture>){
 const a=(await pool.query('SELECT * FROM public.v13_production_account WHERE id=$1',[f.account.id])).rows[0];
 assert.equal(a.cash_micros,f.account.cash_micros);assert.equal(a.reserved_micros,'3000000');assert.equal(a.revision,'17');
 assert.equal((await pool.query("SELECT count(*)::int n FROM public.v13_production_event WHERE kind='SETTLEMENT'")).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM private.strata_economic_settlement_receipt')).rows[0].n,0);
}

test('native accounting transaction, retained UNKNOWN, idempotency and failure qualification',async t=>{
 try{
  const identity=(await pool.query('SELECT current_database() db,inet_server_addr() host')).rows[0];assert.equal(identity.db,'strata_economic_fixture');assert.equal(identity.host,null);
  await pool.query(schema);
  await pool.query(readFileSync('../../supabase/migrations/20261126004500_economic_settlement_receipt.sql','utf8'));
  await pool.query(readFileSync('../../supabase/migrations/20261126124100_settled_exit_reserve_disposition.sql','utf8'));
  await t.test('atomic reserve disposition preserves booked cash, exit, marker, position and worker',async()=>{
   const {f,proof,scope}=await seed();
   assert.equal((await commitEconomicSettlement(proof,scope,{db:pool,verifyLocked:locked})).ok,true);
   const a=(await pool.query('SELECT * FROM public.v13_production_account')).rows[0];
   const events=(await pool.query('SELECT * FROM public.v13_production_event WHERE account_id=$1 ORDER BY event_id',[a.id])).rows;
   const positions=(await pool.query('SELECT * FROM public.v13_production_position WHERE account_id=$1',[a.id])).rows;
   const evidence={...f,account:a,history:{...f.history,events,positions}};
   const release={...scope,requestId:randomUUID()};
   const opts={db:pool,now:()=>f.nowMs,verifyLocked:locked};
   assert.equal((await disposeSettledExitReserve(evidence,{...release,ownerId:randomUUID()},opts)).status,'REFUSED');
   assert.equal((await disposeSettledExitReserve(evidence,release,{...opts,now:()=>f.nowMs+5001})).status,'REFUSED');
   assert.equal((await disposeSettledExitReserve(evidence,{...release,workerFence:'62'},opts)).status,'REFUSED');
   assert.equal((await pool.query('SELECT reserved_micros FROM public.v13_production_account')).rows[0].reserved_micros,'3000000');
   assert.equal((await pool.query("SELECT reserved_micros FROM public.v13_production_intent WHERE kind='ENTRY'")).rows[0].reserved_micros,'3000000');
   // Two identical callers serialize on the exact account; both see one result.
   assert.equal((await readSettledExitReserveOutcome(pool,scope.ownerId,release.requestId)).status,'NOT_RECORDED');
   assert.equal((await stoppedArmExposure(pool,a.id,scope.ownerId,false,true)).clear,false);
   const [x,y]=await Promise.all([disposeSettledExitReserve(evidence,release,opts),disposeSettledExitReserve(evidence,release,opts)]);
   assert.equal(x.status,'RECORDED');assert.equal(y.status,'RECORDED');
   assert.equal((await readSettledExitReserveOutcome(pool,scope.ownerId,release.requestId)).status,'RECORDED');
   assert.notEqual((await readSettledExitReserveOutcome(pool,randomUUID(),release.requestId)).status,'RECORDED');
   assert.equal((await stoppedArmExposure(pool,a.id,scope.ownerId,false,false)).clear,false);
   assert.equal((await stoppedArmExposure(pool,a.id,randomUUID(),false,true)).clear,false);
   const admitted=await stoppedArmExposure(pool,a.id,scope.ownerId,false,true);
   assert.equal(admitted.clear,true);assert.equal(admitted.receipts.length,1);
   const receipt=admitted.receipts[0]!;
   const oldSha=process.env.RAILWAY_GIT_COMMIT_SHA,oldFlag=process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA;
   const restoreFlags=()=>{
    if(oldSha===undefined)delete process.env.RAILWAY_GIT_COMMIT_SHA;else process.env.RAILWAY_GIT_COMMIT_SHA=oldSha;
    if(oldFlag===undefined)delete process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA;else process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA=oldFlag;
   };
   try{
    process.env.RAILWAY_GIT_COMMIT_SHA='a'.repeat(40);process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA='a'.repeat(40);
    const x={accountId:a.id,ownerId:scope.ownerId,snapshot:f.snapshot,nowMs:f.nowMs},guard=(extra:Partial<typeof x>={})=>runtimeSettledExitReceipt(pool,{...x,...extra});
    assert.equal((await guard())?.exitId,f.exitId);
    assert.equal(await guard({ownerId:randomUUID()}),null);
    assert.equal(await guard({nowMs:f.nowMs+5001}),null);
    assert.equal(await guard({snapshot:{...f.snapshot,complete:false}}),null);
    assert.equal(await guard({snapshot:{...f.snapshot,identity:{...f.snapshot.identity,keyFingerprint:'b'.repeat(64)}}}),null);
    assert.equal(await guard({snapshot:{...f.snapshot,settlements:[]}}),null);
    assert.equal(await guard({snapshot:{...f.snapshot,orders:[...f.snapshot.orders,
     {orderId:'late',request:f.history.requests[1]!,terminal:true,filledHundredths:'0'}]}}),null);
    assert.equal((await guard({snapshot:{...f.snapshot,positions:[{market:'KXBTC15M-DIFFERENT',side:'YES',quantityHundredths:'100'}]}}))?.exitId,f.exitId);
    await pool.query("INSERT INTO public.v13_production_intent(id,account_id,kind,state,terminal,reserved_micros) VALUES('wire-intent',$1,'ENTRY','DISPATCHED',false,0)",[a.id]);
    assert.equal(await guard(),null);
    assert.equal((await runtimeSettledExitReceipt(pool,{...x,currentIntentId:'wire-intent'}))?.exitId,f.exitId);
    await pool.query("UPDATE public.v13_production_intent SET state='UNKNOWN' WHERE id='wire-intent'");
    assert.equal(await runtimeSettledExitReceipt(pool,{...x,currentIntentId:'wire-intent'}),null);
    await pool.query("DELETE FROM public.v13_production_intent WHERE id='wire-intent'");
    const newMarker=randomUUID();
    await pool.query("INSERT INTO private.strata_emergency_exit_reservations(reservation_id,owner_user_id,execution_account_id,state,trading_authorized) VALUES($1,$2,$3,'PREPARED',false)",[newMarker,scope.ownerId,a.id]);
    assert.equal(await guard(),null);
    await pool.query("DELETE FROM private.strata_emergency_exit_reservations WHERE reservation_id=$1",[newMarker]);
    // Orders-off simulation of the actual actor's durable PREPARED -> UNKNOWN
    // transition. The old pair remains untouched; no exchange transport exists.
    const nextExit=randomUUID(),nextReservation=randomUUID(),clientId=`v13p-${nextExit}`;
    const scopeProof={accountId:a.id,ownerId:scope.ownerId,clientId};
    const advisory={},committedMarker={};
    keepHeldExitReceipt(advisory,scopeProof,f.snapshot,receipt.receiptDigest);
    assert.equal((await recheckHeldExitReceipt(pool,advisory,scopeProof,f.nowMs,'reserve'))?.exitId,f.exitId);
    assert.equal(await recheckHeldExitReceipt(pool,{...advisory},scopeProof,f.nowMs,'reserve'),null);
    assert.equal(await recheckHeldExitReceipt(pool,advisory,{...scopeProof,clientId:`v13p-${randomUUID()}`},f.nowMs,'reserve'),null);
    await pool.query("INSERT INTO public.v13_production_intent(id,account_id,kind,state,terminal,reserved_micros,filled_hundredths,client_order_id) VALUES($1,$2,'EXIT','PREPARED',false,0,0,$3)",[nextExit,a.id,clientId]);
    await pool.query("INSERT INTO private.strata_emergency_exit_reservations(reservation_id,owner_user_id,execution_account_id,client_order_id,state,trading_authorized) VALUES($1,$2,$3,$4,'PREPARED',false)",[nextReservation,scope.ownerId,a.id,clientId]);
    assert.equal((await recheckHeldExitReceipt(pool,advisory,scopeProof,f.nowMs,'mark',nextReservation))?.reservationId,f.reservationId);
    assert.equal(await recheckHeldExitReceipt(pool,advisory,scopeProof,f.nowMs,'mark',f.reservationId),null);
    assert.equal(await recheckHeldExitReceipt(pool,advisory,scopeProof,f.nowMs,'wire',nextReservation),null);
    await pool.query("UPDATE public.v13_production_intent SET state='DISPATCHED' WHERE id=$1",[nextExit]);
    await pool.query("UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN' WHERE reservation_id=$1",[nextReservation]);
    moveHeldExitReceipt(advisory,committedMarker);assert.equal(hasHeldExitReceipt(committedMarker),true);
    assert.equal((await recheckHeldExitReceipt(pool,committedMarker,scopeProof,f.nowMs,'wire',nextReservation))?.exitId,f.exitId);
    assert.equal(heldExitReceiptTimeLeft(committedMarker,f.nowMs+5001),0);
    assert.equal(await recheckHeldExitReceipt(pool,committedMarker,scopeProof,f.nowMs+5001,'wire',nextReservation),null);
    await pool.query("UPDATE public.v13_production_intent SET state='UNKNOWN' WHERE id=$1",[nextExit]);
    assert.equal(await recheckHeldExitReceipt(pool,committedMarker,scopeProof,f.nowMs,'wire',nextReservation),null);
    await pool.query("DELETE FROM private.strata_emergency_exit_reservations WHERE reservation_id=$1",[nextReservation]);
    await pool.query("DELETE FROM public.v13_production_intent WHERE id=$1",[nextExit]);
   }finally{restoreFlags();}
   assert.equal(receipt.exitId,f.exitId);assert.equal(receipt.reservationId,f.reservationId);
   assert.doesNotThrow(()=>verifyDisposedExitAgainstSnapshot(receipt,f.snapshot));
   assert.throws(()=>verifyDisposedExitAgainstSnapshot(receipt,{...f.snapshot,settlements:[]}));
   assert.throws(()=>verifyDisposedExitAgainstSnapshot(receipt,{...f.snapshot,orders:[...f.snapshot.orders,
    {orderId:'later-order',request:f.history.requests[1]!,terminal:true,filledHundredths:'0'}]}));
   assert.throws(()=>verifyDisposedExitAgainstSnapshot(receipt,{...f.snapshot,fills:[...f.snapshot.fills,
    {...f.snapshot.fills[0]!,id:'later-fill',clientOrderId:f.history.requests[1]!.clientOrderId,action:'SELL'}]}));
   assert.throws(()=>verifyDisposedExitAgainstSnapshot(receipt,{...f.snapshot,positions:[
    {market:receipt.market,side:'NO',quantityHundredths:'1'}]}));
   await pool.query("INSERT INTO public.v13_production_intent(id,account_id,kind,state,terminal,reserved_micros) VALUES('another',$1,'ENTRY','UNKNOWN',false,0)",[a.id]);
   assert.equal((await stoppedArmExposure(pool,a.id,scope.ownerId,false,true)).clear,false);
   await pool.query("DELETE FROM public.v13_production_intent WHERE id='another'");
   await pool.query("INSERT INTO private.strata_emergency_exit_reservations(reservation_id,owner_user_id,execution_account_id,state,trading_authorized) VALUES($1,$2,$3,'UNKNOWN',false)",[randomUUID(),scope.ownerId,a.id]);
   assert.equal((await stoppedArmExposure(pool,a.id,scope.ownerId,false,true)).clear,false);
   await pool.query('DELETE FROM private.strata_emergency_exit_reservations WHERE reservation_id<>$1',[f.reservationId]);
   assert.equal((await disposeSettledExitReserve(evidence,{...release,requestId:randomUUID()},opts)).status,'REFUSED');
   const after=(await pool.query('SELECT * FROM public.v13_production_account')).rows[0];
   assert.equal(after.cash_micros,a.cash_micros);assert.equal(after.reserved_micros,'0');assert.equal(after.revision,'19');
   assert.deepEqual((await pool.query('SELECT * FROM public.v13_production_event WHERE account_id=$1 ORDER BY event_id',[a.id])).rows,events);
   assert.deepEqual((await pool.query('SELECT * FROM public.v13_production_position WHERE account_id=$1',[a.id])).rows,positions);
   assert.deepEqual((await pool.query("SELECT state,terminal,exchange_order_id FROM public.v13_production_intent WHERE kind='EXIT'")).rows,[{state:'DISPATCHED',terminal:false,exchange_order_id:null}]);
   assert.deepEqual((await pool.query('SELECT state,trading_authorized FROM private.strata_emergency_exit_reservations')).rows,[{state:'UNKNOWN',trading_authorized:false}]);
   assert.equal((await pool.query('SELECT arm_requested FROM private.kalshi_account_worker_lease')).rows[0].arm_requested,false);
   assert.deepEqual((await pool.query('SELECT released_micros,transport_outcome,trading_authorized FROM private.strata_settled_exit_reserve_disposition')).rows,
    [{released_micros:'3000000',transport_outcome:'UNKNOWN',trading_authorized:false}]);
   await assert.rejects(pool.query('DELETE FROM private.strata_settled_exit_reserve_disposition'),/immutable/);
   for(const role of ['anon','authenticated','strata_paper_runtime'])
    assert.equal((await pool.query("SELECT has_table_privilege($1,'private.strata_settled_exit_reserve_disposition','INSERT') ok",[role])).rows[0].ok,false);
  });
  await t.test('one canonical event + immutable receipt + conserved cash/P&L; no control/reserve/lease changes',async()=>{
   const {f,proof,scope}=await seed();const r=await commitEconomicSettlement(proof,scope,{db:pool,verifyLocked:locked});assert.equal(r.ok,true,JSON.stringify(r));
   assert.equal(r.accountingPosted,true);const p=economicSettlementPlan(proof);
   const a=(await pool.query('SELECT * FROM public.v13_production_account')).rows[0];assert.equal(a.cash_micros,p.cashAfterMicros);assert.equal(a.revision,'18');
   assert.equal(a.reserved_micros,'3000000');assert.equal(a.execution_enabled,true);assert.equal(a.kill_switch,false);assert.equal(a.blocked_reason,'retained-incident');assert.equal(a.reconciled_at,null);
   const i=(await pool.query('SELECT * FROM public.v13_production_intent WHERE id=$1',[f.exitId])).rows[0];assert.equal(i.state,'DISPATCHED');assert.equal(i.terminal,false);assert.equal(i.exchange_order_id,null);
   const m=(await pool.query('SELECT * FROM private.strata_emergency_exit_reservations')).rows[0];assert.equal(m.state,'UNKNOWN');assert.equal(m.trading_authorized,false);
   const w=(await pool.query('SELECT * FROM private.kalshi_account_worker_lease')).rows[0];assert.equal(w.state,'owned');assert.equal(w.arm_requested,false);assert.equal(w.fencing_token,'61');
   const stored=(await pool.query('SELECT * FROM private.strata_economic_settlement_receipt WHERE request_id=$1',[scope.requestId])).rows[0];
   const events=(await pool.query('SELECT * FROM public.v13_production_event WHERE account_id=$1 ORDER BY event_id',[a.id])).rows;
   const positions=(await pool.query('SELECT * FROM public.v13_production_position WHERE account_id=$1',[a.id])).rows;
   const evidence={...f,account:a,history:{...f.history,events,positions}};
   const inspected=inspectSettledExitReserve(evidence,stored);
   assert.equal(inspected.status,'SETTLED_WITH_UNKNOWN_TRANSPORT_EVIDENCE_MATCHED');
   assert.equal(inspected.reserveReleased,false);assert.equal(inspected.transportOutcome,'UNKNOWN');
   assert.throws(()=>inspectSettledExitReserve({...evidence,snapshot:{...f.snapshot,cashMicros:'1'}},stored));
   const repeated=await commitEconomicSettlement(proof,scope,{db:pool,verifyLocked:locked});assert.equal(repeated.ok,false);
   assert.equal((await economicSettlementOutcome(scope.ownerId,scope.requestId,pool)).ok,true);
   assert.equal((await pool.query("SELECT count(*)::int n FROM public.v13_production_event WHERE kind='SETTLEMENT'")).rows[0].n,1);
   for(const sql of ["UPDATE private.strata_economic_settlement_receipt SET transport_outcome='UNKNOWN'",'DELETE FROM private.strata_economic_settlement_receipt'])await assert.rejects(pool.query(sql),/immutable/);
   for(const role of ['anon','authenticated','strata_paper_runtime'])for(const action of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await pool.query('SELECT has_table_privilege($1,$2,$3) allowed',[role,'private.strata_economic_settlement_receipt',action])).rows[0].allowed,false);
   assert.equal((await pool.query("SELECT has_table_privilege('strata_api_runtime','private.strata_economic_settlement_receipt','INSERT') allowed")).rows[0].allowed,true);
   assert.equal((await economicSettlementOutcome('99999999-9999-4999-8999-999999999999',scope.requestId,pool)).ok,false);
  });
  await t.test('receipt scope refusal rolls back event, position, account and observation together',async()=>{
   const {f,proof,scope}=await seed();const r=await commitEconomicSettlement(proof,{...scope,workerFence:'62'},{db:pool,verifyLocked:locked});assert.equal(r.ok,false);await unchanged(f);
   assert.equal((await pool.query('SELECT quantity_hundredths::text qty FROM public.v13_production_position')).rows[0].qty,'300');
  });
  await t.test('stale proof and changed stop epoch cannot write',async()=>{
   let x=await seed();assert.equal((await commitEconomicSettlement(x.proof,x.scope,{db:pool,now:()=>x.f.nowMs+5001,verifyLocked:locked})).ok,false);await unchanged(x.f);
   x=await seed();await pool.query('UPDATE public.v13_production_account SET owner_control_epoch=1,kill_switch=true');
   assert.equal((await commitEconomicSettlement(x.proof,x.scope,{db:pool,verifyLocked:locked})).ok,false);await unchanged(x.f);
   assert.equal((await pool.query('SELECT kill_switch FROM public.v13_production_account')).rows[0].kill_switch,true);
  });
  await t.test('simultaneous duplicate attempts credit only once',async()=>{
   const {proof,scope}=await seed();const results=await Promise.all([1,2].map(()=>commitEconomicSettlement(proof,scope,{db:pool,verifyLocked:locked})));
   assert.equal(results.filter(r=>r.ok).length,1);assert.equal((await economicSettlementOutcome(scope.ownerId,scope.requestId,pool)).ok,true);
   assert.equal((await pool.query("SELECT count(*)::int n FROM public.v13_production_event WHERE kind='SETTLEMENT'")).rows[0].n,1);
  });
  await t.test('lost acknowledgement after actual COMMIT returns UNKNOWN, exact readback resolves without retry',async()=>{
   const {proof,scope}=await seed();let dropped=false,rollbackAfterDrop=false;
   const wrapped={query:pool.query.bind(pool),connect:async()=>{
    const client=await pool.connect();return new Proxy(client,{get(target,key){
     if(key==='query')return async(...args:unknown[])=>{const sql=String(args[0]);if(dropped&&sql==='ROLLBACK')rollbackAfterDrop=true;
      const r=await Reflect.apply(target.query,target,args);if(sql==='COMMIT'&&!dropped){dropped=true;throw Error('synthetic_lost_commit_ack');}return r;};
     const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
   }} as unknown as Pool;
   const r=await commitEconomicSettlement(proof,scope,{db:wrapped,verifyLocked:locked});assert.equal(r.status,'UNKNOWN');assert.equal(r.accountingPosted,null);assert.equal(rollbackAfterDrop,false);
   assert.equal((await economicSettlementOutcome(scope.ownerId,scope.requestId,pool)).ok,true);
   assert.equal((await pool.query("SELECT count(*)::int n FROM public.v13_production_event WHERE kind='SETTLEMENT'")).rows[0].n,1);
  });
  await t.test('durable cancellation fences a delayed POST and cannot erase a recorded settlement',async()=>{
   const x=await seed();const cancel=await cancelEconomicSettlement(x.scope.ownerId,x.scope.requestId,pool);
   assert.equal(cancel.status,'CANCELED');assert.equal(cancel.accountingPosted,false);
   const delayed=await commitEconomicSettlement(x.proof,x.scope,{db:pool,verifyLocked:locked});
   assert.equal(delayed.ok,false);assert.equal(delayed.reason,'economic_settlement_request_canceled');await unchanged(x.f);
   await assert.rejects(pool.query('DELETE FROM private.strata_economic_settlement_cancel'),/immutable/);
   const y=await seed();const posted=await commitEconomicSettlement(y.proof,y.scope,{db:pool,verifyLocked:locked});assert.equal(posted.ok,true);
   const after=await cancelEconomicSettlement(y.scope.ownerId,y.scope.requestId,pool);assert.equal(after.status,'RECORDED');assert.equal(after.accountingPosted,true);
  });
  await t.test('foreign owner cancellation cannot invalidate the real owner request',async()=>{
   const x=await seed(),foreign='99999999-9999-4999-8999-999999999999';await pool.query('INSERT INTO auth.users VALUES($1)',[foreign]);
   assert.equal((await cancelEconomicSettlement(foreign,x.scope.requestId,pool)).status,'CANCELED');
   assert.equal((await commitEconomicSettlement(x.proof,x.scope,{db:pool,verifyLocked:locked})).ok,true);
  });
  await t.test('cancellation and posting serialize to one truthful outcome',async()=>{
   const x=await seed();const [posted,canceled]=await Promise.all([
    commitEconomicSettlement(x.proof,x.scope,{db:pool,verifyLocked:locked}),cancelEconomicSettlement(x.scope.ownerId,x.scope.requestId,pool)]);
   const result=await economicSettlementOutcome(x.scope.ownerId,x.scope.requestId,pool);
   assert.ok(['RECORDED','CANCELED'].includes(result.status));
   const count=(await pool.query("SELECT count(*)::int n FROM public.v13_production_event WHERE kind='SETTLEMENT'")).rows[0].n;
   assert.equal(count,result.status==='RECORDED'?1:0);
   assert.notEqual(posted.ok&&canceled.status==='CANCELED',true);
  });
  await t.test('missing or altered owner evidence never obtains a financial receipt',async()=>{
   const {f,proof,scope}=await seed();const r=await commitEconomicSettlement(proof,scope,{db:pool,verifyLocked:async()=>{throw Error('economic_settlement_locked_scope_changed');}});assert.equal(r.ok,false);await unchanged(f);
   const readback=await economicSettlementOutcome(scope.ownerId,scope.requestId,pool);assert.equal(readback.status,'NOT_RECORDED');
  });
 }finally{await pool.end();}
});