import {createHash} from 'node:crypto';
import {canonical,digest,requireProof} from '../v13-production/types';
import {requestQuantityHundredths,formatContractHundredths} from '../v13-production/requestQuantity';
type Row=Record<string,unknown>;
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const json=(v:unknown):unknown=>typeof v==='string'?JSON.parse(v):v;
const zero=(v:unknown)=>String(v)==='0';
const positive=(v:unknown)=>/^[1-9]\d*$/.test(String(v));
const fail='release_never_posted_exit_evidence_invalid_or_contradictory';

/** Read-only validation of the receipt produced by recoverPreparedOwnedExitIntents.
 * Never treats a status/reason alone as proof. Caller also rejects financial events
 * and checks complete signed provider history for contradictions and final revisions.
 */
export function validateExpiredExitNoSend(i:Row,rows:Row[],observations:Row[],markers:Row[],accountId:string,ownerId:string){
 const r=json(i.request),d=json(i.decision),receipt=observations[0];
 const p=receipt?json(receipt.payload):null;
 requireProof(object(r)&&object(d)&&object(p)&&observations.length===1&&receipt&&
  receipt.account_id===accountId&&receipt.kind==='PROVEN_NOT_POSTED'&&receipt.digest===digest(p)&&
  p.id===i.id&&p.reason==='production_prepared_exit_expired',fail);
 requireProof(i.account_id===accountId&&i.kind==='EXIT'&&i.state==='BLOCKED'&&i.terminal===true&&
  i.dispatch_at===null&&i.exchange_order_id===null&&i.cancel_attempted===false&&
  zero(i.filled_hundredths)&&zero(i.reserved_micros)&&zero(i.exit_fee_micros)&&
  r.clientOrderId===i.client_order_id&&r.clientOrderId===`v13p-${i.id}`&&
  r.market===i.market&&/^KXBTC15M-[A-Za-z0-9-]+$/.test(String(r.market))&&
  r.side===i.side&&['YES','NO'].includes(String(r.side))&&r.action==='SELL'&&r.reduceOnly===true&&r.timeInForce==='IOC'&&
  Number.isSafeInteger(r.limitMicros)&&Number(r.limitMicros)>=100&&Number(r.limitMicros)<=999900&&Number(r.limitMicros)%100===0&&
  i.capability_digest===digest({id:i.id,request:r,decision:d,policyHash:i.policy_hash,fee:i.fee_fingerprint}),fail);
 const quantity=requestQuantityHundredths(r);
 const parents=rows.filter(parent=>parent.id===i.parent_id);
 const parent=parents[0];
 requireProof(parents.length===1&&parent&&parent.account_id===accountId&&parent.kind==='ENTRY'&&parent.terminal===true&&
  parent.market===i.market&&parent.side===i.side&&typeof parent.exchange_order_id==='string'&&parent.exchange_order_id.length>0&&
  positive(parent.filled_hundredths)&&BigInt(String(parent.filled_hundredths))>=quantity,fail);
 const source=object(d.ownedEvaluation)&&object(d.ownedEvaluation.source)?d.ownedEvaluation.source:null;
 const sourceAt=typeof source?.evaluated_at==='string'?Date.parse(source.evaluated_at):NaN;
 const ttl=object(d.policy)?d.policy.maxQuoteAgeMs:null;
 requireProof(Number.isSafeInteger(sourceAt)&&sourceAt>0&&Number.isSafeInteger(ttl)&&Number(ttl)>=1&&Number(ttl)<=15000&&
  p.sourceAtMs===sourceAt&&p.maxQuoteAgeMs===ttl&&Number.isSafeInteger(p.evidenceObservedAtMs)&&
  Number(p.evidenceObservedAtMs)>sourceAt+Number(ttl)&&positive(p.ownedQuantityHundredths)&&
  // The position may shrink after preparation. The producer proves no send
  // with positive remaining inventory, not coverage of the original request.
  BigInt(String(p.ownedQuantityHundredths))<=BigInt(String(parent.filled_hundredths)),fail);
 const matched=markers.filter(m=>m.client_order_id===i.client_order_id);
 if(p.reservationId===null){requireProof(matched.length===0,fail);return;}
 const marker=matched[0];
 requireProof(typeof p.reservationId==='string'&&p.reservationId.length>0&&matched.length===1&&marker&&
  marker.reservation_id===p.reservationId&&marker.owner_user_id===ownerId&&marker.execution_account_id===accountId&&
  marker.state==='VOID'&&marker.trading_authorized===false&&marker.market_ticker===i.market&&marker.reducing_side===i.side&&
  String(marker.quantity_hundredths)===String(quantity)&&typeof marker.order_request_json==='string',fail);
 const raw=marker.order_request_json as string;
 const expected={ticker:i.market,side:i.side==='YES'?'ask':'bid',count:formatContractHundredths(quantity),
  price:((i.side==='YES'?Number(r.limitMicros):1_000_000-Number(r.limitMicros))/1_000_000).toFixed(4),
  client_order_id:i.client_order_id,time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',
  post_only:false,reduce_only:true,subaccount:1,exchange_index:2};
 requireProof(marker.order_digest===createHash('sha256').update(raw).digest('hex')&&canonical(json(raw))===canonical(expected),fail);
}
