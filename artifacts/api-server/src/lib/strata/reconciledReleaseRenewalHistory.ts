import {canonical,digest,requireProof,type Snapshot} from '../v13-production/types';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {migrationFlatHistoryCheck} from './ownerApiFeePolicyMigration';
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
const fail='owner_renewal_reconciled_history_unverified';
const json=(x:unknown):unknown=>typeof x==='string'?JSON.parse(x):x;
const object=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x);
const unsigned=(x:unknown)=>typeof x==='string'&&/^(0|[1-9]\d*)$/.test(x);
const signed=(x:unknown)=>typeof x==='string'&&/^(0|-?[1-9]\d*)$/.test(x);
/** Narrow retained-history admission: settled whole-contract ENTRYs and
 * authenticated never-posted ENTRY/expired EXIT evidence. Posted EXIT history
 * remains unsupported until its separate position-basis proof is reviewed.
 * This reader never changes history or creates execution authority. */
export async function readReconciledReleaseRenewalHistory(db:Query,account:string,owner:string,lock=false){
 const history=await readNeverPostedReleaseHistory(db,account,lock,{expiredExitOwnerId:owner});
 requireProof(history.rows.length>0,fail);
 const excluded=new Set(history.neverPosted.map(x=>x.intentId));
 for(const i of history.rows){
  requireProof(i.account_id===account&&i.terminal===true&&String(i.reserved_micros)==='0'&&
   (excluded.has(String(i.id))?i.state==='BLOCKED':i.state==='TERMINAL'),fail);
  if(excluded.has(String(i.id)))continue;
  const r=json(i.request),d=json(i.decision);
  requireProof(object(r)&&object(d)&&i.kind==='ENTRY'&&i.parent_id===null&&
   r.clientOrderId===i.client_order_id&&r.clientOrderId===`v13p-${i.id}`&&
   r.market===i.market&&/^KXBTC15M-[A-Za-z0-9-]+$/.test(String(r.market))&&
   r.side===i.side&&['YES','NO'].includes(String(r.side))&&r.action==='BUY'&&r.reduceOnly===false&&r.timeInForce==='IOC'&&
   r.quantityVersion===undefined&&r.quantityHundredths===undefined&&Number.isSafeInteger(r.contracts)&&Number(r.contracts)>0&&Number(r.contracts)<=999999999&&
   Number.isSafeInteger(r.limitMicros)&&Number(r.limitMicros)>=100&&Number(r.limitMicros)<=999900&&Number(r.limitMicros)%100===0&&
   typeof i.exchange_order_id==='string'&&i.exchange_order_id.length>0&&unsigned(i.filled_hundredths)&&
   BigInt(String(i.filled_hundredths))<=BigInt(Number(r.contracts))*100n&&
   i.capability_digest===digest({id:i.id,request:r,decision:d,policyHash:i.policy_hash,fee:i.fee_fingerprint}),fail);
 }
 const suffix=lock?' FOR SHARE':'';
 const posted=history.rows.filter(i=>!excluded.has(String(i.id)));
 const contradictions=posted.length?(await db.query(`SELECT id FROM public.v13_production_observation WHERE account_id=$1
  AND kind='PROVEN_NOT_POSTED' AND payload->>'id'=ANY($2::text[]) LIMIT 1${suffix}`,[account,posted.map(i=>String(i.id))])).rows:[];
 requireProof(contradictions.length===0,fail);
 const events=(await db.query(`SELECT e.*,e.xmin::text AS row_revision FROM public.v13_production_event e WHERE account_id=$1 ORDER BY event_id LIMIT 3001${suffix}`,[account])).rows;
 const positions=(await db.query(`SELECT p.*,p.xmin::text AS row_revision FROM public.v13_production_position p WHERE account_id=$1 ORDER BY id LIMIT 1001${suffix}`,[account])).rows;
 const markers=(await db.query(`SELECT r.*,r.xmin::text AS row_revision FROM private.strata_emergency_exit_reservations r WHERE execution_account_id=$1 ORDER BY reservation_id LIMIT 1001${suffix}`,[account])).rows;
 requireProof(events.length<=3000&&events.every(e=>e.account_id===account)&&positions.length<=1000&&markers.length<=1000,fail);
 const noSendExitClients=new Set(history.rows.filter(i=>i.kind==='EXIT'&&excluded.has(String(i.id))).map(i=>i.client_order_id));
 requireProof(markers.every(r=>r.execution_account_id===account&&r.owner_user_id===owner&&r.state==='VOID'&&r.trading_authorized===false&&noSendExitClients.has(r.client_order_id)),fail);
 requireProof(positions.every(p=>p.account_id===account&&String(p.quantity_hundredths)==='0'&&String(p.basis_micros)==='0'&&signed(p.realized_pnl_micros)&&
  history.rows.some(i=>i.id===p.id&&i.kind==='ENTRY'&&i.market===p.market&&i.side===p.side)),fail);
 requireProof(posted.every(i=>positions.some(p=>p.id===i.id)),fail);
 return {...history,events,positions,markers,reconciliationDigest:digest({history:history.historyDigest,events,positions,markers})};
}
export type ReconciledReleaseHistory=Awaited<ReturnType<typeof readReconciledReleaseRenewalHistory>>;
/** Exact two-way correspondence, not merely exchange flatness or a balance
 * match. Every stored financial event must appear in the fresh signed history. */
export function verifyReconciledReleaseRenewalSnapshot(history:ReconciledReleaseHistory,snapshot:Snapshot){
 const excluded=new Set(history.neverPosted.map(x=>x.clientOrderId));
 requireProof(!snapshot.orders.some(o=>excluded.has(o.request.clientOrderId))&&migrationFlatHistoryCheck(snapshot,history.expectedRequests).ok,fail);
 const clients=new Set(snapshot.orders.map(o=>o.request.clientOrderId));
 requireProof(clients.size===snapshot.orders.length&&new Set(snapshot.orders.map(o=>o.orderId)).size===snapshot.orders.length&&
  history.expectedRequests.every(r=>clients.has(r.clientOrderId)),fail);
 const expected=new Map<string,{kind:string;intentId:string;payload:unknown;cash:bigint;pnl:bigint;at:number}>();
 const basis=new Map<string,bigint>(),filled=new Map<string,bigint>(),realized=new Map<string,bigint>();
 for(const f of snapshot.fills){
  const i=history.rows.find(i=>i.client_order_id===f.clientOrderId);
  const request=i?json(i.request):null;
  requireProof(i&&object(request)&&i.kind==='ENTRY'&&f.orderId===i.exchange_order_id&&f.action==='BUY'&&f.market===i.market&&f.side===i.side&&
   unsigned(f.grossMicros)&&unsigned(f.feeMicros)&&unsigned(f.quantityHundredths)&&BigInt(f.quantityHundredths)>0n&&
   Number.isSafeInteger(f.priceMicros)&&f.priceMicros>0&&f.priceMicros<1000000&&f.priceMicros<=Number(request.limitMicros)&&
   BigInt(f.quantityHundredths)*BigInt(f.priceMicros)%100n===0n&&BigInt(f.grossMicros)===BigInt(f.quantityHundredths)*BigInt(f.priceMicros)/100n&&
   Number.isSafeInteger(f.occurredAtMs)&&f.occurredAtMs<=snapshot.observedAtMs,fail);
  const id=String(i.id),cost=BigInt(f.grossMicros)+BigInt(f.feeMicros),key=`fill:${f.id}`;
  requireProof(!expected.has(key),fail);expected.set(key,{kind:'FILL',intentId:id,payload:f,cash:-cost,pnl:0n,at:f.occurredAtMs});
  basis.set(id,(basis.get(id)??0n)+cost);filled.set(id,(filled.get(id)??0n)+BigInt(f.quantityHundredths));
 }
 const settled=new Set<string>();
 for(const s of snapshot.settlements){
  const parents=history.rows.filter(i=>i.kind==='ENTRY'&&i.state==='TERMINAL'&&i.market===s.market&&i.side===s.side&&BigInt(String(i.filled_hundredths))>0n);
  requireProof(parents.length===1&&unsigned(s.quantityHundredths)&&unsigned(s.payoutMicros)&&unsigned(s.feeMicros)&&
   ['YES','NO'].includes(s.side)&&['YES','NO'].includes(s.result)&&s.feeMicros==='0'&&
   BigInt(s.payoutMicros)===(s.side===s.result?BigInt(s.quantityHundredths)*10000n:0n)&&
   Number.isSafeInteger(s.occurredAtMs)&&s.occurredAtMs<=snapshot.observedAtMs,fail);
  const id=String(parents[0]!.id),key=`settlement:${s.id}`,cash=BigInt(s.payoutMicros)-BigInt(s.feeMicros);
  requireProof(!settled.has(id)&&!expected.has(key)&&BigInt(s.quantityHundredths)===(filled.get(id)??0n)&&BigInt(s.quantityHundredths)>0n,fail);
  requireProof(snapshot.fills.filter(f=>f.clientOrderId===parents[0]!.client_order_id).every(f=>f.occurredAtMs<=s.occurredAtMs),fail);
  settled.add(id);const pnl=cash-(basis.get(id)??0n);realized.set(id,pnl);
  expected.set(key,{kind:'SETTLEMENT',intentId:id,payload:s,cash,pnl,at:s.occurredAtMs});
 }
 for(const i of history.rows)if(i.kind==='ENTRY'&&i.state==='TERMINAL'){
  const qty=BigInt(String(i.filled_hundredths));requireProof(qty===(filled.get(String(i.id))??0n)&&(qty===0n||settled.has(String(i.id))),fail);
 }
 requireProof(history.events.length===expected.size&&new Set(history.events.map(e=>e.event_id)).size===history.events.length,fail);
 for(const e of history.events){const proof=expected.get(String(e.event_id));
  requireProof(proof&&e.kind===proof.kind&&e.intent_id===proof.intentId&&e.digest===digest(proof.payload)&&canonical(json(e.payload))===canonical(proof.payload)&&
   signed(e.cash_delta_micros)&&signed(e.pnl_micros)&&BigInt(String(e.cash_delta_micros))===proof.cash&&BigInt(String(e.pnl_micros))===proof.pnl&&
   (e.occurred_at instanceof Date?e.occurred_at.getTime():Date.parse(String(e.occurred_at)))===proof.at,fail);
 }
 requireProof(new Set(history.positions.map(p=>p.id)).size===history.positions.length,fail);
 for(const p of history.positions)requireProof(BigInt(String(p.realized_pnl_micros))===(realized.get(String(p.id))??0n),fail);
 for(const [id] of realized)requireProof(history.positions.some(p=>p.id===id),fail);
}
