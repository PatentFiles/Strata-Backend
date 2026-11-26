import {canonical,digest,requireProof} from '../v13-production/types';
import {economicSettlementPlan,proveEconomicSettlement,type EconomicSettlementInput} from './ownerEconomicSettlementProof';

type Row=Record<string,unknown>;
const fail='settled_exit_reserve_evidence_unverified';
const uint=(x:unknown)=>typeof x==='string'&&/^(0|[1-9][0-9]{0,24})$/.test(x);
const row=(x:unknown):Row=>{const v=typeof x==='string'?JSON.parse(x):x;requireProof(v&&typeof v==='object'&&!Array.isArray(v),fail);return v as Row;};

/** Read-only, stopped-account proof for the single already-posted settlement case.
 * Callers must get the receipt from the immutable owner-scoped store and supply
 * a fresh server-authenticated exchange bracket, not client-supplied snapshots.
 * This version deliberately refuses intervening financial revisions. It neither
 * releases money nor settles, voids, or authorizes an order.
 */
export function inspectSettledExitReserve(input:EconomicSettlementInput,receipt:Row){
 const {account:a,history:h,snapshot:s,exitId,reservationId}=structuredClone(input);
 const p=row(receipt.payload);
 requireProof(digest(p)===receipt.payload_digest&&p.ownerId===a.owner_user_id&&p.accountId===a.id&&
  receipt.owner_user_id===a.owner_user_id&&receipt.execution_account_id===a.id&&
  receipt.exit_intent_id===exitId&&receipt.reservation_id===reservationId&&
  p.exitId===exitId&&p.reservationId===reservationId&&receipt.entry_intent_id===p.parentId&&
  receipt.settlement_event_id===p.eventId&&receipt.settlement_digest===digest(p.settlement)&&
  p.transportOutcome==='UNKNOWN'&&p.tradingAuthorized===false&&
  receipt.transport_outcome==='UNKNOWN'&&receipt.trading_authorized===false&&
  uint(p.expectedRevision)&&uint(p.cashBeforeMicros)&&uint(p.cashAfterMicros)&&uint(p.cashDeltaMicros)&&uint(p.reservedMicros)&&
  typeof p.pnlMicros==='string'&&/^(0|-?[1-9][0-9]{0,24})$/.test(p.pnlMicros)&&
  String(receipt.prior_revision)===p.expectedRevision&&uint(a.revision)&&
  String(receipt.posted_revision)===a.revision&&BigInt(a.revision)===BigInt(String(p.expectedRevision))+1n&&
  p.cashAfterMicros===a.cash_micros&&s.cashMicros===a.cash_micros&&p.reservedMicros===a.reserved_micros&&
  BigInt(a.cash_micros)===BigInt(String(p.cashBeforeMicros))+BigInt(String(p.cashDeltaMicros)),fail);
 const events=h.events.filter(e=>e.event_id===p.eventId),positions=h.positions.filter(q=>q.id===p.parentId);
 requireProof(events.length===1&&positions.length===1,fail);
 const e=events[0]!,q=positions[0]!,settled=row(p.settlement);
 requireProof(e.account_id===a.id&&e.intent_id===p.parentId&&e.kind==='SETTLEMENT'&&
  e.digest===receipt.settlement_digest&&canonical(row(e.payload))===canonical(settled)&&
  String(e.cash_delta_micros)===p.cashDeltaMicros&&String(e.pnl_micros)===p.pnlMicros&&
  (e.occurred_at instanceof Date?e.occurred_at.getTime():Date.parse(String(e.occurred_at)))===settled.occurredAtMs&&
  q.account_id===a.id&&q.quantity_hundredths==='0'&&q.basis_micros==='0'&&q.realized_pnl_micros===p.pnlMicros,fail);
 const basis=BigInt(String(p.cashDeltaMicros))-BigInt(String(p.pnlMicros));
 requireProof(basis>0n&&uint(settled.quantityHundredths)&&h.receipts.length===0,fail);
 // Reconstruct the accounting input only in memory. The existing proof
 // redoes the whole two-way cash, fill, settlement and position fold using the
 // new exchange bracket; a missing order alone never passes this check.
 const verified=economicSettlementPlan(proveEconomicSettlement({...input,account:{...a,
  cash_micros:String(p.cashBeforeMicros),revision:String(p.expectedRevision)},history:{...h,
  events:h.events.filter(x=>x.event_id!==e.event_id),positions:h.positions.map(x=>x.id===q.id?
   {...x,quantity_hundredths:settled.quantityHundredths,basis_micros:String(basis),realized_pnl_micros:'0'}:x)}}));
 requireProof(verified.eventId===p.eventId&&verified.parentId===p.parentId&&verified.cashAfterMicros===p.cashAfterMicros&&
  verified.pnlMicros===p.pnlMicros&&verified.reservedMicros===p.reservedMicros&&
  canonical(verified.settlement)===canonical(settled),fail);
 return {status:'SETTLED_WITH_UNKNOWN_TRANSPORT_EVIDENCE_MATCHED',accountId:a.id,exitId,reservationId,
  eventId:verified.eventId,reservedMicros:verified.reservedMicros,evidenceDigest:verified.evidenceDigest,
  transportOutcome:'UNKNOWN',reserveReleased:false,accountingPosted:false,tradingAuthorized:false} as const;
}
