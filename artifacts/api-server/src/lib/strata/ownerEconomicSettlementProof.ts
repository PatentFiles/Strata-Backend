import {createHash} from 'node:crypto';
import {requestQuantityHundredths} from '../v13-production/requestQuantity';
import {canonical,digest,requireProof,type Snapshot,type Settlement} from '../v13-production/types';
import {verifyReconciledReleaseRenewalSnapshot,type ReconciledReleaseHistory} from './reconciledReleaseRenewalHistory';

type Row=Record<string,unknown>;
export type EconomicSettlementAccount={id:string;owner_user_id:string;subaccount:number;exchange_index:number;key_fingerprint:string;
 revision:string;cash_micros:string;initial_cash_micros:string;reserved_micros:string};
export type EconomicSettlementInput={account:EconomicSettlementAccount;history:ReconciledReleaseHistory;snapshot:Snapshot;
 exitId:string;reservationId:string;rawSettlement:Row;rawPosition:Row;nowMs:number};
const fail='economic_settlement_evidence_unverified';
const json=(v:unknown):Row=>{const p=typeof v==='string'?JSON.parse(v):v;requireProof(p&&typeof p==='object'&&!Array.isArray(p),fail);return p as Row;};
const integer=(v:unknown):bigint=>{requireProof(typeof v==='string'&&/^(0|-?[1-9]\d{0,24})$/.test(v),fail);return BigInt(v);};
const dollars=(v:unknown):bigint=>{requireProof(typeof v==='string'&&/^(0|[1-9]\d{0,12})\.\d{6}$/.test(v),fail);return BigInt(v.replace('.',''));};
const quantity=(v:unknown):bigint=>{requireProof(typeof v==='string'&&/^(0|[1-9]\d{0,10})\.\d{2}$/.test(v),fail);return BigInt(v.replace('.',''));};
const at=(v:unknown)=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
const sum=(rows:Row[],key:string)=>rows.reduce((n,row)=>n+integer(row[key]),0n);
export type EconomicSettlementPlan={accountId:string;ownerId:string;expectedRevision:string;parentId:string;exitId:string;reservationId:string;
 settlement:Settlement;eventId:string;cashBeforeMicros:string;cashAfterMicros:string;cashDeltaMicros:string;pnlMicros:string;
 reservedMicros:string;historyDigest:string;evidenceDigest:string;observedAtMs:number;transportOutcome:'UNKNOWN';tradingAuthorized:false};
const plans=new WeakMap<object,EconomicSettlementPlan>();

/** This is a proposed accounting projection, NOT an order-terminal or no-send proof.
 * The uncertain EXIT remains in the original history, with its original state.
 * Only a single whole-position, buy-only market settlement is admitted. Mixed
 * side/partially sold positions, missing history and all other uncertainty refuse.
 * The immutable plan is process-local; serialized/browser objects have no authority.
 */
export function proveEconomicSettlement(input:EconomicSettlementInput){
 const {account:a,history:h,snapshot:s,exitId,reservationId,rawSettlement:raw,rawPosition:position,nowMs}=structuredClone(input);
 requireProof(a.subaccount===1&&a.exchange_index===2&&/^[a-f0-9]{64}$/.test(a.key_fingerprint)&&
  canonical(s.identity)===canonical({subaccount:1,exchangeIndex:2,keyFingerprint:a.key_fingerprint})&&
  s.authenticated&&s.complete&&s.cashExact&&!s.unexplainedCashActivity&&
  Number.isSafeInteger(nowMs)&&Number.isSafeInteger(s.observedAtMs)&&s.observedAtMs<=nowMs&&nowMs-s.observedAtMs<=5000&&
  s.positions.length===0&&s.orders.every(o=>o.terminal)&&h.rows.length>0&&h.rows.length<=1000&&h.events.length<=3000&&h.positions.length<=1000&&h.markers.length<=1000,fail);
 requireProof(new Set(h.rows.map(i=>i.id)).size===h.rows.length&&h.rows.every(i=>i.account_id===a.id)&&
  h.events.every(e=>e.account_id===a.id)&&h.positions.every(p=>p.account_id===a.id)&&
  s.historyFromMs<=Math.min(...h.rows.map(i=>at(i.created_at))),fail);
 const exits=h.rows.filter(i=>i.id===exitId),markers=h.markers.filter(m=>m.reservation_id===reservationId);
 requireProof(exits.length===1&&markers.length===1,fail);const exit=exits[0]!,marker=markers[0]!;
 const parent=h.rows.find(i=>i.id===exit.parent_id),p=h.positions.find(p=>p.id===exit.parent_id);
 requireProof(parent&&p&&exit.kind==='EXIT'&&['DISPATCHED','UNKNOWN'].includes(String(exit.state))&&exit.terminal===false&&
  exit.exchange_order_id===null&&exit.dispatch_at!==null&&integer(exit.filled_hundredths)===0n&&integer(exit.reserved_micros)===0n&&
  parent.kind==='ENTRY'&&parent.state==='TERMINAL'&&parent.terminal===true&&p.market===exit.market&&p.side===exit.side&&
  p.market===parent.market&&p.side===parent.side&&integer(p.quantity_hundredths)>0n&&integer(p.basis_micros)>0n,fail);
 requireProof(marker.owner_user_id===a.owner_user_id&&marker.execution_account_id===a.id&&marker.state==='UNKNOWN'&&
  marker.trading_authorized===false&&marker.client_order_id===exit.client_order_id&&marker.market_ticker===exit.market&&
  marker.reducing_side===exit.side&&integer(String(marker.quantity_hundredths))===integer(p.quantity_hundredths),fail);
 const exitRequest=json(exit.request),rawOrder=marker.order_request_json;
 requireProof(typeof rawOrder==='string'&&rawOrder.length<=4096&&createHash('sha256').update(rawOrder).digest('hex')===marker.order_digest,fail);
 const wire=json(rawOrder),quantityHundredths=requestQuantityHundredths(exitRequest as never);
 requireProof(quantityHundredths===integer(p.quantity_hundredths)&&wire.client_order_id===exit.client_order_id&&
  wire.ticker===exit.market&&wire.subaccount===1&&wire.exchange_index===2&&wire.reduce_only===true&&wire.post_only===false&&
  wire.time_in_force==='immediate_or_cancel'&&wire.self_trade_prevention_type==='taker_at_cross'&&
  wire.side===(exit.side==='YES'?'ask':'bid')&&wire.count===String(quantityHundredths/100n)+'.'+String(quantityHundredths%100n).padStart(2,'0')&&
  typeof wire.price==='string'&&/^0\.\d{4}$/.test(wire.price)&&Number.isSafeInteger(exitRequest.limitMicros)&&
  BigInt(wire.price.slice(2))*100n===BigInt(exit.side==='YES'?Number(exitRequest.limitMicros):1000000-Number(exitRequest.limitMicros))&&
  integer(parent.reserved_micros)===integer(parent.exit_fee_micros)&&integer(parent.reserved_micros)>0n,fail);
 const absent=new Set(h.neverPosted.map(x=>x.intentId));
 for(const i of h.rows){
  const request=json(i.request),decision=json(i.decision);
  requireProof(request.clientOrderId===i.client_order_id&&request.clientOrderId===`v13p-${i.id}`&&request.market===i.market&&
   request.side===i.side&&request.timeInForce==='IOC'&&
   i.capability_digest===digest({id:i.id,request,decision,policyHash:i.policy_hash,fee:i.fee_fingerprint}),fail);
  if(i.id===exitId){requireProof(request.action==='SELL'&&request.reduceOnly===true,fail);continue;}
  requireProof(i.terminal===true&&(absent.has(String(i.id))?i.state==='BLOCKED':i.state==='TERMINAL'&&typeof i.exchange_order_id==='string'&&i.exchange_order_id.length>0),fail);
 }
 requireProof(h.markers.every(m=>m.execution_account_id===a.id&&m.owner_user_id===a.owner_user_id&&m.trading_authorized===false&&
  (m.reservation_id===reservationId||m.state==='RECONCILED'||m.state==='VOID'&&h.neverPosted.some(n=>n.clientOrderId===m.client_order_id))),fail);
 requireProof(!s.orders.some(o=>o.request.clientOrderId===exit.client_order_id)&&!s.fills.some(f=>f.clientOrderId===exit.client_order_id)&&
  h.positions.filter(q=>q.id!==p.id).every(q=>integer(q.quantity_hundredths)===0n&&integer(q.basis_micros)===0n),fail);
 const settlements=s.settlements.filter(x=>x.market===exit.market&&x.side===exit.side);
 requireProof(settlements.length===1,fail);const settlement=settlements[0]!;
 const eventId=`settlement:${settlement.id}`;
 requireProof(!h.events.some(e=>e.event_id===eventId)&&settlement.feeMicros==='0'&&
  integer(settlement.quantityHundredths)===integer(p.quantity_hundredths)&&
  settlement.occurredAtMs>=at(exit.dispatch_at)&&settlement.occurredAtMs<=s.observedAtMs,fail);
 const fills=s.fills.filter(f=>f.market===settlement.market);
 requireProof(fills.length>0&&fills.every(f=>f.clientOrderId===parent.client_order_id&&f.action==='BUY'&&f.side===settlement.side&&f.occurredAtMs<settlement.occurredAtMs),fail);
 const gross=fills.reduce((n,f)=>n+integer(f.grossMicros),0n),fees=fills.reduce((n,f)=>n+integer(f.feeMicros),0n);
 const qty=fills.reduce((n,f)=>n+integer(f.quantityHundredths),0n),side=settlement.side==='YES'?'yes':'no',other=side==='yes'?'no':'yes';
 requireProof(raw.ticker===settlement.market&&raw.exchange_index===2&&(raw.subaccount===undefined||raw.subaccount===1)&&
  raw.market_result===settlement.result.toLowerCase()&&typeof raw.settled_time==='string'&&
  settlement.id===`${settlement.market}:${raw.settled_time}`&&at(raw.settled_time)===settlement.occurredAtMs&&
  quantity(raw[`${side}_count_fp`])===qty&&quantity(raw[`${other}_count_fp`])===0n&&qty===integer(settlement.quantityHundredths)&&
  dollars(raw[`${side}_total_cost_dollars`])===gross&&dollars(raw[`${other}_total_cost_dollars`])===0n&&dollars(raw.fee_cost)===fees&&
  Number.isSafeInteger(raw.revenue)&&BigInt(Number(raw.revenue))*10000n===integer(settlement.payoutMicros)&&
  gross+fees===integer(p.basis_micros),fail);
 requireProof(position.ticker===settlement.market&&position.exchange_index===2&&(position.subaccount===undefined||position.subaccount===1)&&
  position.position_fp==='0.00'&&dollars(position.total_traded_dollars)===gross,fail);
 // Existing accounting must already conserve. A settlement cannot repair or
 // hide an unrelated capital, reserve, basis, fee or P&L inconsistency.
 const cash=integer(a.cash_micros),initial=integer(a.initial_cash_micros),reserved=integer(a.reserved_micros);
 requireProof(cash===initial+sum(h.events,'cash_delta_micros')&&reserved===sum(h.rows,'reserved_micros')&&reserved>=0n&&
  cash+sum(h.positions,'basis_micros')===initial+sum(h.events,'pnl_micros')&&
  sum(h.positions,'realized_pnl_micros')===sum(h.events,'pnl_micros'),fail);
 const delta=integer(settlement.payoutMicros),pnl=delta-integer(p.basis_micros);
 requireProof(integer(s.cashMicros)===cash+delta,fail);
 const proposal:ReconciledReleaseHistory={...h,
  expectedRequests:h.expectedRequests.filter(r=>r.clientOrderId!==exit.client_order_id),
  events:[...h.events,{account_id:a.id,event_id:eventId,intent_id:parent.id,kind:'SETTLEMENT',digest:digest(settlement),
    payload:settlement,cash_delta_micros:String(delta),pnl_micros:String(pnl),occurred_at:new Date(settlement.occurredAtMs)}],
  positions:h.positions.map(q=>q.id===p.id?{...q,quantity_hundredths:'0',basis_micros:'0',realized_pnl_micros:String(integer(q.realized_pnl_micros)+pnl)}:q)};
 // Reuse the canonical full-history two-way financial fold. The proposed event
 // is checked before it is ever written; the UNKNOWN row is never rewritten.
 verifyReconciledReleaseRenewalSnapshot(proposal,s);
 const plan:EconomicSettlementPlan={accountId:a.id,ownerId:a.owner_user_id,expectedRevision:a.revision,parentId:String(parent.id),exitId,reservationId,
  settlement,eventId,cashBeforeMicros:String(cash),cashAfterMicros:String(cash+delta),cashDeltaMicros:String(delta),pnlMicros:String(pnl),
  reservedMicros:String(reserved),historyDigest:digest(h),evidenceDigest:digest(s),observedAtMs:s.observedAtMs,transportOutcome:'UNKNOWN',tradingAuthorized:false};
 const token=Object.freeze({digest:digest(plan),accountId:a.id,eventId});plans.set(token,structuredClone(plan));return token;
}
export type EconomicSettlementProof=ReturnType<typeof proveEconomicSettlement>;
export function economicSettlementPlan(proof:EconomicSettlementProof):EconomicSettlementPlan{
 const plan=plans.get(proof);requireProof(plan,'economic_settlement_process_local_proof_required');return structuredClone(plan);
}