import {digest,requireProof,type Snapshot} from '../v13-production/types';
import {deployedGitSha} from './deployedGitSha';
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
const fail='owner_arm_settled_reserve_receipt_unverified';
export function settledReserveReadinessEnabled(env=process.env){
 const sha=deployedGitSha(env);
 return /^[a-f0-9]{40}$/.test(sha)&&env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA===sha;
}
/** Exact release opt-in; default is deliberate no-entry containment. */
export function settledReserveContinuationEnabled(env=process.env){
 return settledReserveReadinessEnabled(env)&&env.STRATA_SETTLED_EXIT_CONTINUATION_SHA===deployedGitSha(env);
}
export type StoppedSettledExitDisposition={exitId:string;entryId:string;reservationId:string;clientOrderId:string;market:string;
 eventId:string;eventDigest:string;receiptDigest:string;settledAtMs:number};
/** Structural receipt reader only. Its results cannot prove that the venue has
 * no contradictory order or fill. The ARM ceremony still needs its signed
 * history and does not grant execution authority from this local read.
 * Both receipt tables reject UPDATE and DELETE. Lock only mutable proof
 * inputs; the runtime deliberately lacks UPDATE on the immutable receipts.
 */
export async function readStoppedSettledExitDispositions(db:Query,account:string,owner:string,lock=false,enabled=settledReserveReadinessEnabled()){
 if(!enabled)return [];
 const rows=(await db.query(`SELECT d.*, s.payload,s.payload_digest,s.settlement_event_id,s.settlement_digest,
    i.client_order_id,m.market_ticker AS market, e.occurred_at
  FROM private.strata_settled_exit_reserve_disposition d
  JOIN private.strata_economic_settlement_receipt s ON s.request_id=d.settlement_request_id
   AND s.execution_account_id=d.execution_account_id AND s.owner_user_id=d.owner_user_id
   AND s.entry_intent_id=d.entry_intent_id AND s.exit_intent_id=d.exit_intent_id AND s.reservation_id=d.reservation_id
  JOIN public.v13_production_account a ON a.id=d.execution_account_id AND a.owner_user_id=d.owner_user_id
   AND a.subaccount=1 AND a.exchange_index=2 AND a.revision>=d.applied_revision
  JOIN public.v13_production_intent i ON i.id=d.exit_intent_id AND i.account_id=a.id AND i.parent_id=d.entry_intent_id
   AND i.kind='EXIT' AND i.state IN ('DISPATCHED','UNKNOWN') AND NOT i.terminal
   AND i.exchange_order_id IS NULL AND i.filled_hundredths=0 AND i.reserved_micros=0
  JOIN public.v13_production_intent j ON j.id=d.entry_intent_id AND j.account_id=a.id
   AND j.kind='ENTRY' AND j.terminal AND j.state='TERMINAL' AND j.reserved_micros=0
  JOIN public.v13_production_position p ON p.id=j.id AND p.account_id=a.id AND p.quantity_hundredths=0 AND p.basis_micros=0
  JOIN private.strata_emergency_exit_reservations m ON m.reservation_id=d.reservation_id AND m.execution_account_id=a.id
   AND m.owner_user_id=d.owner_user_id AND m.client_order_id=i.client_order_id AND m.state='UNKNOWN' AND NOT m.trading_authorized
  JOIN public.v13_production_event e ON e.account_id=a.id AND e.event_id=s.settlement_event_id AND e.intent_id=j.id
   AND e.kind='SETTLEMENT' AND e.digest=s.settlement_digest AND e.payload=s.payload->'settlement'
   AND e.cash_delta_micros::text=s.payload->>'cashDeltaMicros' AND e.pnl_micros::text=s.payload->>'pnlMicros'
  WHERE d.execution_account_id=$1 AND d.owner_user_id=$2::uuid
   AND d.prior_revision=s.posted_revision AND d.control_epoch=s.control_epoch AND d.worker_fencing_token=s.worker_fencing_token
   AND d.released_micros::text=s.payload->>'reservedMicros'
   AND d.transport_outcome='UNKNOWN' AND NOT d.trading_authorized AND s.transport_outcome='UNKNOWN' AND NOT s.trading_authorized
  ORDER BY d.exit_intent_id LIMIT 2${lock?' FOR SHARE OF i,j,p,m,e':''}`,[account,owner])).rows;
 requireProof(rows.length<=1,fail);
 return rows.map((r):StoppedSettledExitDisposition=>{
  const p=typeof r.payload==='string'?JSON.parse(r.payload):r.payload;
  const at=r.occurred_at instanceof Date?r.occurred_at.getTime():Date.parse(String(r.occurred_at));
  requireProof(p&&typeof p==='object'&&digest(p)===r.payload_digest&&p.ownerId===owner&&p.accountId===account&&
   p.transportOutcome==='UNKNOWN'&&p.tradingAuthorized===false&&p.exitId===r.exit_intent_id&&p.parentId===r.entry_intent_id&&
   p.reservationId===r.reservation_id&&p.eventId===r.settlement_event_id&&p.settlement?.market===r.market&&
   /^KXBTC15M-[A-Za-z0-9-]+$/.test(String(r.market))&&r.client_order_id===`v13p-${r.exit_intent_id}`&&
   Number.isSafeInteger(at)&&p.settlement?.occurredAtMs===at,fail);
  return {exitId:String(r.exit_intent_id),entryId:String(r.entry_intent_id),reservationId:String(r.reservation_id),
   clientOrderId:String(r.client_order_id),market:String(r.market),eventId:String(r.settlement_event_id),
   eventDigest:String(r.settlement_digest),receiptDigest:digest(r),settledAtMs:at};
 });
}
export function verifyDisposedExitAgainstSnapshot(d:StoppedSettledExitDisposition,s:Snapshot){
 requireProof(s.authenticated&&s.complete&&s.cashExact&&!s.unexplainedCashActivity&&s.observedAtMs>=d.settledAtMs&&
  s.historyFromMs<=d.settledAtMs&&
  !s.orders.some(o=>o.request.clientOrderId===d.clientOrderId)&&!s.fills.some(f=>f.clientOrderId===d.clientOrderId)&&
  !s.positions.some(p=>p.market===d.market&&p.quantityHundredths!=='0')&&
  s.settlements.filter(x=>`settlement:${x.id}`===d.eventId&&digest(x)===d.eventDigest).length===1,fail);
}

/** Audit mode, or caller's held transaction with the account already locked.
 * No current order, other receipt, open position or reserve is ignored. */
export async function stoppedArmExposure(db:Query,account:string,owner:string,lock=false,enabled=settledReserveReadinessEnabled()){
 const receipts=await readStoppedSettledExitDispositions(db,account,owner,lock,enabled);
 const row=(await db.query(`SELECT
   EXISTS(SELECT 1 FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) AS positions,
   EXISTS(SELECT 1 FROM public.v13_production_intent WHERE account_id=$1
     AND (terminal IS DISTINCT FROM TRUE OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0)
     AND NOT(id=ANY($2::text[]))) AS intents,
   EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1
     AND state IN ('PREPARED','DISPATCHED','UNKNOWN') AND NOT(reservation_id=ANY($3::uuid[]))) AS exits`,
  [account,receipts.map(x=>x.exitId),receipts.map(x=>x.reservationId)])).rows;
 requireProof(row.length===1&&['positions','intents','exits'].every(k=>typeof row[0]![k]==='boolean'),fail);
 return {clear:row[0]!.positions===false&&row[0]!.intents===false&&row[0]!.exits===false,receipts};
}
