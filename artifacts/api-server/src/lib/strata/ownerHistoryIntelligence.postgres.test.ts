import { test } from "node:test";
import assert from "node:assert/strict";
import {createIsolatedLedgerTestDatabase} from "./isolatedLedgerTestDatabase";
import {readOwnerHistory,parseHistoryCursor,parseHistoryEvaluationId} from "./ownerHistoryIntelligence";

// Deliberately minimal schema reproduces the actual column types of the
// forward-test and V13 ledger. Tests execute the production SQL, not mocks.
test("owner history SQL fences owners, legacy, paper source and exact linkage", async()=>{
 const db=await createIsolatedLedgerTestDatabase();
 const a="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const e="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
 const time="2026-11-20T00:00:00.123456Z";
 const port={connect:async()=>({query:db.query,release:()=>{}})};
 try {
  await db.exec(`
   CREATE SCHEMA private;
   CREATE TABLE public.v13_production_account (id text PRIMARY KEY,owner_user_id uuid,subaccount bigint,exchange_index bigint);
   CREATE TABLE public.forward_test_evaluations (
     id text PRIMARY KEY,evaluated_at timestamptz,market_ticker text,strategy_version text,strategy_parameter_hash text,entry_policy_version text,
     signal text,direction text,qualifying_trigger boolean,reason text,fresh_cross boolean,crossing_consumed boolean,position_was_open boolean,
     btc_price double precision,target double precision,signed_buffer double precision,velocity double precision,
     up_bid double precision,up_offer double precision,up_spread double precision,down_bid double precision,down_offer double precision,down_spread double precision,
     entry_offer double precision,seconds_remaining integer,btc_provider_age_ms double precision,btc_receive_age_ms double precision,market_age_ms double precision,
     feed_freshness text,evaluation_source text);
   CREATE TABLE public.forward_test_windows(ticker text PRIMARY KEY,finalized boolean,settlement_result text);
   CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text,evaluation_id text,parent_id text,kind text,market text,side text,state text,filled_hundredths bigint,exchange_order_id text,terminal boolean);
   CREATE TABLE public.v13_production_position(id text PRIMARY KEY,account_id text,quantity_hundredths bigint,realized_pnl_micros bigint);
   CREATE TABLE public.v13_production_event(account_id text,event_id text,intent_id text,kind text,pnl_micros bigint,occurred_at timestamptz);
   CREATE TABLE private.strata_v13_signal_decisions(decision_id bigint GENERATED ALWAYS AS IDENTITY,execution_account_id text,evaluation_id text,observed_at timestamptz,phase text,source_age_ms integer,reason text,release_commit_sha text);
   CREATE TABLE private.strata_v13_execution_trace(trace_id bigint GENERATED ALWAYS AS IDENTITY,execution_account_id text,evaluation_id text,intent_id text,kind text,recorded_at timestamptz,details jsonb);
  `);
  await db.query("INSERT INTO public.v13_production_account VALUES ('a',$1,1,2),('b',$2,1,2),('legacy',NULL,1,2)",[a,b]);
  await db.query(`INSERT INTO public.forward_test_evaluations(id,evaluated_at,market_ticker,strategy_version,signal,direction,qualifying_trigger,reason,fresh_cross,crossing_consumed,position_was_open,btc_price,target,signed_buffer,feed_freshness,evaluation_source)
   VALUES ($1,$2,'market','V1.3','PASS','UP',false,'repriced',true,false,false,100,99,1,'FRESH','paper'),
   ('foreign-source',$2,'market','V1.3','EXIT','UP',false,'private',false,false,true,100,99,1,'FRESH','micro_live')`,[e,time]);
  await db.exec("INSERT INTO public.forward_test_windows VALUES ('market',true,'YES')");
  await db.query(`INSERT INTO private.strata_v13_signal_decisions(execution_account_id,evaluation_id,observed_at,phase,source_age_ms,reason,release_commit_sha)
   VALUES ('a',$1,$2,'PREPARE_REJECTED',5010,'expired',repeat('a',40)),('b',$1,$2,'DISPATCH_COMPLETED',1,'foreign',repeat('b',40)),('legacy',$1,$2,'QUALIFYING_SEEN',0,NULL,repeat('c',40))`,[e,time]);
  await db.query(`INSERT INTO public.v13_production_intent VALUES
   ('entry-a','a',$1,NULL,'ENTRY','market','YES','TERMINAL',100,'exchange-a',true),
   ('exit-a','a',NULL,'entry-a','EXIT','market','YES','TERMINAL',100,NULL,true),
   ('entry-b','b',$1,NULL,'ENTRY','market','YES','TERMINAL',100,'exchange-b',true),
   ('direct-a','a',NULL,NULL,'ENTRY','market','YES','TERMINAL',100,NULL,true)`,[e]);
  await db.exec("INSERT INTO public.v13_production_position VALUES ('entry-a','a',0,1234567),('entry-b','b',0,-9000000)");
  await db.query(`INSERT INTO public.v13_production_event VALUES ('a','win','exit-a','SETTLEMENT',1234567,$1),('b','foreign','entry-b','SETTLEMENT',-9000000,$1),('a','direct','direct-a','SETTLEMENT',-100,$1),('a','fill','entry-a','FILL',0,$1)`,[time]);
  await db.query(`INSERT INTO private.strata_v13_execution_trace(execution_account_id,evaluation_id,intent_id,kind,recorded_at,details)
   VALUES ('a',$1,'entry-a','INTENT_STATE',$2,'{"state":"TERMINAL","secret":"do-not-return"}'),('b',$1,'entry-b','INTENT_STATE',$2,'{"state":"UNKNOWN"}')`,[e,time]);
  const source=await readOwnerHistory(a,"source",null,null,port);
  assert.equal(source.rows.length,1);
  assert.equal(source.rows[0]?.reason,"repriced");
  assert.equal(source.rows[0]?.recordedMarketResult,"YES");
  assert.equal(source.rows[0]?.marketAgeMs,null);
  assert.equal(source.accountExists,null);
  const live=await readOwnerHistory(a,"live",null,e,port);
  assert.equal(live.rows.length,1);
  assert.equal(live.rows[0]?.liveReason,"expired");
  assert.equal(live.rows[0]?.exchangeOrderId,"exchange-a");
  assert.equal(live.rows[0]?.sourceAgeMs,5010);
  assert.deepEqual(live.linkedSettlements.map(x=>x.eventId),["win"]);
  assert.equal(live.linkedSettlements[0]?.netPnlMicros,"1234567");
  assert.equal(live.executionTrace.length,1);
  assert.ok(!JSON.stringify(live).includes("do-not-return"));
  assert.equal(live.stageTimingsPersisted,false);
  const other=await readOwnerHistory(b,"live",null,e,port);
  assert.equal(other.rows[0]?.exchangeOrderId,"exchange-b");
  assert.equal(other.linkedSettlements[0]?.netPnlMicros,"-9000000");
  const trades=await readOwnerHistory(a,"trades",null,null,port);
  assert.equal(trades.rows.length,2);
  assert.equal(trades.rows.find(x=>x.eventId==="direct")?.evaluationId,null);
  const missing=await readOwnerHistory("cccccccc-cccc-4ccc-8ccc-cccccccccccc","trades",null,null,port);
  assert.equal(missing.accountExists,false);
  assert.deepEqual(missing.rows,[]);
  assert.equal(parseHistoryEvaluationId("foreign-source"),null);
  assert.deepEqual(parseHistoryCursor(time,e),{at:time,id:e});
  assert.equal(parseHistoryCursor("not-a-time",e),null);
  // Same-time records exercise the secondary key and the extra-row boundary.
  await db.query(`INSERT INTO public.forward_test_evaluations(id,evaluated_at,market_ticker,evaluation_source)
    SELECT 'page-'||lpad(n::text,3,'0'),$1,'market','paper' FROM generate_series(1,101) n`,[time]);
  const first=await readOwnerHistory(a,"source",null,null,port);
  assert.equal(first.rows.length,100);
  assert.ok(first.next);
  const second=await readOwnerHistory(a,"source",first.next,null,port);
  assert.equal(second.rows.length,2);
  assert.equal(second.next,null);
  assert.equal(new Set([...first.rows,...second.rows].map(x=>x.evaluationId)).size,102);
 } finally {await db.close();}
});
