import {observePrepareRead,type PrepareReadCapture} from '../v13-production/prepareReadTiming';
import {canonical,digest,requireProof,type Snapshot} from '../v13-production/types';
type Row=Record<string,unknown>;type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
/** Rollout only; false retains the original fail-closed UNKNOWN behavior. A
 * missing migration/function with rollout enabled is a DB failure, never zero. */
export const economicExitFinalityEnabled=()=>process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED==='true';
export function economicExitNotDischarged(account:string,client:string,skipAbsentReceipt=false):string {
 for(const value of [account,client])if(!/^(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))throw Error('economic_discharge_sql_identifier_invalid');
 if(!economicExitFinalityEnabled())return '';
 const proof=`private.strata_has_economic_exit_discharge(${account},${client})`;
 if(!skipAbsentReceipt)return ` AND NOT ${proof}`;
 // This narrow PIN read optimization can only skip a proof that would be false.
 // An absent receipt REMAINS unresolved. An existing receipt always invokes
 // the full canonical proof. Qualified outer aliases prevent accidental inner
 // column binding in the EXISTS subquery; default callers retain exact SQL.
 for(const value of [account,client])if(!/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)||value.startsWith('economic_candidate.'))throw Error('economic_discharge_qualified_outer_alias_required');
 return ` AND NOT CASE WHEN EXISTS(SELECT 1 FROM private.strata_economic_exit_discharge economic_candidate
  WHERE economic_candidate.execution_account_id=${account} AND economic_candidate.client_order_id=${client})
  THEN ${proof} ELSE false END`;
}
export async function readEconomicExitDischarges(db:Query,account:string,_lock=false,projectCanonical=false,prepareReads?:PrepareReadCapture){
 if(!economicExitFinalityEnabled())return [] as Row[];
 // Immutable rows need SELECT only; the owning account lock fences new receipt
 // insertion. Never grant UPDATE merely to issue a redundant FOR SHARE.

 const result=await observePrepareRead(prepareReads,'receipt_rows',()=>db.query(`SELECT d.*,d.xmin::text AS row_revision${projectCanonical?',private.strata_has_economic_exit_discharge($1,d.client_order_id) AS canonical_verified':''}
  FROM private.strata_economic_exit_discharge d
  WHERE execution_account_id=$1 ORDER BY request_id LIMIT 1001`,[account]));
 if(!projectCanonical)return verifyEconomicExitDischargeRows(db,account,result.rows,prepareReads);
 requireProof(result.rows.length<=1000,'economic_discharge_history_capacity');
 // One statement re-evaluates every immutable receipt using the canonical
 // SQL function. The financial writer repeats the proof under the owner lock.
 // Keep the proof-only column outside the original request/history digest.
 return result.rows.map(({canonical_verified,...d})=>{
  verifiedReceipt(account,d);
  requireProof(canonical_verified===true,'economic_discharge_financial_contradiction');
  return d;
 });
}
function verifiedReceipt(account:string,d:Row){
  const p=typeof d.payload==='string'?JSON.parse(d.payload):d.payload;
  requireProof(p&&typeof p==='object'&&!Array.isArray(p)&&digest(p)===d.payload_digest&&
   p.accountId===account&&p.ownerId===d.owner_user_id&&p.exitId===d.exit_intent_id&&p.parentId===d.entry_intent_id&&
   p.reservationId===d.reservation_id&&p.settlementEventId===d.settlement_event_id&&p.settlementDigest===d.settlement_digest&&
   p.bookingRequestId===d.booking_request_id&&p.bookingDigest===d.booking_digest&&p.transportOutcome==='UNKNOWN'&&p.tradingAuthorized===false&&
   canonical(p.exitRequest)===canonical(d.exit_request)&&p.exitCapabilityDigest===d.exit_capability_digest,
   'economic_discharge_receipt_unverified');
}
export async function verifyEconomicExitDischargeRows(db:Query,account:string,rows:Row[],prepareReads?:PrepareReadCapture){
 requireProof(rows.length<=1000,'economic_discharge_history_capacity');
 for(const d of rows){
  verifiedReceipt(account,d);
  const valid=await observePrepareRead(prepareReads,'canonical_receipt',()=>db.query('SELECT private.strata_has_economic_exit_discharge($1,$2) AS verified',[account,d.client_order_id]));
  requireProof(valid.rows.length===1&&valid.rows[0].verified===true,'economic_discharge_financial_contradiction');
 }
 return rows;
}
export function assertNoEconomicExitContradiction(discharges:Row[],snapshot:{orders:{request:{clientOrderId:string}}[];fills:{clientOrderId:string}[]}){
 const clients=new Set(discharges.map(d=>String(d.client_order_id)));
 requireProof(!snapshot.orders.some(o=>clients.has(o.request.clientOrderId))&&!snapshot.fills.some(f=>clients.has(f.clientOrderId)),
  'economic_discharge_late_order_or_fill_requires_review');
}

export function assertEconomicDischargeSettlements(discharges:Row[],snapshot:Snapshot){
 requireProof(discharges.every(d=>snapshot.settlements.filter(s=>
  `settlement:${s.id}`===d.settlement_event_id&&digest(s)===d.settlement_digest).length===1),
  'economic_discharge_final_settlement_unverified');
}
