import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {digest} from '../v13-production/types';
import {recoverPreparedOwnedExitIntents} from './preparedProtectiveExitRecovery';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {inspectOwnerSignedExchangeReleaseProof,OWNER_SIGNED_PROOF_ACCOUNT_SQL} from './ownerSignedExchangeReleaseProof';

// This suite only runs in the repository's disposable, network-fenced cluster.
// Account hold/auth and provider IO are synthetic ports; history SQL and marker
// schema/guards are real PostgreSQL. The companion suite tests the account SQL.
test('expired exit evidence on real PostgreSQL',async t=>{
 assert.ok(process.env.V13_DISPOSABLE_DATABASE_URL,'disposable runner required');
 assert.equal(process.env.DATABASE_URL,process.env.V13_DISPOSABLE_DATABASE_URL);
 const readerConnection=await pool.connect(),writerConnection=await pool.connect();
 // Isolate from the runner's Drizzle bootstrap. Only schema qualification is
 // rewritten; marker columns, constraints, indexes and guards remain intact.
 const rewrite=(sql:string)=>sql.replaceAll('public.','exit_public.').replaceAll('private.','exit_private.').replaceAll('auth.','exit_auth.');
 const reader={query:(sql:string,args?:unknown[])=>readerConnection.query(rewrite(sql),args)};
 const writer={query:(sql:string,args?:unknown[])=>writerConnection.query(rewrite(sql),args)};
 const owner='11111111-1111-4111-8111-111111111111',accountId='synthetic-pg-exit';
 const at=Date.parse('2026-10-25T12:00:00Z');
 let sequence=0,markerSql='',markerArgs:unknown[]=[];
 const db={async query(sql:string,args?:unknown[]){
  assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|FOR UPDATE|FOR SHARE)\b/i);
  if(sql.includes('FROM private.strata_emergency_exit_reservations')){markerSql=sql;markerArgs=args??[];}
  return reader.query(sql,args);
 }};
 const history=()=>readNeverPostedReleaseHistory(db,accountId,false,{expiredExitOwnerId:owner});
 try{
 await writer.query(`CREATE SCHEMA exit_auth;CREATE SCHEMA exit_public;CREATE SCHEMA exit_private;
 DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY);
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text,kind text,state text,terminal boolean,
 parent_id text,client_order_id text,exchange_order_id text,dispatch_at timestamptz,cancel_attempted boolean,
 filled_hundredths bigint,reserved_micros bigint,exit_fee_micros bigint,market text,side text,request jsonb,decision jsonb,
 policy_hash text,fee_fingerprint text,capability_digest text,created_at timestamptz DEFAULT now());
 CREATE TABLE public.v13_production_position(id text,account_id text,market text,side text,quantity_hundredths bigint,basis_micros bigint);
 CREATE TABLE public.v13_production_observation(id text PRIMARY KEY,account_id text,kind text,payload jsonb,digest text,observed_at timestamptz DEFAULT now());
 CREATE TABLE public.v13_production_event(account_id text,intent_id text);`);
 await writer.query('SET search_path=exit_public,public');
 await writer.query('INSERT INTO auth.users VALUES($1)',[owner]);
 await writer.query('INSERT INTO public.v13_production_account VALUES($1)',[accountId]);
 // Apply checked-in marker DDL with schema isolation, before synthetic markers exist.
 for(const file of ['strata_emergency_exit_reservation_private.sql','strata_protective_exit_request_snapshot_private.sql'])
  await writer.query(readFileSync(`../../sql/${file}`,'utf8'));
 async function fixture(marker:boolean,fractional:boolean){
  sequence++;
  const id=`22222222-2222-4222-8222-${String(sequence).padStart(12,'0')}`;
  const reservation=`33333333-3333-4333-8333-${String(sequence).padStart(12,'0')}`;
  const market=`KXBTC15M-SYNTHETIC-${sequence}`,parentId=`parent-${sequence}`;
  const parent={id:parentId,account_id:accountId,kind:'ENTRY',state:'TERMINAL',terminal:true,client_order_id:`v13p-${parentId}`,
   exchange_order_id:`synthetic-provider-${sequence}`,filled_hundredths:'300',reserved_micros:'0',market,side:'YES',
   request:{clientOrderId:`v13p-${parentId}`,market,side:'YES',action:'BUY',reduceOnly:false,timeInForce:'IOC',contracts:3,limitMicros:500000}};
  const exit={id,account_id:accountId,kind:'EXIT',state:'PREPARED',terminal:false,parent_id:parentId,client_order_id:`v13p-${id}`,
   exchange_order_id:null,dispatch_at:null,cancel_attempted:false,filled_hundredths:'0',reserved_micros:'0',exit_fee_micros:'0',market,side:'YES',
   request:{clientOrderId:`v13p-${id}`,market,side:'YES',action:'SELL',reduceOnly:true,timeInForce:'IOC',limitMicros:500000,
    ...(fractional?{quantityVersion:'EXIT_HUNDREDTHS_V1',quantityHundredths:'150'}:{contracts:3})},
   decision:{ownedEvaluation:{source:{evaluated_at:new Date(at-10000).toISOString()}},policy:{maxQuoteAgeMs:5000}},
   policy_hash:'synthetic-policy',fee_fingerprint:'synthetic-fee',capability_digest:''};
  exit.capability_digest=digest({id,request:exit.request,decision:exit.decision,policyHash:exit.policy_hash,fee:exit.fee_fingerprint});
  for(const row of [parent,exit]){
   const keys=Object.keys(row);await writer.query(`INSERT INTO public.v13_production_intent (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
  }
  await writer.query('INSERT INTO public.v13_production_position VALUES($1,$2,$3,$4,$5,$6)',[parentId,accountId,market,'YES',fractional?'100':'200','1000000']);
  const raw=JSON.stringify({ticker:market,side:'ask',count:fractional?'1.50':'3.00',price:'0.5000',client_order_id:exit.client_order_id,
   time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2});
  const addMarker=()=>writer.query(`INSERT INTO private.strata_emergency_exit_reservations
   (reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,quantity_hundredths,
    order_digest,worker_fencing_token,worker_holder_id,order_request_json) VALUES($1,$2,$3,$4,$5,'YES',$6,$7,1,'synthetic-worker',$8)`,
   [reservation,owner,accountId,market,exit.client_order_id,fractional?'150':'300',createHash('sha256').update(raw).digest('hex'),raw]);
  if(marker)await addMarker();
  await writer.query('BEGIN');
  try{
   await recoverPreparedOwnedExitIntents(writer as never,{ownerId:owner,account:{id:accountId,owner_user_id:owner} as never,
    intents:[parent,exit] as never,snapshot:{authenticated:true,complete:true,cashExact:true,unexplainedCashActivity:false,observedAtMs:at-1000} as never,
    observe:async(kind,payload)=>{await writer.query('INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,$2,$3,$4,$5)',[id,accountId,kind,payload,digest(payload)]);}});
   // Match the ledger's persistence of the producer-mutated intent.
   await writer.query('UPDATE public.v13_production_intent SET state=$2,terminal=$3 WHERE id=$1',[id,exit.state,exit.terminal]);
   await writer.query('COMMIT');
  }catch(error){await writer.query('ROLLBACK');throw error;}
  return {id,reservation,exit,addMarker};
 }
 for(const marker of [false,true])for(const fractional of [false,true])await t.test(`producer/validator partial reduction marker=${marker} fractional=${fractional}`,async()=>{
  const f=await fixture(marker,fractional),result=await history();
  assert.ok(result.neverPosted.some(x=>x.intentId===f.id));
  const receipt=(await reader.query('SELECT payload FROM public.v13_production_observation WHERE id=$1',[f.id])).rows[0];
  assert.equal(receipt.payload.ownedQuantityHundredths,fractional?'100':'200');
  if(marker){const row=(await reader.query(markerSql,markerArgs)).rows.find(r=>r.reservation_id===f.reservation);
   assert.equal(row.owner_user_id,owner);assert.equal(typeof row.quantity_hundredths,'string');assert.equal(row.quantity_hundredths,fractional?'150':'300');
   assert.equal(row.state,'VOID');assert.equal(row.trading_authorized,false);assert.match(row.row_revision,/^\d+$/);
  }
 });
 await t.test('exact bounded marker query uses client identity index',async()=>{
  await history();assert.match(markerSql,/client_order_id=ANY\(\$1::text\[\]\)/);assert.match(markerSql,/LIMIT 1001/);
  await reader.query('BEGIN');
  try{await reader.query('SET LOCAL enable_seqscan=off');const plan=JSON.stringify((await reader.query('EXPLAIN (FORMAT JSON) '+markerSql,markerArgs)).rows);
   const indexes=(await reader.query("SELECT indexname FROM pg_indexes WHERE schemaname='exit_private' AND tablename='strata_emergency_exit_reservations' AND indexdef LIKE '%UNIQUE%client_order_id%'" )).rows;
   assert.equal(indexes.length,1);assert.ok(plan.includes(indexes[0].indexname),plan);
  }finally{await reader.query('ROLLBACK');}
 });
 await t.test('real guards prohibit rewriting a VOID marker or request',async()=>{
  for(const set of ["state='PREPARED'","quantity_hundredths=999","order_request_json='{}'"])
   await assert.rejects(writer.query(`UPDATE private.strata_emergency_exit_reservations SET ${set} WHERE state='VOID'`),/immutable|regression|transition/);
 });
 async function diagnostic(mutate:()=>Promise<unknown>){
  // Mock only the separately-tested account authorization/hold query.
  const diagnosticDb={query:async(sql:string,args?:unknown[])=>sql===OWNER_SIGNED_PROOF_ACCOUNT_SQL?{rows:[{id:accountId,commissioned:true,
   policy_state:'APPROVED',diagnostic_held:true,hold_revision:{synthetic:'1'},blocked_reason:null,cash_micros:'25000000',reserved_micros:'0',key_fingerprint:'synthetic'}]}:db.query(sql,args)};
  return inspectOwnerSignedExchangeReleaseProof(owner,{db:diagnosticDb,now:()=>at,material:async()=>({keyId:'synthetic',privateKey:'unused'}),
   read:async()=>{await mutate();return {ok:true,observedAtMs:at,cashMicros:'25000000',orders:[],fills:[],positions:[],settlements:[],historicalCoverageComplete:true};},
   feeProbe:async()=>({ok:true}),v4:async()=>({ok:true,checks:{}})} as never);
 }
 await t.test('committed receipt revision during provider read fails final history fence',async()=>{
  const before=await history();
  const result=await diagnostic(()=>writer.query('UPDATE public.v13_production_observation SET digest=digest'));
  assert.notEqual((await history()).historyDigest,before.historyDigest);
  assert.equal(result.ok,false);assert.equal(result.reason,'financial_history_changed_during_signed_diagnostic');
 });
 await t.test('uncommitted marker is invisible; commit creates fail-closed absence contradiction',async()=>{
  const f=await fixture(false,false);await history();
  await writer.query('BEGIN');await f.addMarker();
  try{
   assert.ok((await history()).neverPosted.some(x=>x.intentId===f.id));
   const result=await diagnostic(()=>writer.query('COMMIT'));
   assert.equal(result.ok,false);assert.equal(result.signedExchangeReadAttempted,true);
   await assert.rejects(history(),/release_never_posted_exit_evidence_invalid_or_contradictory/);
  }finally{await writer.query('ROLLBACK');}
 });
 }finally{await writer.query('ROLLBACK');readerConnection.release();writerConnection.release();await pool.end();}
});
