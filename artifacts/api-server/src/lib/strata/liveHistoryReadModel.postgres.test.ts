import test,{after,before} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pool} from "@workspace/db";
import {V13_CHAMPION_PARAMETER_HASH} from '@workspace/v13-strategy';
import {normalizeLiveDecision,writeLiveDecisionBatch,liveAnalyticsFailure,normalizeLinkedLiveDecision,confirmedBatch} from "../v13-production/liveDecisionAnalytics";
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
 // The exact live-history read model requires historical owner selection evidence.
 // Disposable fixture creates only the read columns; production migrations own the actual table.
 await pool.query(`CREATE TABLE private.strata_owner_bot_selection_history(
  execution_account_id text NOT NULL,owner_user_id uuid NOT NULL,
  to_bot_id text NOT NULL,approved_at timestamptz NOT NULL,
  release_sha text NOT NULL,revision bigint NOT NULL)`);
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

test('record-type filtering is identical for screen and export and cannot change tenant scope',async()=>{
 const dates={from:new Date(now-60000).toISOString(),to:new Date().toISOString()};
 for(const recordType of ['LEDGER_INTENT','LIVE_DECISION']){
  const screen=await readLiveHistory(owner,{...dates,recordType,limit:'100'});
  assert.equal(screen.recordType,recordType);assert.ok(screen.rows.every(r=>r.record_type===recordType&&r.account_id==='account-a'));
  if(recordType==='LEDGER_INTENT'){assert.equal(screen.summary.evaluations,0);assert.equal(screen.summary.passes,0);}
  else{assert.equal(screen.summary.submittedOrders,0);assert.equal(screen.summary.netPnlMicros,null);}
  let cursor:string|undefined;const rows:any[]=[];let n=0;
  do{const p=await readLiveHistoryExportBatch(owner,{...dates,recordType,limit:'1000',cursor});rows.push(...p.rows);cursor=p.nextCursor??undefined;assert.ok(++n<100);}while(cursor);
  assert.ok(rows.every(r=>r.record_type===recordType&&r.account_id==='account-a'));
  for(const row of screen.rows)assert.deepEqual(rows.find(r=>r.row_id===row.row_id),row);
 }
 assert.throws(()=>parseLiveHistoryQuery({recordType:'PAPER'},owner),LiveHistoryRequestError);
 const first=await readLiveHistoryExportBatch(owner,{...dates,limit:'1'});
 if(first.nextCursor)await assert.rejects(readLiveHistoryExportBatch(owner,{...dates,limit:'1',recordType:'LEDGER_INTENT',cursor:first.nextCursor}),LiveHistoryRequestError);
});
test('journal delivery retries confirm an identical retained row and reject different payloads',async()=>{
 const row=normalizeLiveDecision({...base,reasonCode:'delivery_retry_fixture'})!;
 const c=await pool.connect();try{
  assert.equal(await confirmedBatch(c,[row]),1);assert.equal(await confirmedBatch(c,[row]),1);
  assert.equal(await confirmedBatch(c,[{...row,reason_code:'different_payload'}]),0);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM private.strata_live_decision_log_v1 WHERE id=$1',[row.id])).rows[0].n,1);
 }finally{c.release();}
});
test('stage context is original, sanitized, and isolated by owner/account/release/source',()=>{
 const sourceId='40000000-0000-4000-8000-000000000004';
 const original=normalizeLinkedLiveDecision({...base,sourceId,outcome:'QUALIFIED',market:'KXBTC15M-CONTEXT',direction:'DOWN',signal:'SCOUT',facts:{btcPrice:50000,target:50001,velocity:-2,previousBuffer:3}})!;
 const blocked=normalizeLinkedLiveDecision({...base,sourceId,observedAtMs:now,stage:'PREPARE',outcome:'BLOCKED',market:undefined,facts:{}})!;
 assert.equal(blocked.market_ticker,original.market_ticker);assert.equal(blocked.facts.previousBuffer,3);assert.equal(blocked.facts.velocity,-2);
 assert.equal(blocked.facts.sourceObservationAtMs,base.observedAtMs);assert.equal(blocked.observed_at,new Date(now).toISOString());
 for(const change of [{ownerId:B},{accountId:'account-b'},{releaseSha:'b'.repeat(40)}]){
  const foreign=normalizeLinkedLiveDecision({...base,...change,sourceId,stage:'DISPATCH',facts:{}})!;
  assert.equal(foreign.facts.previousBuffer,undefined);
 }
});


test('booked settlement and UNKNOWN exit remain separate in the screen and export',async()=>{
 // Reuse the existing closed trade but preserve the real unresolved transport
 // semantics. This may never manufacture a second fill, win or confirmed order.
 try{
  await pool.query("UPDATE public.v13_production_intent SET state='DISPATCHED',terminal=false WHERE id='blocked-exit'");
  const page=await readLiveHistory(owner,{market:'KXBTC15M-TEST'});
  const exit=page.rows.find(r=>r.row_id==='intent:blocked-exit');
  assert.equal(exit?.status,'SUBMISSION_UNCERTAIN');assert.equal(exit?.submitted_orders,0);
  assert.equal(exit?.fill_count,'0');assert.equal(exit?.net_pnl_micros,null);
  assert.equal(page.summary.submittedOrders,1);assert.equal(page.summary.fills,1);
  assert.equal(page.summary.wins,1);assert.equal(page.summary.netPnlMicros,'1477500');
  assert.equal(page.summary.feeMicros,'52500');
  // Export intentionally scans bounded decision and ledger pages separately.
  // An empty intermediate batch is not EOF; follow the exact frozen scope.
  const query={market:'KXBTC15M-TEST',from:new Date(now-60000).toISOString(),to:new Date().toISOString(),limit:'2'};
  const rows:Record<string,unknown>[]=[];let cursor:string|undefined,pages=0;
  do{const batch=await readLiveHistoryExportBatch(owner,{...query,cursor});rows.push(...batch.rows);cursor=batch.nextCursor??undefined;assert.ok(++pages<20);}while(cursor);
  assert.equal(rows.find(r=>r.row_id==='intent:blocked-exit')?.status,'SUBMISSION_UNCERTAIN');
  assert.equal(rows.find(r=>r.row_id==='intent:entry-1')?.net_pnl_micros,'1477500');
 }finally{await pool.query("UPDATE public.v13_production_intent SET state='BLOCKED',terminal=true WHERE id='blocked-exit'");}
});

import {WARREN_BOT,WARREN_BOT_HASH} from '../strategies/warrenBotIdentity';
import {attributeBot} from './historyBotAttribution';
test('live bot identity is immutable on observations and matches both history and CSV export',async()=>{
 const event=normalizeLiveDecision({...base,botId:WARREN_BOT,
  reasonCode:'warren_observation_fixture',observedAtMs:now-1700})!;
 assert.equal(event.strategy_parameter_hash,V13_CHAMPION_PARAMETER_HASH);
 assert.equal(event.facts.botId,WARREN_BOT);
 assert.equal(event.facts.botParameterHash,WARREN_BOT_HASH);
 assert.equal(await writeLiveDecisionBatch(pool,[event]),1);
 const screen=await readLiveHistory(owner,{recordType:'LIVE_DECISION',limit:'100'});
 const found=screen.rows.find(x=>x.row_id==='decision:'+event.id);
 assert.equal(found?.bot_id,WARREN_BOT);
 assert.equal(found?.bot_name,'Warren Buffett');
 assert.equal(found?.bot_source,'RECORDED_OBSERVATION');
 const first=await readLiveHistoryExportBatch(owner,{recordType:'LIVE_DECISION',limit:'1000'});
 assert.deepEqual(first.rows.find(x=>x.row_id==='decision:'+event.id),found);
});
test('old observations never borrow current bot; historical inference is explicitly flagged',()=>{
 const row={row_id:'decision:past',observed_at:'2026-11-20T17:00:00Z',account_id:'account-a',
  record_type:'LIVE_DECISION',reason_code:'no_fresh_cross',details:{facts:{},releaseSha:sha}};
 const choice={execution_account_id:'account-a',to_bot_id:WARREN_BOT,
  approved_at:'2026-11-21T00:00:00Z',release_sha:sha};
 assert.equal(attributeBot(row,[choice]).bot_source,'UNATTRIBUTED');
 const after=attributeBot({...row,observed_at:'2026-11-22T00:00:00Z'},[choice]);
 assert.equal(after.bot_source,'SELECTION_HISTORY_INFERRED');
 assert.equal(after.bot_name,'Warren Buffett');
 assert.equal(attributeBot({...row,observed_at:'2026-11-22T00:00:00Z',details:{releaseSha:'b'.repeat(40),facts:{}}},[choice]).bot_id,null);
 assert.equal(attributeBot({...row,reason_code:'warren_market_signal_already_emitted'},[]).bot_source,'WARREN_REASON_INFERRED');
 const recorded=attributeBot({...row,details:{facts:{botId:WARREN_BOT}}},[]);
 assert.equal(recorded.bot_source,'RECORDED_OBSERVATION');
});
