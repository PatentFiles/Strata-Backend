import test,{after,before} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pool} from "@workspace/db";
import {normalizeLiveDecision,writeLiveDecisionBatch,liveAnalyticsFailure} from "../v13-production/liveDecisionAnalytics";
import {readLiveHistory,parseLiveHistoryQuery,LiveHistoryRequestError} from "./liveHistoryReadModel";
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.match(url??"",/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL,url);
assert.equal(process.env.NODE_ENV,"test");
const A="10000000-0000-4000-8000-000000000001",B="20000000-0000-4000-8000-000000000002",ADMIN="30000000-0000-4000-8000-000000000003";
const now=Date.now(),sha="a".repeat(40);
const owner={subject:A,role:"STANDARD"},admin={subject:ADMIN,role:"ADMIN"};
const base={ownerId:A,accountId:"account-a",releaseSha:sha,observedAtMs:now-1000,
 stage:"OBSERVATION" as const,outcome:"PASS" as const,reasonCode:"no_fresh_cross",reasonDetail:"No new crossing",
 market:"KXBTC15M-TEST",configuredStakeCents:500,allocationPreset:"preset",facts:{btcPrice:50000,target:50001,velocity:0}};
before(async()=>{
 // Disposable, exact projection-column fixture; no provider or execution.
 await pool.query(`CREATE TABLE public.profiles(id uuid PRIMARY KEY,role text,display_name text);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int);
 CREATE TABLE public.v13_live_money_policy(execution_account_id text,policy_hash text,version int,strategy_version text,strategy_parameter_hash text);
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text,market text,side text,kind text,state text,
 terminal boolean,created_at timestamptz,filled_hundredths bigint,exchange_order_id text,parent_id text,evaluation_id text,
 direct_source_id text,decision jsonb,request jsonb,policy_hash text);
 CREATE TABLE public.v13_production_position(id text PRIMARY KEY,account_id text,quantity_hundredths bigint,realized_pnl_micros bigint);
 CREATE TABLE public.v13_production_event(account_id text,event_id text,intent_id text,kind text,payload jsonb,cash_delta_micros bigint,pnl_micros bigint,occurred_at timestamptz);
 CREATE TABLE public.v13_production_observation(id text,account_id text,kind text,payload jsonb,observed_at timestamptz);
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;`);
 await pool.query(readFileSync("../../lib/db/drizzle/0050_strata_live_decision_history.sql","utf8"));
 await pool.query("INSERT INTO public.profiles VALUES($1,'STANDARD','Owner A'),($2,'STANDARD','Owner B'),($3,'ADMIN','Administrator')",[A,B,ADMIN]);
 await pool.query("INSERT INTO public.v13_production_account VALUES('account-a',$1,1,2),('account-b',$2,1,2)",[A,B]);
 const row=normalizeLiveDecision(base)!;
 assert.equal(await writeLiveDecisionBatch(pool,[row]),1);
 assert.equal(await writeLiveDecisionBatch(pool,[row]),0);
 assert.equal(await writeLiveDecisionBatch(pool,[normalizeLiveDecision({...base,ownerId:B})!]),0);
 assert.equal(await writeLiveDecisionBatch(pool,[normalizeLiveDecision({...base,ownerId:B,accountId:"account-b",reasonCode:"strategy_pass"})!]),1);
 await pool.query(`INSERT INTO public.v13_live_money_policy VALUES('account-a','policy-hash',2,'V1.3','parameter-hash');
 INSERT INTO public.v13_production_intent VALUES
 ('entry-1','account-a','KXBTC15M-TEST','YES','ENTRY','TERMINAL',true,clock_timestamp()-interval '3 seconds',300,'real-order',NULL,'old-eval',NULL,
 '{"configuredStakeCents":500,"source":{"signal":"SCOUT","entry_offer":0.49}}','{"limitMicros":490000}','policy-hash'),
 ('blocked-exit','account-a','KXBTC15M-TEST','YES','EXIT','BLOCKED',true,clock_timestamp()-interval '2 seconds',0,NULL,'entry-1',NULL,NULL,'{}','{}','policy-hash');
 INSERT INTO public.v13_production_position VALUES('entry-1','account-a',0,1477500);
 INSERT INTO public.v13_production_event VALUES
 ('account-a','fill:one','entry-1','FILL','{"action":"BUY","feeMicros":"52500","grossMicros":"1470000","priceMicros":490000,"quantityHundredths":"300"}',-1522500,0,clock_timestamp()-interval '3 seconds'),
 ('account-a','settlement:one','entry-1','SETTLEMENT','{"feeMicros":"0","payoutMicros":"3000000"}',3000000,1477500,clock_timestamp()-interval '1 second');
 INSERT INTO public.v13_production_observation VALUES('reason-one','account-a','PROVEN_NOT_POSTED','{"id":"blocked-exit","reason":"production_prepared_entry_expired"}',clock_timestamp());`);
});
after(()=>pool.end());
test("immutable, private, scoped decision journal",async()=>{
 const grants=await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_live_decision_log_v1'::regclass");
 assert.equal(grants.rows[0].relrowsecurity,true);
 const acl=await pool.query("SELECT has_table_privilege('authenticated','private.strata_live_decision_log_v1','SELECT') AS allowed");
 assert.equal(acl.rows[0].allowed,false);
 await assert.rejects(pool.query("UPDATE private.strata_live_decision_log_v1 SET reason_code='fake'"),/live_decision_immutable/);
 await assert.rejects(pool.query("DELETE FROM private.strata_live_decision_log_v1"),/live_decision_immutable/);
});
test("owner isolation, administrator scope, rejected forged role and safe filters",async()=>{
 const mine=await readLiveHistory(owner,{});
 assert.equal(mine.rows.length,3);
 assert.ok(mine.rows.every(r=>r.account_id==="account-a"));
 assert.equal((await readLiveHistory(owner,{account:"account-b"})).rows.length,0);
 await assert.rejects(readLiveHistory(owner,{scope:"all"}),e=>e instanceof LiveHistoryRequestError&&e.status===403);
 await assert.rejects(readLiveHistory({...owner,role:"ADMIN"},{scope:"all"}),e=>e instanceof LiveHistoryRequestError&&e.status===403);
 const all=await readLiveHistory(admin,{scope:"all"});
 assert.equal(all.rows.length,4);
 assert.equal(all.accounts.length,2);
 assert.equal((await readLiveHistory(admin,{scope:"all",status:"PASS",reason:"strategy_pass"})).rows.length,1);
 assert.throws(()=>parseLiveHistoryQuery({scope:"all",to:"invalid"},admin),LiveHistoryRequestError);
 assert.throws(()=>parseLiveHistoryQuery({limit:"101"},owner),LiveHistoryRequestError);
});
test("actual ledger P&L and fees counted once; no fill or P&L for PASS/blocked",async()=>{
 const page=await readLiveHistory(owner,{});
 assert.equal(page.summary.submittedOrders,1);
 assert.equal(page.summary.fills,1);
 assert.equal(page.summary.wins,1);
 assert.equal(page.summary.netPnlMicros,"1477500");
 assert.equal(page.summary.feeMicros,"52500");
 assert.equal(page.summary.passes,1);
 assert.equal(page.summary.evaluations,1);
 assert.equal(page.summary.blockedRecords,1);
 assert.equal(page.rows.find(r=>r.status==="PASS")?.net_pnl_micros,null);
 assert.equal(page.rows.find(r=>r.status==="BLOCKED")?.submitted_orders,0);
 assert.equal(page.rows.find(r=>r.status==="SETTLED_WIN")?.net_pnl_micros,"1477500");
 assert.equal((page.rows.find(r=>r.status==="SETTLED_WIN")?.details as Record<string,unknown>)?.closedTradeGrossPnlMicros,"1530000");
 assert.equal(page.coverage.historicalPassesBackfilled,false);
});
test("cursor pages retain distinct rows",async()=>{
 const a=await readLiveHistory(admin,{scope:"all",limit:"2"});
 assert.ok(a.nextCursor);
 const b=await readLiveHistory(admin,{scope:"all",limit:"2",from:a.from,to:a.to,cursor:a.nextCursor!});
 assert.equal(new Set([...a.rows,...b.rows].map(r=>r.row_id)).size,4);
 assert.equal(b.nextCursor,null);
});
test("normalization strips unknown fields and arbitrary error text",()=>{
 const v=normalizeLiveDecision({...base,facts:{btcPrice:1,secret:"fixture-private-value"}})!;
 assert.equal(v.facts.btcPrice,1);assert.equal("secret" in v.facts,false);
 assert.equal(liveAnalyticsFailure(new Error("fixture-private-value")),"live_evaluation_or_execution_failed");
});

test("linked exit fills and parent settlement reconcile gross and net without double counting",async()=>{
 await pool.query(`INSERT INTO public.v13_production_intent VALUES
 ('entry-2','account-a','KXBTC15M-LINKED','YES','ENTRY','TERMINAL',true,clock_timestamp()-interval '4 seconds',200,'entry-order',NULL,NULL,NULL,'{}','{}','policy-hash'),
 ('exit-2','account-a','KXBTC15M-LINKED','YES','EXIT','TERMINAL',true,clock_timestamp()-interval '3 seconds',100,'exit-order','entry-2',NULL,NULL,'{}','{}','policy-hash');
 INSERT INTO public.v13_production_position VALUES('entry-2','account-a',0,670000);
 INSERT INTO public.v13_production_event VALUES
 ('account-a','fill:entry2','entry-2','FILL','{"action":"BUY","feeMicros":"20000","grossMicros":"800000","priceMicros":400000,"quantityHundredths":"200"}',-820000,0,clock_timestamp()-interval '4 seconds'),
 ('account-a','fill:exit2','exit-2','FILL','{"action":"SELL","feeMicros":"10000","grossMicros":"500000","priceMicros":500000,"quantityHundredths":"100"}',490000,80000,clock_timestamp()-interval '3 seconds'),
 ('account-a','settlement:entry2','entry-2','SETTLEMENT','{"feeMicros":"0","payoutMicros":"1000000"}',1000000,590000,clock_timestamp()-interval '2 seconds');`);
 const page=await readLiveHistory(owner,{market:"LINKED"});
 assert.equal(page.summary.submittedOrders,2);
 assert.equal(page.summary.fills,2);
 assert.equal(page.summary.netPnlMicros,"670000");
 assert.equal(page.summary.feeMicros,"30000");
 assert.equal(page.summary.wins,1);
 const entry=page.rows.find(r=>r.row_id==="intent:entry-2")?.details as Record<string,unknown>;
 assert.equal(entry.closedTradeNetPnlMicros,"670000");
 assert.equal(entry.closedTradeGrossPnlMicros,"700000");
 assert.equal(entry.closedTradeTotalFeesMicros,"30000");
 assert.equal((entry.linkedExitEvents as unknown[]).length,1);
});

import {readLiveHistoryExportBatch} from './liveHistoryExport';
test('bounded export equals screen financial and decision projections without truncation or tenant leakage',async()=>{
 const scope={scope:'all',from:new Date(now-60000).toISOString(),to:new Date().toISOString(),limit:'1'};
 let cursor:string|undefined,rows:any[]=[],pages=0,watermark:string|undefined;
 do{
  const page=await readLiveHistoryExportBatch(admin,{...scope,cursor});pages++;
  assert.equal(page.version,'LIVE_HISTORY_EXPORT_V1');
  assert.ok(page.rows.length<=1);assert.ok(page.scannedRows<=1);
  if(watermark)assert.equal(page.watermark,watermark);watermark=page.watermark;
  rows.push(...page.rows);cursor=page.nextCursor??undefined;
  assert.ok(pages<30,'bounded progress');
 }while(cursor);
 const screen=await readLiveHistory(admin,{...scope,limit:'100'});
 assert.equal(rows.length,screen.rows.length);assert.equal(new Set(rows.map(r=>r.row_id)).size,rows.length);
 for(const row of rows)assert.deepEqual(row,screen.rows.find(r=>r.row_id===row.row_id));
 const own=await readLiveHistoryExportBatch(owner,{from:scope.from,to:scope.to,account:'account-b'});
 assert.deepEqual(own.rows,[]);
 await assert.rejects(readLiveHistoryExportBatch(owner,{...scope}),e=>e instanceof LiveHistoryRequestError&&e.status===403);
 await assert.rejects(readLiveHistoryExportBatch({...owner,role:'ADMIN'},{...scope}),e=>e instanceof LiveHistoryRequestError&&e.status===403);
});
test('export supports all dates and binds cursors to owner, filters and immutable recording watermark',async()=>{
 const raw={scope:'all',from:'1970-01-01T00:00:00.000Z',to:new Date().toISOString(),limit:'1'};
 const page=await readLiveHistoryExportBatch(admin,raw);assert.ok(page.nextCursor);
 await assert.rejects(readLiveHistoryExportBatch(admin,{...raw,cursor:page.nextCursor,reason:'changed'}),LiveHistoryRequestError);
 await assert.rejects(readLiveHistoryExportBatch(owner,{...raw,scope:'own',cursor:page.nextCursor}),LiveHistoryRequestError);
 await assert.rejects(readLiveHistoryExportBatch(admin,{...raw,cursor:'garbage'}),LiveHistoryRequestError);
 await assert.rejects(readLiveHistoryExportBatch(admin,{...raw,limit:'1001'}),LiveHistoryRequestError);
 // A decision arriving later with old observed_at must not enter this export.
 const late=normalizeLiveDecision({...base,observedAtMs:now-5000,reasonCode:'late_export_fixture'})!;
 await writeLiveDecisionBatch(pool,[late]);
 let cursor:string|undefined=page.nextCursor??undefined,found=false,pages=0;
 while(cursor){const next=await readLiveHistoryExportBatch(admin,{...raw,cursor});found ||= next.rows.some(r=>r.reason_code==='late_export_fixture');cursor=next.nextCursor??undefined;assert.ok(++pages<30);}
 assert.equal(found,false);
});
test('filtered ledger export advances past empty batches and retains exact microsecond ties',async()=>{
 const at='2026-11-24T00:00:00.123456Z';
 for(let n=0;n<5;n++){
  await pool.query(`INSERT INTO public.v13_production_intent(id,account_id,market,side,kind,state,terminal,created_at,filled_hundredths,decision,request,policy_hash)
   VALUES($1,'account-a','KXBTC15M-FILTER','YES','ENTRY','BLOCKED',true,$2,0,'{}','{}','policy-hash')`,['filter-'+n,at]);
 }
 const raw={from:'2026-11-24T00:00:00Z',to:'2026-11-24T00:01:00Z',status:'PASS',limit:'2'};
 let cursor:string|undefined,pages=0,scanned=0;
 do{const p=await readLiveHistoryExportBatch(owner,{...raw,cursor});assert.equal(p.rows.length,0);scanned+=p.scannedRows;cursor=p.nextCursor??undefined;assert.ok(++pages<10);}while(cursor);
 assert.equal(scanned,5);
 const ids=new Set();cursor=undefined;pages=0;
 do{const p=await readLiveHistoryExportBatch(owner,{...raw,status:'BLOCKED',cursor});for(const row of p.rows){assert.ok(!ids.has(row.row_id));ids.add(row.row_id);assert.match(row.observed_at,/123456/);}cursor=p.nextCursor??undefined;assert.ok(++pages<10);}while(cursor);
 assert.equal(ids.size,5);
});