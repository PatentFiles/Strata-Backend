/** Economic finality is separate from transport finality. These proofs never
 * assert an absent IOC was not sent, never recreate an order and never change
 * its UNKNOWN/DISPATCHED history. They authorize only a separately confirmed
 * release of that settled position's modeled reserve and stale worker fence. */
import {canonical,digest,requireProof,type Snapshot} from '../v13-production/types';
import {proveEconomicSettlement,economicSettlementPlan,type EconomicSettlementInput,type EconomicSettlementPlan} from './ownerEconomicSettlementProof';
const FAIL='economic_discharge_evidence_unverified';
type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const json=(v:unknown):Row=>{const x=typeof v==='string'?JSON.parse(v):v;requireProof(row(x),FAIL);return x;};
const amount=(v:unknown)=>{requireProof(typeof v==='string'&&/^(0|-?[1-9]\d{0,24})$/.test(v),FAIL);return BigInt(v);};
const time=(v:unknown)=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
export type EconomicDischargePlan={version:1;accountId:string;ownerId:string;bookingRequestId:string;bookingDigest:string;
 parentId:string;exitId:string;reservationId:string;settlementEventId:string;settlementDigest:string;settlement:EconomicSettlementPlan['settlement'];
 expectedRevision:string;cashMicros:string;initialCashMicros:string;releaseReserveMicros:string;exitRequest:Row;exitCapabilityDigest:string;
 exitDispatchAt:string;markerOrderDigest:string;keyFingerprint:string;historyDigest:string;evidenceDigest:string;marketDigest:string;transferDigest:string;
 observedAtMs:number;transportOutcome:'UNKNOWN';tradingAuthorized:false};
const proofs=new WeakMap<object,EconomicDischargePlan>();
/** Complete paginated management-key inventories, sampled before and after the
 * signed bracket, are required by the service. For this narrow historical
 * incident, any transfer since settlement (including an offsetting one) or any
 * non-complete cross-exchange transfer refuses. No pending item is imputed zero. */
export function verifyEconomicTransferCut(value:unknown,settledAt:number):string {
 requireProof(row(value)&&Array.isArray(value.subaccount)&&Array.isArray(value.crossExchange)&&value.complete===true,FAIL);
 requireProof(value.subaccount.length<=4000&&value.crossExchange.length<=4000,FAIL);
 for(const [kind,items] of [['subaccount',value.subaccount],['cross',value.crossExchange]] as const){
  const ids=new Set<string>();
  for(const item of items){requireProof(row(item)&&typeof item.transfer_id==='string'&&item.transfer_id.length>0&&
   item.transfer_id.length<=200&&!ids.has(item.transfer_id)&&Number.isSafeInteger(item.created_ts)&&
   Number(item.created_ts)>0&&Number(item.created_ts)*1000<settledAt,FAIL);ids.add(item.transfer_id);
   if(kind==='cross')requireProof(['complete','completed','succeeded'].includes(String(item.status))&&
    Number.isSafeInteger(item.source_exchange_shard)&&Number.isSafeInteger(item.destination_exchange_shard),FAIL);
   else requireProof(Number.isSafeInteger(item.from_subaccount)&&Number.isSafeInteger(item.to_subaccount)&&
    Number.isSafeInteger(item.exchange_index)&&Number.isSafeInteger(item.amount_cents)&&Number(item.amount_cents)>0,FAIL);
  }
 }
 return digest(value);
}
export function proveEconomicDischarge(input:EconomicSettlementInput&{booking:Row;market:unknown;transfers:unknown}){
 const x=structuredClone(input),r=x.booking,p=json(r.payload),a=x.account,h=x.history;
 requireProof(digest(p)===r.payload_digest&&p.accountId===a.id&&p.ownerId===a.owner_user_id&&p.exitId===x.exitId&&p.reservationId===x.reservationId&&
  r.execution_account_id===a.id&&r.owner_user_id===a.owner_user_id&&r.exit_intent_id===x.exitId&&r.reservation_id===x.reservationId&&
  typeof r.request_id==='string'&&r.transport_outcome==='UNKNOWN'&&r.trading_authorized===false&&p.transportOutcome==='UNKNOWN'&&p.tradingAuthorized===false&&
  p.cashAfterMicros===a.cash_micros&&p.reservedMicros===a.reserved_micros&&amount(a.reserved_micros)>0n,FAIL);
 const settlement=json(p.settlement) as unknown as EconomicSettlementPlan['settlement'];
 requireProof(p.eventId===r.settlement_event_id&&p.eventId==='settlement:'+settlement.id&&digest(settlement)===r.settlement_digest&&
  amount(String(r.posted_revision))===amount(String(r.prior_revision))+1n&&amount(a.revision)>=amount(String(r.posted_revision)),FAIL);
 const events=h.events.filter(e=>e.event_id===p.eventId),positions=h.positions.filter(q=>q.id===p.parentId),parents=h.rows.filter(i=>i.id===p.parentId);
 requireProof(events.length===1&&positions.length===1&&parents.length===1,FAIL);
 const e=events[0]!,position=positions[0]!,parent=parents[0]!;
 requireProof(e.kind==='SETTLEMENT'&&e.intent_id===p.parentId&&e.digest===r.settlement_digest&&canonical(json(e.payload))===canonical(settlement)&&
  String(e.cash_delta_micros)===p.cashDeltaMicros&&String(e.pnl_micros)===p.pnlMicros&&time(e.occurred_at)===settlement.occurredAtMs&&
  String(position.quantity_hundredths)==='0'&&String(position.basis_micros)==='0'&&parent.reserved_micros===a.reserved_micros&&
  h.rows.filter(i=>i.id!==parent.id).every(i=>String(i.reserved_micros)==='0'),FAIL);
 // Reconstruct the exact pre-booking accounting projection in memory, then
 // rerun the original signed full-history proof. This is NOT a database rewrite
 // or a second settlement: the discharge writer is incapable of crediting cash.
 const before={...x,account:{...a,cash_micros:String(p.cashBeforeMicros)},history:{...h,
  events:h.events.filter(event=>event.event_id!==p.eventId),
  positions:h.positions.map(q=>q.id===parent.id?{...q,quantity_hundredths:settlement.quantityHundredths,
   basis_micros:String(amount(p.cashDeltaMicros)-amount(p.pnlMicros)),
   realized_pnl_micros:String(amount(q.realized_pnl_micros)-amount(p.pnlMicros))}:q)}};
 const replay=economicSettlementPlan(proveEconomicSettlement(before));
 for(const key of ['parentId','exitId','reservationId','eventId','cashBeforeMicros','cashAfterMicros','cashDeltaMicros','pnlMicros','reservedMicros'] as const)
  requireProof(replay[key]===p[key],FAIL);
 requireProof(row(x.market),FAIL);const m=x.market;
 // finalized is the venue's terminal, payout-complete state. A merely closed,
 // determined, disputed, amended or scalar market never discharges this debt.
 requireProof(m.ticker===settlement.market&&m.exchange_index===2&&m.market_type==='binary'&&m.status==='finalized'&&
  m.result===settlement.result.toLowerCase()&&m.is_provisional!==true&&typeof m.settlement_ts==='string'&&
  settlement.id===settlement.market+':'+m.settlement_ts&&time(m.settlement_ts)===settlement.occurredAtMs&&
  Number.isFinite(time(m.close_time))&&time(m.close_time)<=settlement.occurredAtMs&&
  m.settlement_value_dollars===(settlement.result==='YES'?'1.0000':'0.0000'),FAIL);
 const transferDigest=verifyEconomicTransferCut(x.transfers,settlement.occurredAtMs);
 const exit=h.rows.find(i=>i.id===x.exitId)!,marker=h.markers.find(q=>q.reservation_id===x.reservationId)!;
 const plan:EconomicDischargePlan={version:1,accountId:a.id,ownerId:a.owner_user_id,bookingRequestId:r.request_id,bookingDigest:String(r.payload_digest),
  parentId:String(parent.id),exitId:x.exitId,reservationId:x.reservationId,settlementEventId:String(p.eventId),settlementDigest:String(r.settlement_digest),settlement,
  expectedRevision:a.revision,cashMicros:a.cash_micros,initialCashMicros:a.initial_cash_micros,releaseReserveMicros:a.reserved_micros,
  exitRequest:json(exit.request),exitCapabilityDigest:String(exit.capability_digest),exitDispatchAt:new Date(time(exit.dispatch_at)).toISOString(),
  markerOrderDigest:String(marker.order_digest),keyFingerprint:a.key_fingerprint,historyDigest:digest(h),evidenceDigest:digest(x.snapshot),marketDigest:digest(m),transferDigest,
  observedAtMs:x.snapshot.observedAtMs,transportOutcome:'UNKNOWN',tradingAuthorized:false};
 const token=Object.freeze({accountId:a.id,digest:digest(plan)});proofs.set(token,plan);return token;
}
export type EconomicDischargeProof=ReturnType<typeof proveEconomicDischarge>;
export function economicDischargePlan(proof:EconomicDischargeProof):EconomicDischargePlan{
 const plan=proofs.get(proof);requireProof(plan,'economic_discharge_process_local_proof_required');return structuredClone(plan);
}
