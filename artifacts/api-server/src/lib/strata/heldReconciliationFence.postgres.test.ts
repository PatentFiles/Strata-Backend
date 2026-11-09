import test from 'node:test';
import assert from 'node:assert/strict';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {ProductionLedger,HeldReconciliationCommitUncertain,identity,type HeldReconciliationGuard} from '../v13-production/ledger';
import {digest,type Request,type Snapshot} from '../v13-production/types';
import {createUnknownEntryHeldFence} from './unknownEntryHeldFence';
import {backendRole,installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';

// Native-only suite. Run in its OWN freshly provisioned canonical disposable
// database with the existing full-schema runner. Never infer a target from an
// ambient DATABASE_URL. No HTTP, signing, credentials or real orders are used.
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
 'only the canonical freshly-created disposable PostgreSQL destination is allowed');
const NativePool=pool.constructor as new(config:{connectionString:string;options:string})=>Pool;
const db=new NativePool({connectionString:url,options:`-c role=${backendRole}`});
const owner='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
const financial='33333333-3333-4333-8333-333333333333',provider='44444444-4444-4444-8444-444444444444';
const secret='55555555-5555-4555-8555-555555555555',credential='66666666-6666-4666-8666-666666666666';
const account='full-schema-synthetic',hash='a'.repeat(64),policy='full-schema-policy',fingerprint='b'.repeat(64);
const request:Request={market:'KXBTC15M-SYNTHETIC',side:'NO',action:'BUY',contracts:3,limitMicros:430000,
 timeInForce:'IOC',reduceOnly:false,clientOrderId:`v13p-${target}`};
const scope={ownerId:owner,accountId:account,intentId:target,holderId:'offline-worker',fencingToken:'7',
 keyFingerprint:fingerprint,policyHash:hash,financialAccountId:financial,providerConnectionId:provider,vaultSecretId:secret};
async function reset(){
 await db.query("UPDATE public.live_execution_config SET mode='V13_PRODUCTION',live_execution_enabled=true,manual_kill_switch=false WHERE id='singleton'");
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
  VALUES($1,$2,$3,$4,'offline-worker',7,'owned',clock_timestamp(),$5,$6,false)`,[account,owner,financial,provider,fingerprint,secret]);
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

function guard():HeldReconciliationGuard {
 return {...createUnknownEntryHeldFence(scope),now:Date.now,deadlineMs:Date.now()+15000};
}
async function evidence(ledger:ProductionLedger):Promise<Snapshot> {
 const a=await ledger.readAccount(),now=Date.now();
 return {identity:identity(a),observedAtMs:now,historyFromMs:0,complete:true,authenticated:true,cashExact:true,
  cashMicros:'23720000',unexplainedCashActivity:false,
  orders:[{orderId:'offline-order',request,terminal:true,filledHundredths:'300'}],
  fills:[{id:'offline-fill',orderId:'offline-order',clientOrderId:request.clientOrderId,market:request.market,side:'NO',action:'BUY',
   quantityHundredths:'300',priceMicros:410000,grossMicros:'1230000',feeMicros:'50000',occurredAtMs:now-1000}],
  positions:[{market:request.market,side:'NO',quantityHundredths:'300'}],settlements:[]};
}
async function state(){
 return {
  account:(await db.query('SELECT cash_micros,reserved_micros,revision,blocked_reason FROM public.v13_production_account WHERE id=$1',[account])).rows[0],
  intent:(await db.query('SELECT state,terminal,filled_hundredths,reserved_micros FROM public.v13_production_intent WHERE id=$1',[target])).rows[0],
  position:(await db.query('SELECT quantity_hundredths,basis_micros FROM public.v13_production_position WHERE id=$1',[target])).rows[0],
  observations:(await db.query('SELECT kind,payload FROM public.v13_production_observation WHERE account_id=$1 ORDER BY kind',[account])).rows,
  events:(await db.query('SELECT event_id FROM public.v13_production_event WHERE account_id=$1',[account])).rows,
 };
}
const mutations=[
 ['KILL',"UPDATE public.v13_production_account SET kill_switch=true WHERE id=$1"],
 ['lease token',"UPDATE private.kalshi_account_worker_lease SET fencing_token=fencing_token+1 WHERE execution_account_id=$1"],
 ['policy',"UPDATE public.v13_live_money_policy SET state='REVOKED' WHERE execution_account_id=$1"],
 ['credential',"UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp() WHERE financial_account_id=(SELECT kalshi_connection_id FROM public.v13_production_account WHERE id=$1)"],
] as const;
// Preserve native event/connection flags for liveness attestation; change only
// COMMIT response delivery, never emulate its transaction effects in a fake DB.
function commitAckLossPool():Pool {
 return {connect:async()=>{
  const c=await db.connect(),query=c.query.bind(c),release=c.release.bind(c);
  const wrapped=Object.create(c) as PoolClient;
  wrapped.query=(async(sql:string,args?:unknown[])=>{const result=await query(sql,args);if(sql==='COMMIT')throw Error('injected lost native commit acknowledgment');return result;}) as PoolClient['query'];
  wrapped.on=c.on.bind(c);wrapped.removeListener=c.removeListener.bind(c);wrapped.release=release;
  return wrapped;
 }} as Pool;
}

test('native held reconciliation uses full migrated schema and real financial writes',{timeout:120000},async t=>{
 try {
  const admin=await pool.connect();
  try {await installFullRecoverySchema(admin);} finally {admin.release();}
  await t.test('authentic-shaped fill commits exact open position, reserves, freeze and receipt in one transaction',async()=>{
   await reset();const ledger=new ProductionLedger(db,account),snap=await evidence(ledger);
   const receipt=await ledger.reconcileHeld(snap,'7',guard()),after=await state();
   assert.equal(receipt.revision,'8');assert.equal(after.account.revision,'8');
   assert.equal(after.account.cash_micros,'23720000');assert.equal(after.account.reserved_micros,'50000');
   assert.equal(after.account.blocked_reason,'personal_exchange_history_unreconciled');
   assert.equal(after.intent.state,'TERMINAL');assert.equal(after.intent.filled_hundredths,'300');
   assert.equal(after.position.quantity_hundredths,'300');assert.equal(after.position.basis_micros,'1280000');
   assert.equal(after.events.length,1);assert.equal(after.observations.length,2);
   const durable=(await db.query('SELECT payload FROM public.v13_production_observation WHERE id=$1',[receipt.receiptId])).rows[0].payload;
   assert.equal(durable.revision,'8');assert.equal(durable.financialDigest,receipt.financialDigest);
   assert.equal((await db.query('SELECT arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[account])).rows[0].arm_requested,false);
  });
  for(const [name,sql] of mutations) await t.test(`${name} committed during signed read refuses without an unfenced freeze or ledger write`,async()=>{
   await reset();const ledger=new ProductionLedger(db,account),snap=await evidence(ledger);
   await db.query(sql,[account]);const before=await state();
   await assert.rejects(ledger.reconcileHeld(snap,'7',guard()),/held_recovery/);
   assert.deepEqual(await state(),before);
  });
  for(const [name,sql] of mutations) await t.test(`${name} writer cannot cross the held native account/metadata locks`,async()=>{
   await reset();const ledger=new ProductionLedger(db,account),snap=await evidence(ledger),base=guard();
   let entered!:()=>void,resume!:()=>void;
   const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
   const pending=ledger.reconcileHeld(snap,'7',{...base,lock:async(tx,a)=>{await base.lock(tx,a);entered();await wait;}});
   const writer=await db.connect();
   try {
    await Promise.race([ready,pending.then(()=>{throw Error('ledger finished before locks');})]);
    await writer.query("SET lock_timeout='100ms'");
    await assert.rejects(writer.query(sql,[account]),/lock timeout/);
   } finally {writer.release();resume();}
   assert.equal((await pending).revision,'8');
  });
  await t.test('first account lock is bounded, retaining all financial state',async()=>{
   await reset();const ledger=new ProductionLedger(db,account),snap=await evidence(ledger),before=await state();
   const writer=await db.connect();
   try {await writer.query('BEGIN');await writer.query('SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE',[account]);
    await assert.rejects(ledger.reconcileHeld(snap,'7',guard()),/lock timeout/);
   } finally {await writer.query('ROLLBACK');writer.release();}
   assert.deepEqual(await state(),before);
  });
  await t.test('final guard refusal rolls back actual financial writes and inserted receipts',async()=>{
   await reset();const ledger=new ProductionLedger(db,account),snap=await evidence(ledger),before=await state(),base=guard();
   await assert.rejects(ledger.reconcileHeld(snap,'7',{...base,beforeCommit:async(tx,a)=>{
    await base.beforeCommit(tx,a);
    assert.equal((await tx.query('SELECT count(*)::int AS n FROM public.v13_production_event WHERE account_id=$1',[account])).rows[0].n,1);
    throw Error('test_final_fence_refused');
   }}),/test_final_fence_refused/);
   assert.deepEqual(await state(),before);
  });
  await t.test('existing freeze cannot mask a newly detected late-fill risk',async()=>{
   await reset();await db.query("UPDATE public.v13_production_intent SET terminal=true,state='TERMINAL' WHERE id=$1",[target]);
   const ledger=new ProductionLedger(db,account),snap=await evidence(ledger),before=await state();
   await assert.rejects(ledger.reconcileHeld(snap,'7',guard()),/late_fill_after_terminal/);
   assert.deepEqual(await state(),before);
  });
  await t.test('real pending independent transfer refuses the ledger transaction',async()=>{
   await reset();await db.query(`INSERT INTO private.strata_manual_profit_withdrawals(id,owner_user_id,execution_account_id,
    state,amount_cents,retain_cents,bot_before_cents,cashier_before_cents,authority_fingerprint)
    VALUES('77777777-7777-4777-8777-777777777777',$1,$2,'prepared',100,0,2500,0,$3)`,[owner,account,fingerprint]);
   const ledger=new ProductionLedger(db,account),snap=await evidence(ledger),before=await state();
   await assert.rejects(ledger.reconcileHeld(snap,'7',guard()),/independent_activity_pending/);
   assert.deepEqual(await state(),before);
  });
  await t.test('native COMMIT succeeds but lost acknowledgment is uncertain, not replayed',async()=>{
   await reset();const ledger=new ProductionLedger(commitAckLossPool(),account),snap=await evidence(new ProductionLedger(db,account));
   await assert.rejects(ledger.reconcileHeld(snap,'7',guard()),HeldReconciliationCommitUncertain);
   const after=await state();assert.equal(after.account.revision,'8');assert.equal(after.events.length,1);
   assert.equal(after.observations.filter(r=>r.kind==='HELD_RECONCILIATION_RECEIPT').length,1);
   assert.equal(after.account.blocked_reason,'personal_exchange_history_unreconciled');
  });
 } finally {await db.end();await pool.end();}
});
