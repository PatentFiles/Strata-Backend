import {createHash} from 'node:crypto';
import {canonical,digest,requireProof} from '../v13-production/types';
import {requestQuantityHundredths,formatContractHundredths} from '../v13-production/requestQuantity';

type Row=Record<string,unknown>;
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const json=(v:unknown):unknown=>typeof v==='string'?JSON.parse(v):v;
const fail='release_local_exit_no_send_evidence_invalid_or_contradictory';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const date=(v:unknown)=>v instanceof Date?v.getTime():Date.parse(String(v));

/** Validates the immutable receipt written by finalizeNeverSent, which can only
 * mint it before raw POST. A dispatched local intent or VOID marker alone proves
 * nothing. This read supplies accounting history, never permission to resend. */
export function validateLocalExitNoSend(i:Row,rows:Row[],observations:Row[],markers:Row[],receipts:Row[],account:string,owner:string){
 const r=json(i.request),d=json(i.decision);
 const ns=receipts.filter(n=>n.client_order_id===i.client_order_id);
 const ms=markers.filter(m=>m.client_order_id===i.client_order_id);
 const n=ns[0],m=ms[0];
 requireProof(object(r)&&object(d)&&ns.length===1&&ms.length===1&&n&&m&&observations.length===0,fail);
 requireProof(i.account_id===account&&i.kind==='EXIT'&&i.state==='BLOCKED'&&i.terminal===true&&
  Number.isSafeInteger(date(i.dispatch_at))&&i.dispatch_at!==null&&i.exchange_order_id===null&&i.cancel_attempted===false&&
  ['filled_hundredths','reserved_micros','exit_fee_micros'].every(k=>String(i[k])==='0')&&
  r.clientOrderId===i.client_order_id&&r.clientOrderId===`v13p-${i.id}`&&r.market===i.market&&
  /^KXBTC15M-[A-Za-z0-9-]+$/.test(String(r.market))&&r.side===i.side&&['YES','NO'].includes(String(r.side))&&
  r.action==='SELL'&&r.reduceOnly===true&&r.timeInForce==='IOC'&&Number.isSafeInteger(r.limitMicros)&&
  Number(r.limitMicros)>=100&&Number(r.limitMicros)<=999900&&Number(r.limitMicros)%100===0&&
  i.capability_digest===digest({id:i.id,request:r,decision:d,policyHash:i.policy_hash,fee:i.fee_fingerprint}),fail);
 const qty=requestQuantityHundredths(r),parents=rows.filter(p=>p.id===i.parent_id),parent=parents[0];
 requireProof(parents.length===1&&parent&&parent.account_id===account&&parent.kind==='ENTRY'&&parent.terminal===true&&
  parent.market===i.market&&parent.side===i.side&&typeof parent.exchange_order_id==='string'&&parent.exchange_order_id.length>0&&
  /^[1-9]\d*$/.test(String(parent.filled_hundredths))&&BigInt(String(parent.filled_hundredths))>=qty,fail);
 requireProof(n.owner_user_id===owner&&n.execution_account_id===account&&n.reservation_id===m.reservation_id&&
  m.owner_user_id===owner&&m.execution_account_id===account&&m.state==='VOID'&&m.trading_authorized===false&&
  n.order_digest===m.order_digest&&n.worker_holder_id===m.worker_holder_id&&
  String(n.worker_fencing_token)===String(m.worker_fencing_token)&&/^[1-9]\d*$/.test(String(n.worker_fencing_token))&&Number.isSafeInteger(Number(n.worker_fencing_token))&&
  typeof n.worker_holder_id==='string'&&n.worker_holder_id.length>0&&
  n.market_ticker===i.market&&m.market_ticker===i.market&&n.reducing_side===i.side&&m.reducing_side===i.side&&
  String(n.quantity_hundredths)===String(qty)&&String(m.quantity_hundredths)===String(qty)&&
  String(n.limit_micros)===String(r.limitMicros)&&/^[a-f0-9]{64}$/.test(String(n.signer_fingerprint))&&
  object(d.identity)&&d.identity.keyFingerprint===n.signer_fingerprint&&Number(d.identity.subaccount)===1&&Number(d.identity.exchangeIndex)===2&&
  ['final_evidence_expired','final_fee_rejected','final_fee_unavailable'].includes(String(n.reason))&&
  Number.isSafeInteger(date(n.recorded_at))&&date(n.recorded_at)>=date(i.dispatch_at)&&typeof m.order_request_json==='string',fail);
 const expected={ticker:i.market,side:i.side==='YES'?'ask':'bid',count:formatContractHundredths(qty),
  price:((i.side==='YES'?Number(r.limitMicros):1_000_000-Number(r.limitMicros))/1_000_000).toFixed(4),
  client_order_id:i.client_order_id,time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',
  post_only:false,reduce_only:true,subaccount:1,exchange_index:2};
 requireProof(hash(m.order_request_json)===m.order_digest&&canonical(json(m.order_request_json))===canonical(expected)&&
  n.evidence_sha256===hash(JSON.stringify({version:1,ownerId:owner,accountId:account,reservationId:n.reservation_id,
   clientOrderId:i.client_order_id,orderDigest:m.order_digest,market:i.market,side:i.side,quantity:String(qty),
   limitMicros:Number(r.limitMicros),signerFingerprint:n.signer_fingerprint,holderId:n.worker_holder_id,
   fencingToken:Number(n.worker_fencing_token),reason:n.reason})),fail);
 return n;
}
