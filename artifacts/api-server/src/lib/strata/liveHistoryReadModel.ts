import {pool,type Pool} from "@workspace/db";
import {attributeHistoryPage} from './historyBotAttribution';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY=86400000;
const STATUSES=new Set(["PASS","QUALIFIED","BLOCKED","ERROR","PREPARED","SUBMISSION_UNCERTAIN","ORDER_SUBMITTED","PARTIALLY_FILLED","FILLED_OPEN","FILLED_EXIT","CANCELED_UNFILLED","SETTLED_WIN","SETTLED_LOSS","BREAKEVEN","CLOSED_WIN","CLOSED_LOSS"]);
export class LiveHistoryRequestError extends Error {
 constructor(readonly status:400|403,reason:string){super(reason);}
}
type Actor={subject:string;role:string|null};
type Query={scope:"own"|"all";account:string|null;from:string;to:string;status:string|null;direction:string|null;market:string|null;strategy:string|null;reason:string|null;recordType:"LIVE_DECISION"|"LEDGER_INTENT"|null;beforeAt:string|null;beforeId:string|null;limit:number};
function invalid():never{throw new LiveHistoryRequestError(400,"invalid_live_history_filters");}
export function parseLiveHistoryQuery(raw:Record<string,unknown>,actor:Actor,now=Date.now(),mode:"screen"|"export"="screen"):Query {
 if(!UUID.test(actor.subject))throw new LiveHistoryRequestError(403,"live_history_owner_required");
 const keys=["scope","account","from","to","status","direction","market","strategy","reason","recordType","cursor","limit"];
 if(Object.keys(raw).some(k=>!keys.includes(k)))invalid();
 const get=(k:string,max=200):string|null=>{
  const x=raw[k];
  if(x===undefined)return null;
  if(typeof x!=="string"||x.length===0||x.length>max||/[\u0000-\u001f]/.test(x))invalid();
  return x as string;
 };
 const scope=get("scope")??"own";
 if(scope!=="own"&&scope!=="all")invalid();
 if(scope==="all"&&actor.role!=="ADMIN")throw new LiveHistoryRequestError(403,"administrator_scope_required");
 const to=get("to")??new Date(now).toISOString();
 if(!Number.isFinite(Date.parse(to)))invalid();
 const from=get("from")??new Date(Date.parse(to)-30*DAY).toISOString();
 const start=Date.parse(from),end=Date.parse(to);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||(mode==="screen"&&end-start>90*DAY)||start<0||end>now+60000)invalid();
 const status=get("status"),direction=get("direction"),account=get("account");
 const recordType=get('recordType');
 if(recordType!==null&&!['LIVE_DECISION','LEDGER_INTENT'].includes(recordType))invalid();
 if(status&&!STATUSES.has(status))invalid();
 if(direction&&!["UP","DOWN","NONE"].includes(direction))invalid();
 const rawLimit=get("limit"),limit=rawLimit===null?50:Number(rawLimit);
 if(rawLimit!==null&&!/^\d+$/.test(rawLimit)||!Number.isSafeInteger(limit)||limit<1||limit>(mode==="export"?1000:100))invalid();
 let beforeAt:string|null=null,beforeId:string|null=null;
 const cursor=get("cursor",1024);
 if(cursor){
  try{
   const v:unknown=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
   if(!Array.isArray(v)||v.length!==2||typeof v[0]!=="string"||!Number.isFinite(Date.parse(v[0]))||
    typeof v[1]!=="string"||!/^(?:decision|intent):[A-Za-z0-9._:-]{1,200}$/.test(v[1]))invalid();
   beforeAt=v[0];beforeId=v[1];
  }catch{invalid();}
 }
 return {scope:scope as Query["scope"],recordType:recordType as Query["recordType"],account,from:new Date(start).toISOString(),to:new Date(end).toISOString(),
  status,direction,market:get("market",128),strategy:get("strategy",80),reason:get("reason",128),beforeAt,beforeId,limit};
}

// All rows derive from the owner-bound production ledger or the new
// independent-observation journal. Historical source facts are projected
// only from an actual retained intent, never from the paper evaluations table.
// Realized event amounts are counted ONCE, separately from closed-trade totals.
function historySql(intentIdsOnly=false){return `
WITH accounts AS MATERIALIZED (
 SELECT a.id,p.display_name AS display_name,a.owner_user_id
 FROM public.v13_production_account a
 LEFT JOIN public.profiles p ON p.id=a.owner_user_id
 WHERE a.owner_user_id IS NOT NULL AND a.subaccount=1 AND a.exchange_index=2
 AND ($2::boolean OR a.owner_user_id=$1::uuid)
 AND ($3::text IS NULL OR a.id=$3)
), intents AS MATERIALIZED (
 SELECT i.*,a.display_name,a.owner_user_id
 FROM public.v13_production_intent i JOIN accounts a ON a.id=i.account_id
 WHERE i.created_at BETWEEN $4::timestamptz AND $5::timestamptz
 AND ($14::text[] IS NULL OR i.id=ANY($14::text[]))
), ledger_rows AS (
 SELECT 'intent:'||i.id AS row_id,i.created_at AS observed_at,
   i.account_id,COALESCE(NULLIF(btrim(i.display_name),''),'Unnamed account') AS account_name,
   i.market AS market,CASE i.side WHEN 'YES' THEN 'UP' WHEN 'NO' THEN 'DOWN' END AS direction,
   i.decision->'source'->>'signal' AS signal,
   CASE
    WHEN i.state='BLOCKED' THEN 'BLOCKED'
    WHEN i.state='UNKNOWN' OR (i.state='DISPATCHED' AND i.exchange_order_id IS NULL) THEN 'SUBMISSION_UNCERTAIN'
    WHEN i.kind='ENTRY' AND i.filled_hundredths>0 AND i.terminal AND pos.id IS NOT NULL AND pos.quantity_hundredths=0
      THEN CASE WHEN pos.realized_pnl_micros=0 THEN 'BREAKEVEN'
        WHEN EXISTS (SELECT 1 FROM public.v13_production_event s WHERE s.account_id=i.account_id AND s.intent_id=i.id AND s.kind='SETTLEMENT')
          THEN CASE WHEN pos.realized_pnl_micros>0 THEN 'SETTLED_WIN' ELSE 'SETTLED_LOSS' END
        ELSE CASE WHEN pos.realized_pnl_micros>0 THEN 'CLOSED_WIN' ELSE 'CLOSED_LOSS' END END
    WHEN i.filled_hundredths>0 AND NOT i.terminal THEN 'PARTIALLY_FILLED'
    WHEN i.filled_hundredths>0 AND i.kind='EXIT' THEN 'FILLED_EXIT'
    WHEN i.filled_hundredths>0 THEN 'FILLED_OPEN'
    WHEN i.exchange_order_id IS NOT NULL AND i.terminal THEN 'CANCELED_UNFILLED'
    WHEN i.exchange_order_id IS NOT NULL THEN 'ORDER_SUBMITTED'
    WHEN i.terminal THEN 'BLOCKED'
    ELSE 'PREPARED'
   END AS status,
   CASE WHEN obs.reason ~ '^[a-z][a-z0-9_]{0,127}$' THEN obs.reason
    WHEN i.state='BLOCKED' THEN 'ledger_blocked_reason_unrecorded' ELSE NULL END AS reason_code,
   i.decision->'source'->>'reason' AS reason_detail,
   COALESCE(i.decision->'policy'->>'strategyVersion',pol.strategy_version) AS strategy_version,
   'LEDGER_INTENT'::text AS record_type,
   CASE WHEN i.exchange_order_id IS NOT NULL THEN 1 ELSE 0 END AS submitted_orders,
   COALESCE(ev.fill_count,0) AS fill_count,ev.net_pnl AS net_pnl,ev.fees AS fees,
   jsonb_build_object(
    'intentId',i.id,'parentIntentId',i.parent_id,'intentKind',i.kind,'intentState',i.state,
    'exchangeOrderId',i.exchange_order_id,'evaluationId',i.evaluation_id,'directSourceId',i.direct_source_id,
    'sourceProvenance',CASE WHEN i.direct_source_id IS NOT NULL THEN 'INDEPENDENT_LIVE_SOURCE' ELSE 'HISTORICAL_LEDGER_INTENT' END,
    'side',i.side,'configuredStakeCents',i.decision->>'configuredStakeCents',
    'botId',i.decision->'source'->>'bot_strategy_id',
    'policyHash',i.policy_hash,'policyRevision',pol.version,
    'strategyParameterHash',pol.strategy_parameter_hash,
    'quotedEntryOffer',i.decision->'source'->>'entry_offer','orderLimitMicros',i.request->>'limitMicros',
    'evaluationAt',i.decision->'source'->>'evaluated_at',
    'btcPrice',i.decision->'source'->>'btc_price','target',i.decision->'source'->>'target',
    'distance',i.decision->'source'->>'signed_buffer','velocity',i.decision->'source'->>'velocity',
    'upOffer',i.decision->'source'->>'up_offer','downOffer',i.decision->'source'->>'down_offer',
    'marketOpenMs',i.decision->'source'->>'market_open_ms','marketCloseMs',i.decision->'source'->>'market_close_ms',
    'releaseSha',i.decision->'source'->'worker_pin'->>'releaseSha',
    'filledHundredths',i.filled_hundredths::text,'executedEntryGrossMicros',ev.buy_gross::text,
    'entryFillPriceMicros',ev.buy_price::text,'exitFillPriceMicros',CASE WHEN i.kind='ENTRY' THEN linked.sell_price::text ELSE ev.sell_price::text END,
    'entryAt',ev.first_buy,'exitAt',CASE WHEN i.kind='ENTRY' THEN linked.last_exit ELSE ev.last_exit END,'settledAt',ev.last_settlement,
    'entryFeesMicros',ev.buy_fees::text,'exitFeesMicros',CASE WHEN i.kind='ENTRY' THEN linked.exit_fees::text ELSE ev.exit_fees::text END,
    'closedTradeNetPnlMicros',CASE WHEN i.kind='ENTRY' AND pos.quantity_hundredths=0 AND i.filled_hundredths>0 AND i.terminal THEN pos.realized_pnl_micros::text ELSE NULL END,
    'closedTradeGrossPnlMicros',CASE WHEN i.kind='ENTRY' AND pos.quantity_hundredths=0 AND i.filled_hundredths>0 AND i.terminal
     AND linked.net_pnl=pos.realized_pnl_micros AND linked.fees IS NOT NULL THEN (pos.realized_pnl_micros+linked.fees)::text ELSE NULL END,
    'closedTradeTotalFeesMicros',CASE WHEN i.kind='ENTRY' AND pos.quantity_hundredths=0 AND i.filled_hundredths>0 AND i.terminal
     AND linked.net_pnl=pos.realized_pnl_micros THEN linked.fees::text ELSE NULL END,
    'linkedExitEvents',COALESCE(linked.exit_events,'[]'::jsonb),
    'financialEvents',COALESCE(ev.events,'[]'::jsonb),'reasonObservationId',obs.id
   ) AS details
 FROM intents i
 LEFT JOIN public.v13_production_position pos ON pos.id=i.id AND pos.account_id=i.account_id
 LEFT JOIN LATERAL (
  SELECT p.version,p.strategy_version,p.strategy_parameter_hash FROM public.v13_live_money_policy p
  WHERE p.execution_account_id=i.account_id AND p.policy_hash=i.policy_hash ORDER BY p.version DESC LIMIT 1
 ) pol ON true
 LEFT JOIN LATERAL (
  SELECT o.id,o.payload->>'reason' AS reason FROM public.v13_production_observation o
  WHERE i.state='BLOCKED' AND o.account_id=i.account_id AND o.kind='PROVEN_NOT_POSTED' AND o.payload->>'id'=i.id
  ORDER BY o.observed_at DESC,o.id DESC LIMIT 1
 ) obs ON true
 LEFT JOIN LATERAL (
  SELECT count(*) FILTER(WHERE e.kind='FILL') AS fill_count,
   sum(e.pnl_micros) FILTER(WHERE e.kind='SETTLEMENT' OR (e.kind='FILL' AND e.payload->>'action'='SELL')) AS net_pnl,
   CASE WHEN bool_and(COALESCE(e.payload->>'feeMicros','') ~ '^\\d+$') THEN sum((e.payload->>'feeMicros')::numeric) END AS fees,
   sum(CASE WHEN e.payload->>'grossMicros' ~ '^\\d+$' THEN (e.payload->>'grossMicros')::numeric END) FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='BUY') AS buy_gross,
   sum(CASE WHEN e.payload->>'priceMicros' ~ '^\\d+$' AND e.payload->>'quantityHundredths' ~ '^\\d+$' THEN (e.payload->>'priceMicros')::numeric*(e.payload->>'quantityHundredths')::numeric END) FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='BUY')/
     NULLIF(sum(CASE WHEN e.payload->>'quantityHundredths' ~ '^\\d+$' THEN (e.payload->>'quantityHundredths')::numeric END) FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='BUY'),0) AS buy_price,
   sum(CASE WHEN e.payload->>'priceMicros' ~ '^\\d+$' AND e.payload->>'quantityHundredths' ~ '^\\d+$' THEN (e.payload->>'priceMicros')::numeric*(e.payload->>'quantityHundredths')::numeric END) FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='SELL')/
     NULLIF(sum(CASE WHEN e.payload->>'quantityHundredths' ~ '^\\d+$' THEN (e.payload->>'quantityHundredths')::numeric END) FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='SELL'),0) AS sell_price,
   sum(CASE WHEN e.payload->>'feeMicros' ~ '^\\d+$' THEN (e.payload->>'feeMicros')::numeric END) FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='BUY') AS buy_fees,
   sum(CASE WHEN e.payload->>'feeMicros' ~ '^\\d+$' THEN (e.payload->>'feeMicros')::numeric END) FILTER(WHERE e.kind='SETTLEMENT' OR (e.kind='FILL' AND e.payload->>'action'='SELL')) AS exit_fees,
   min(e.occurred_at) FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='BUY') AS first_buy,
   max(e.occurred_at) FILTER(WHERE e.kind='SETTLEMENT' OR (e.kind='FILL' AND e.payload->>'action'='SELL')) AS last_exit,
   max(e.occurred_at) FILTER(WHERE e.kind='SETTLEMENT') AS last_settlement,
   jsonb_agg(jsonb_build_object('eventId',e.event_id,'kind',e.kind,'at',e.occurred_at,'action',e.payload->>'action',
    'priceMicros',e.payload->>'priceMicros','quantityHundredths',e.payload->>'quantityHundredths',
    'grossMicros',e.payload->>'grossMicros','feeMicros',e.payload->>'feeMicros','payoutMicros',e.payload->>'payoutMicros',
    'cashDeltaMicros',e.cash_delta_micros::text,'pnlMicros',e.pnl_micros::text)
    ORDER BY e.occurred_at,e.event_id) AS events
  FROM public.v13_production_event e WHERE e.account_id=i.account_id AND e.intent_id=i.id
 ) ev ON true
 LEFT JOIN LATERAL (
  -- Position P&L includes child exit fills and settlement on the parent.
  -- Aggregate linked fees for display only. The summary above counts each
  -- actual event on its own intent exactly once.
  SELECT sum(e.pnl_micros) AS net_pnl,
   CASE WHEN bool_and(COALESCE(e.payload->>'feeMicros','') ~ '^[0-9]+$')
    THEN sum((e.payload->>'feeMicros')::numeric) END AS fees,
   CASE WHEN bool_and(COALESCE(e.payload->>'feeMicros','') ~ '^[0-9]+$')
     FILTER(WHERE e.kind='SETTLEMENT' OR e.payload->>'action'='SELL')
    THEN sum(CASE WHEN e.payload->>'feeMicros' ~ '^[0-9]+$' THEN (e.payload->>'feeMicros')::numeric END)
     FILTER(WHERE e.kind='SETTLEMENT' OR e.payload->>'action'='SELL') END AS exit_fees,
   sum(CASE WHEN e.payload->>'priceMicros' ~ '^[0-9]+$' AND e.payload->>'quantityHundredths' ~ '^[0-9]+$'
      THEN (e.payload->>'priceMicros')::numeric*(e.payload->>'quantityHundredths')::numeric END)
     FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='SELL')/
    NULLIF(sum(CASE WHEN e.payload->>'quantityHundredths' ~ '^[0-9]+$' THEN (e.payload->>'quantityHundredths')::numeric END)
      FILTER(WHERE e.kind='FILL' AND e.payload->>'action'='SELL'),0) AS sell_price,
   max(e.occurred_at) FILTER(WHERE e.kind='SETTLEMENT' OR e.payload->>'action'='SELL') AS last_exit,
   jsonb_agg(jsonb_build_object('intentId',child.id,'eventId',e.event_id,'kind',e.kind,'at',e.occurred_at,
    'exchangeOrderId',child.exchange_order_id,'priceMicros',e.payload->>'priceMicros',
    'quantityHundredths',e.payload->>'quantityHundredths','feeMicros',e.payload->>'feeMicros',
    'cashDeltaMicros',e.cash_delta_micros::text,'pnlMicros',e.pnl_micros::text)
    ORDER BY e.occurred_at,e.event_id) FILTER(WHERE child.parent_id=i.id) AS exit_events
  FROM public.v13_production_intent child JOIN public.v13_production_event e
   ON e.account_id=child.account_id AND e.intent_id=child.id
  WHERE i.kind='ENTRY' AND i.filled_hundredths>0 AND child.account_id=i.account_id
    AND (child.id=i.id OR (child.parent_id=i.id AND child.kind='EXIT'))
 ) linked ON true
), decisions AS (
 SELECT 'decision:'||d.id::text AS row_id,d.observed_at,d.execution_account_id AS account_id,
   COALESCE(NULLIF(btrim(a.display_name),''),'Unnamed account') AS account_name,
   d.market_ticker AS market,d.direction,d.signal,d.outcome AS status,d.reason_code,d.reason_detail,d.strategy_version,
   'LIVE_DECISION'::text AS record_type,0 AS submitted_orders,0::bigint AS fill_count,NULL::numeric AS net_pnl,NULL::numeric AS fees,
   jsonb_build_object('decisionId',d.id,'stage',d.stage,'directSourceId',d.direct_source_id,
    'releaseSha',d.release_commit_sha,'policyHash',d.policy_hash,'policyRevision',d.policy_revision,
    'configuredStakeCents',d.configured_stake_cents,'allocationPreset',d.allocation_preset,
    'strategyParameterHash',d.strategy_parameter_hash,'facts',d.facts,'recordedAt',d.recorded_at) AS details
 FROM private.strata_live_decision_log_v1 d JOIN accounts a ON a.id=d.execution_account_id AND a.owner_user_id=d.owner_user_id
 WHERE d.observed_at BETWEEN $4::timestamptz AND $5::timestamptz
 ${intentIdsOnly?"AND false":""}
), rows AS (
 SELECT * FROM ledger_rows UNION ALL SELECT * FROM decisions
), filtered AS MATERIALIZED (
 SELECT * FROM rows
 WHERE ($15::text IS NULL OR record_type=$15)
 AND ($6::text IS NULL OR status=$6) AND ($7::text IS NULL OR direction=$7)
 AND ($8::text IS NULL OR position(upper($8) in upper(market))>0)
 AND ($9::text IS NULL OR strategy_version=$9)
 AND ($10::text IS NULL OR position(lower($10) in lower(coalesce(reason_code,'')||' '||coalesce(reason_detail,'')))>0)
), page AS (
 SELECT row_id,observed_at::text AS observed_at,account_id,account_name,market,direction,signal,status,reason_code,reason_detail,
  strategy_version,record_type,submitted_orders,fill_count::text,net_pnl::text AS net_pnl_micros,fees::text AS fee_micros,details
 FROM filtered WHERE ($11::timestamptz IS NULL OR (observed_at,row_id)<($11::timestamptz,$12::text))
 ORDER BY filtered.observed_at DESC,row_id DESC LIMIT $13
), reasons AS (
 SELECT reason_code,count(*) AS count FROM filtered WHERE reason_code IS NOT NULL AND status IN ('PASS','BLOCKED','ERROR')
 GROUP BY reason_code ORDER BY count DESC,reason_code LIMIT 10
)
SELECT
 COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY observed_at::timestamptz DESC,row_id DESC) FROM page),'[]'::jsonb) AS rows,
 (SELECT jsonb_build_object('evaluations',count(*) FILTER(WHERE record_type='LIVE_DECISION' AND details->>'stage'='OBSERVATION'),
  'passes',count(*) FILTER(WHERE record_type='LIVE_DECISION' AND status='PASS'),
  'blockedRecords',count(*) FILTER(WHERE status='BLOCKED'),
  'errors',count(*) FILTER(WHERE status='ERROR'),
  'submittedOrders',coalesce(sum(submitted_orders),0),'fills',coalesce(sum(fill_count),0),
  'wins',count(*) FILTER(WHERE status IN ('SETTLED_WIN','CLOSED_WIN')),
  'losses',count(*) FILTER(WHERE status IN ('SETTLED_LOSS','CLOSED_LOSS')),
  'breakeven',count(*) FILTER(WHERE status='BREAKEVEN'),
  'netPnlMicros',sum(net_pnl)::text,'feeMicros',sum(fees)::text,
  'intentsWithUnavailableFees',count(*) FILTER(WHERE record_type='LEDGER_INTENT' AND fill_count>0 AND fees IS NULL))
 FROM filtered) AS summary,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('reason',reason_code,'count',count) ORDER BY count DESC,reason_code) FROM reasons),'[]'::jsonb) AS reasons,
 (SELECT min(d.observed_at)::text FROM private.strata_live_decision_log_v1 d JOIN accounts a ON a.id=d.execution_account_id AND a.owner_user_id=d.owner_user_id) AS earliest_recorded_live_decision
`;}
type HistoryPageRow={row_id:string;observed_at:string;[key:string]:unknown};
export async function readLiveHistory(actor:Actor,raw:Record<string,unknown>,db:Pick<Pool,"connect">=pool){
 const q=parseLiveHistoryQuery(raw,actor);
 const c=await db.connect();
 let discard:Error|undefined;
 try{
  await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await c.query("SET LOCAL statement_timeout='4s'; SET LOCAL lock_timeout='500ms'");
  // Recheck current database role in this read transaction for all-account reads.
  if(q.scope==="all"){
   const role=await c.query("SELECT role FROM public.profiles WHERE id=$1::uuid",[actor.subject]);
   if(role.rows.length!==1||role.rows[0]?.role!=="ADMIN")throw new LiveHistoryRequestError(403,"administrator_scope_required");
  }
  const accounts=await c.query(`SELECT a.id,COALESCE(NULLIF(btrim(p.display_name),''),'Unnamed account') AS name
   FROM public.v13_production_account a LEFT JOIN public.profiles p ON p.id=a.owner_user_id
   WHERE a.owner_user_id IS NOT NULL AND a.subaccount=1 AND a.exchange_index=2
   AND ($2::boolean OR a.owner_user_id=$1::uuid) ORDER BY name,a.id LIMIT 1000`,[actor.subject,q.scope==="all"]);
  const r=await c.query(historySql(),[actor.subject,q.scope==="all",q.account,q.from,q.to,q.status,q.direction,q.market,q.strategy,q.reason,q.beforeAt,q.beforeId,q.limit+1,null,q.recordType]);
  const row=r.rows[0];
  if(!row||!Array.isArray(row.rows))throw Error("live_history_projection_unavailable");
  const rows=(row.rows as HistoryPageRow[]).slice(0,q.limit),last=rows.at(-1);
  const attributed=await attributeHistoryPage(c,rows as (HistoryPageRow&{
    account_id:string;record_type:string;reason_code:string|null;details:Record<string,unknown>})[]);
  await c.query("COMMIT");
  return {version:"LIVE_HISTORY_V1",scope:q.scope,recordType:q.recordType,accounts:accounts.rows,rows:attributed,summary:row.summary,reasons:row.reasons,
   from:q.from,to:q.to,nextCursor:last&&row.rows.length>q.limit?Buffer.from(JSON.stringify([last.observed_at,last.row_id])).toString("base64url"):null,
   coverage:{firstRecordedLiveDecisionAt:row.earliest_recorded_live_decision??null,
    historicalPassesBackfilled:false,complete:false,recordingMode:"bounded_retried_async_live_observation",
    note:"Live observations are recorded prospectively. Historical rows are retained production intents. Missing past live PASS decisions are not reconstructed. Delivery gaps can occur during process or database outages."}};
 }catch(e){
  try{await c.query("ROLLBACK");}catch{discard=new Error("live_history_rollback_failed");}
  throw e;
 }finally{c.release(discard);}
}

export const projectHistoryIntentBatchSql=()=>historySql(true);
