import {pool} from "@workspace/db";
import {BOT_EXCHANGE_INDEX,BOT_SUBACCOUNT} from "./kalshiUserRead";
import {assertPaperAnalyticsAvailable} from "../paperAnalyticsMaintenance";

export const HISTORY_LIMIT=100;
export type HistoryView="source"|"live"|"trades";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The client can choose the view and an opaque pagination cursor, never a
// customer/account identifier. Every live lookup is fenced by the verified JWT
// subject inside the same repeatable-read, read-only database transaction.
export function parseHistoryView(value:unknown):HistoryView|null {
 return value==="source"||value==="live"||value==="trades"?value:null;
}
export type HistoryCursor={at:string;id:string};
export function parseHistoryCursor(at:unknown,id:unknown):HistoryCursor|null {
 if(typeof at!=="string"||typeof id!=="string"||!id.length||id.length>200||
   !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)||!Number.isFinite(Date.parse(at)))return null;
 return {at,id};
}
const iso=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const EVALUATION_COLUMNS=`
 e.id AS "evaluationId",${iso("e.evaluated_at")} AS "evaluatedAt",
 e.market_ticker AS "market",e.strategy_version AS "strategyVersion",
 e.strategy_parameter_hash AS "strategyParameterHash",e.entry_policy_version AS "entryPolicyVersion",
 e.signal,e.direction,e.qualifying_trigger AS "qualifyingTrigger",e.reason,
 e.fresh_cross AS "freshCross",e.crossing_consumed AS "crossingConsumed",
 e.position_was_open AS "paperPositionWasOpen",e.btc_price AS "btcPrice",
 e.target,e.signed_buffer AS "signedBuffer",e.velocity,
 e.up_bid AS "upBid",e.up_offer AS "upOffer",e.up_spread AS "upSpread",
 e.down_bid AS "downBid",e.down_offer AS "downOffer",e.down_spread AS "downSpread",
 e.entry_offer AS "entryOffer",e.seconds_remaining AS "secondsRemaining",
 e.btc_provider_age_ms AS "btcProviderAgeMs",e.btc_receive_age_ms AS "btcReceiveAgeMs",
 e.market_age_ms AS "marketAgeMs",e.feed_freshness AS "feedFreshness"`;

export const OWNER_SQL=`SELECT a.id FROM public.v13_production_account a
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=$2 AND a.exchange_index=$3 LIMIT 2`;
export const SOURCE_SQL=`SELECT ${EVALUATION_COLUMNS}
 FROM public.forward_test_evaluations e WHERE e.evaluation_source='paper'
 AND ($1::timestamptz IS NULL OR (e.evaluated_at,e.id)<($1::timestamptz,$2::text))
 ORDER BY e.evaluated_at DESC,e.id DESC LIMIT $3`;

// Read the existing immutable trace by owner and signal ID. Limit the
// *indexed* trace scan before joining; this view is bounded, not an audit of
// every historically qualifying market. Cursor is on the observed phase row,
// not an invented evaluation timestamp.
export const LIVE_SQL=`WITH phases AS MATERIALIZED (
 SELECT decision_id,execution_account_id,evaluation_id,observed_at,phase,source_age_ms,reason,release_commit_sha
 FROM private.strata_v13_signal_decisions WHERE execution_account_id=$1
 AND ($2::timestamptz IS NULL OR (observed_at,decision_id::text)<($2::timestamptz,$3::text))
 ORDER BY observed_at DESC,decision_id::text DESC LIMIT $4
 ) SELECT ${EVALUATION_COLUMNS},
 p.decision_id::text AS "decisionId",${iso("p.observed_at")} AS "observedAt",p.phase,
 p.source_age_ms AS "sourceAgeMs",p.reason AS "liveReason",p.release_commit_sha AS "releaseCommitSha",
 i.id AS "intentId",i.state AS "intentState",i.filled_hundredths::text AS "filledHundredths",
 i.exchange_order_id AS "exchangeOrderId",i.terminal AS "intentTerminal",
 pos.quantity_hundredths::text AS "positionHundredths",pos.realized_pnl_micros::text AS "realizedPnlMicros"
 FROM phases p JOIN public.forward_test_evaluations e ON e.id=p.evaluation_id AND e.evaluation_source='paper'
 LEFT JOIN public.v13_production_intent i ON i.account_id=p.execution_account_id AND i.evaluation_id=p.evaluation_id AND i.kind='ENTRY'
 LEFT JOIN public.v13_production_position pos ON pos.account_id=p.execution_account_id AND pos.id=i.id
 ORDER BY p.observed_at DESC,p.decision_id::text DESC`;

// Ledger events, including direct-source entries, are the financial authority.
// Exact parent linkage, never ticker/time matching. P&L is retained as a
// decimal integer string; the frontend may format dollars for display.
export const TRADES_SQL=`SELECT ev.event_id AS "eventId",ev.intent_id AS "intentId",
 COALESCE(parent.evaluation_id,i.evaluation_id) AS "evaluationId",
 i.market,i.side,ev.kind,ev.pnl_micros::text AS "netPnlMicros",
 ${iso("ev.occurred_at")} AS "occurredAt"
 FROM public.v13_production_event ev
 JOIN public.v13_production_intent i ON i.id=ev.intent_id AND i.account_id=ev.account_id
 LEFT JOIN public.v13_production_intent parent ON parent.id=i.parent_id AND parent.account_id=ev.account_id
 WHERE ev.account_id=$1 AND ev.kind='SETTLEMENT'
 AND ($2::timestamptz IS NULL OR (ev.occurred_at,ev.event_id)<($2::timestamptz,$3::text))
 ORDER BY ev.occurred_at DESC,ev.event_id DESC LIMIT $4`;

// A bounded set of exact settlement events for the displayed owner traces.
// No arbitrary event payload, credentials, or account IDs enter the response.
export const LINKED_SETTLEMENT_SQL=`SELECT ev.event_id AS "eventId",ev.intent_id AS "intentId",
 COALESCE(parent.evaluation_id,i.evaluation_id) AS "evaluationId",
 i.market,i.side,ev.kind,ev.pnl_micros::text AS "netPnlMicros",
 ${iso("ev.occurred_at")} AS "occurredAt"
 FROM public.v13_production_intent entry
 JOIN public.v13_production_intent i ON i.account_id=entry.account_id AND (i.id=entry.id OR i.parent_id=entry.id)
 JOIN public.v13_production_event ev ON ev.account_id=i.account_id AND ev.intent_id=i.id AND ev.kind='SETTLEMENT'
 LEFT JOIN public.v13_production_intent parent ON parent.id=i.parent_id AND parent.account_id=i.account_id
 WHERE entry.account_id=$1 AND entry.kind='ENTRY' AND entry.evaluation_id=ANY($2::text[])
 ORDER BY ev.occurred_at DESC,ev.event_id DESC LIMIT 101`;

// Project only reviewed, non-secret fields from the transactional trace. Its
// observations are not themselves exchange fills or proof of a wire attempt.
export const LINKED_TRACE_SQL=`SELECT t.trace_id::text AS "traceId",t.evaluation_id AS "evaluationId",
 t.intent_id AS "intentId",t.kind,${iso("t.recorded_at")} AS "recordedAt",
 t.details->>'state' AS "state",t.details->>'orderKind' AS "orderKind",
 t.details->>'filledHundredths' AS "filledHundredths",
 t.details->>'eventKind' AS "eventKind",t.details->>'eventId' AS "eventId",
 t.details->>'observationKind' AS "observationKind",t.details->>'outcome' AS "outcome"
 FROM private.strata_v13_execution_trace t
 WHERE t.execution_account_id=$1 AND t.evaluation_id=ANY($2::text[])
 ORDER BY t.trace_id DESC LIMIT 301`;

type Row=Record<string,unknown>;
type Client={query(sql:string,values?:unknown[]):Promise<{rows:Row[]}>;release(error?:Error):void};
type Database={connect():Promise<Client>};
export async function readOwnerHistory(subject:string,view:HistoryView,cursor:HistoryCursor|null,db:Database=pool) {
 if(!UUID.test(subject)||!parseHistoryView(view))throw new Error("history_scope_invalid");
 if(view==="source")assertPaperAnalyticsAvailable();
 const client=await db.connect();
 let discard:Error|undefined;
 try{
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='1500ms'; SET LOCAL lock_timeout='500ms'");
  // Source observations are a shared paper feed, not an owner trade history.
  // They contain no private customer data. For live/trades require the unique
  // owned bot account, even if the authenticated caller is an administrator.
  let accountId:string|null=null;
  if(view!=="source"){
   const owner=(await client.query(OWNER_SQL,[subject,BOT_SUBACCOUNT,BOT_EXCHANGE_INDEX])).rows;
   if(owner.length===1&&typeof owner[0]?.id==="string")accountId=owner[0].id;
   if(owner.length>1)throw new Error("history_account_ambiguous");
  }
  const rows=view==="source"?(await client.query(SOURCE_SQL,[cursor?.at??null,cursor?.id??null,HISTORY_LIMIT+1])).rows:
   accountId?(await client.query(view==="live"?LIVE_SQL:TRADES_SQL,[accountId,cursor?.at??null,cursor?.id??null,HISTORY_LIMIT+1])).rows:[];
  const page=rows.slice(0,HISTORY_LIMIT);
  const last=page[page.length-1];
  const next=rows.length>HISTORY_LIMIT&&last?{
   at:String(last[view==="source"?"evaluatedAt":view==="live"?"observedAt":"occurredAt"]),
   id:String(last[view==="source"?"evaluationId":view==="live"?"decisionId":"eventId"]),
  }:null;
  const ids=view==="live"?[...new Set(page.map(r=>r.evaluationId).filter((v):v is string=>typeof v==="string"))]:[];
  const settlements=accountId&&ids.length?(await client.query(LINKED_SETTLEMENT_SQL,[accountId,ids])).rows:[];
  const executionTrace=accountId&&ids.length?(await client.query(LINKED_TRACE_SQL,[accountId,ids])).rows:[];
  await client.query("COMMIT");
  return {version:1 as const,view,scope:view==="source"?"SHARED_PAPER_SOURCE":"OWNER_LIVE_LEDGER",
   accountExists:view==="source"?null:accountId!==null,rows:page,next,
   linkedSettlements:settlements.slice(0,HISTORY_LIMIT),linkedSettlementsTruncated:settlements.length>HISTORY_LIMIT,
   // This is a page of persisted observations, not proof of complete telemetry.
   executionTrace:executionTrace.slice(0,300),executionTraceTruncated:executionTrace.length>300,
   stageTimingsPersisted:false,readOnly:true as const};
 }catch(error){
  try{await client.query("ROLLBACK");}catch{discard=new Error("history_rollback_failed");}
  throw error;
 }finally{client.release(discard);}
}
