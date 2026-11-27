import {orderedOwnerReads,readEconomicHistoryBatch} from './economicRecoveryReadBatch';
import {assertNoEconomicExitContradiction} from './economicExitDischargeScope';
import {createHash} from 'node:crypto';
import {canonical,digest,requireProof,type Snapshot} from '../v13-production/types';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {migrationFlatHistoryCheck} from './ownerApiFeePolicyMigration';
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
const fail='owner_renewal_reconciled_history_unverified';
const json=(x:unknown):unknown=>typeof x==='string'?JSON.parse(x):x;
const object=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x);
const unsigned=(x:unknown)=>typeof x==='string'&&/^(0|[1-9]\d*)$/.test(x);
const signedFp=(x:unknown):bigint|null=>{if(typeof x!=='string'||!/^(-?)(0|[1-9]\d{0,8})\.\d{2}$/.test(x))return null;const negative=x.startsWith('-'),v=x.replace('-','').split('.');const n=BigInt(v[0]!)*100n+BigInt(v[1]!);return negative?-n:n;};
const signed=(x:unknown)=>typeof x==='string'&&/^(0|-?[1-9]\d*)$/.test(x);
/** Narrow retained-history admission: settled whole-contract ENTRYs and
 * authenticated never-posted ENTRY/expired EXIT evidence, and exactly
 * reconciled posted EXITs. Modern protective records, when present, must pair
 * exactly; absent historical records confer accounting evidence, not authority.
 * This reader never changes history or creates execution authority. */
export async function readReconciledReleaseRenewalHistory(db:Query,account:string,owner:string,lock=false,batchLockedDischargeEvidence=false){
 if(lock){
  // Same finalizer transaction only. Parent FOR UPDATE fences absent child INSERTs.
  const parent=await orderedOwnerReads(db,batchLockedDischargeEvidence,[['SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[account,owner]],[`SELECT c.conrelid::pg_catalog.regclass::pg_catalog.text AS relation FROM pg_catalog.pg_constraint c
   WHERE c.conrelid IN ('private.strata_emergency_exit_reservations'::pg_catalog.regclass,'private.strata_protective_exit_reconciliations'::pg_catalog.regclass)
   AND c.confrelid='public.v13_production_account'::pg_catalog.regclass AND c.contype='f' AND c.convalidated AND NOT c.condeferrable
   AND (SELECT pg_catalog.array_agg(a.attname::pg_catalog.text ORDER BY k.n) FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,n) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=ARRAY['execution_account_id']
   AND (SELECT pg_catalog.array_agg(a.attname::pg_catalog.text ORDER BY k.n) FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(num,n) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num)=ARRAY['id']
   AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgisinternal AND t.tgenabled IN ('O','A'))=4
   AND pg_catalog.current_setting('session_replication_role')='origin'`,[]]]);
  requireProof((await parent(0)).rows.length===1,fail);
  const fks=await parent(1);
  requireProof(fks.rows.length===2&&new Set(fks.rows.map(x=>x.relation)).size===2,fail);
 }
 const history=await readNeverPostedReleaseHistory(db,account,lock,{expiredExitOwnerId:owner,batchDischargeEvidence:batchLockedDischargeEvidence});
 requireProof(history.rows.length>0,fail);
 const economic=history.economicDischarges??[];
 const discharged=new Map(economic.map(d=>[String(d.exit_intent_id),d]));
 const excluded=new Set(history.neverPosted.map(x=>x.intentId));
 for(const i of history.rows){
  const settled=discharged.get(String(i.id));
  if(settled){
   const r=json(i.request),d=json(i.decision);
   requireProof(i.account_id===account&&i.kind==='EXIT'&&i.terminal===false&&['DISPATCHED','UNKNOWN'].includes(String(i.state))&&
    String(i.reserved_micros)==='0'&&String(i.filled_hundredths)==='0'&&i.exchange_order_id===null&&object(r)&&object(d)&&
    canonical(r)===canonical(settled.exit_request)&&i.capability_digest===digest({id:i.id,request:r,decision:d,policyHash:i.policy_hash,fee:i.fee_fingerprint}),fail);
   continue;
  }
  requireProof(i.account_id===account&&i.terminal===true&&String(i.reserved_micros)==='0'&&
   (excluded.has(String(i.id))?i.state==='BLOCKED':i.state==='TERMINAL'),fail);
  if(excluded.has(String(i.id)))continue;
  const r=json(i.request),d=json(i.decision);
  requireProof(object(r)&&object(d)&&['ENTRY','EXIT'].includes(String(i.kind))&&
   r.clientOrderId===i.client_order_id&&r.clientOrderId===`v13p-${i.id}`&&
   r.market===i.market&&/^KXBTC15M-[A-Za-z0-9-]+$/.test(String(r.market))&&
   r.side===i.side&&['YES','NO'].includes(String(r.side))&&r.timeInForce==='IOC'&&
   (i.kind==='ENTRY'?i.parent_id===null&&r.action==='BUY'&&r.reduceOnly===false&&r.quantityVersion===undefined&&r.quantityHundredths===undefined&&Number.isSafeInteger(r.contracts)&&Number(r.contracts)>0&&Number(r.contracts)<=999999999:
    typeof i.parent_id==='string'&&r.action==='SELL'&&r.reduceOnly===true&&history.rows.some(parent=>parent.id===i.parent_id&&parent.kind==='ENTRY'&&parent.market===i.market&&parent.side===i.side)&&
    (r.quantityVersion==='EXIT_HUNDREDTHS_V1'?r.contracts===undefined&&unsigned(r.quantityHundredths)&&BigInt(String(r.quantityHundredths))>0n&&BigInt(String(r.quantityHundredths))<=99999999900n:r.quantityVersion===undefined&&r.quantityHundredths===undefined&&Number.isSafeInteger(r.contracts)&&Number(r.contracts)>0&&Number(r.contracts)<=999999999))&&
   Number.isSafeInteger(r.limitMicros)&&Number(r.limitMicros)>=100&&Number(r.limitMicros)<=999900&&Number(r.limitMicros)%100===0&&
   typeof i.exchange_order_id==='string'&&i.exchange_order_id.length>0&&unsigned(i.filled_hundredths)&&
   BigInt(String(i.filled_hundredths))<=(r.quantityVersion==='EXIT_HUNDREDTHS_V1'?BigInt(String(r.quantityHundredths)):BigInt(Number(r.contracts))*100n)&&
   i.capability_digest===digest({id:i.id,request:r,decision:d,policyHash:i.policy_hash,fee:i.fee_fingerprint}),fail);
 }
 const suffix=lock?' FOR SHARE':'';
 const posted=history.rows.filter(i=>!excluded.has(String(i.id))&&!discharged.has(String(i.id)));
 const contradictions=posted.length?(await db.query(`SELECT id FROM public.v13_production_observation WHERE account_id=$1
  AND kind='PROVEN_NOT_POSTED' AND payload->>'id'=ANY($2::text[]) LIMIT 1${suffix}`,[account,posted.map(i=>String(i.id))])).rows:[];
 requireProof(contradictions.length===0,fail);
 // The ordered batch acquires the same event, position, marker and receipt
 // SHARE locks. Its native-type projection keeps the original digest stable.
 const batch=lock&&batchLockedDischargeEvidence&&economic.length
  ?await readEconomicHistoryBatch(db,account,true):null;
 const events=batch?.events??(await db.query(`SELECT e.*,e.xmin::text AS row_revision FROM public.v13_production_event e WHERE account_id=$1 ORDER BY event_id LIMIT 3001${suffix}`,[account])).rows;
 const positions=batch?.positions??(await db.query(`SELECT p.*,p.xmin::text AS row_revision FROM public.v13_production_position p WHERE account_id=$1 ORDER BY id LIMIT 1001${suffix}`,[account])).rows;
 const markers=batch?.markers??(await db.query(`SELECT r.*,r.xmin::text AS row_revision FROM private.strata_emergency_exit_reservations r WHERE execution_account_id=$1 ORDER BY reservation_id LIMIT 1001${suffix}`,[account])).rows;
 requireProof(events.length<=3000&&events.every(e=>e.account_id===account)&&positions.length<=1000&&markers.length<=1000,fail);
 const noSendExitClients=new Set(history.rows.filter(i=>i.kind==='EXIT'&&excluded.has(String(i.id))).map(i=>i.client_order_id));
 const receipts=batch?.receipts??(await db.query(`SELECT x.*,x.xmin::text AS row_revision FROM private.strata_protective_exit_reconciliations x WHERE execution_account_id=$1 ORDER BY reservation_id LIMIT 1001${suffix}`,[account])).rows;
 requireProof(receipts.length<=1000&&new Set(markers.map(m=>m.client_order_id)).size===markers.length,fail);
 const postedExits=posted.filter(i=>i.kind==='EXIT');
 const accountingOnlyExitClients:string[]=[];
 requireProof(markers.every(m=>m.execution_account_id===account&&m.owner_user_id===owner&&m.trading_authorized===false&&
  (m.state==='UNKNOWN'?economic.some(d=>d.reservation_id===m.reservation_id&&d.client_order_id===m.client_order_id):
   m.state==='VOID'?noSendExitClients.has(m.client_order_id):m.state==='RECONCILED'&&postedExits.some(i=>i.client_order_id===m.client_order_id))),fail);
 for(const i of postedExits){
  const ms=markers.filter(m=>m.client_order_id===i.client_order_id),rs=receipts.filter(x=>x.client_order_id===i.client_order_id);
  // Absence of BOTH modern records is not evidence of historical authorization.
  // It may still be acknowledged by exact terminal signed financial reconciliation below.
  if(ms.length===0&&rs.length===0){accountingOnlyExitClients.push(String(i.client_order_id));continue;}
  requireProof(ms.length===1&&rs.length===1,fail);const m=ms[0]!,x=rs[0]!,r=json(i.request) as Row,o=json(m.order_request_json);
  const initial=signedFp(m.initial_position_fp),observed=signedFp(x.observed_position_fp);
  requireProof(initial!==null&&observed!==null&&(i.side==='YES'?initial>0n:initial<0n)&&observed===(i.side==='YES'?initial-BigInt(String(i.filled_hundredths)):initial+BigInt(String(i.filled_hundredths))),fail);
  const qty=r.quantityVersion==='EXIT_HUNDREDTHS_V1'?BigInt(String(r.quantityHundredths)):BigInt(Number(r.contracts))*100n;
  requireProof(qty<=(initial!<0n?-initial!:initial!)&&m.state==='RECONCILED'&&m.market_ticker===i.market&&m.reducing_side===i.side&&String(m.quantity_hundredths)===String(qty)&&
   x.reservation_id===m.reservation_id&&x.owner_user_id===owner&&x.execution_account_id===account&&x.market_ticker===i.market&&/^[a-f0-9]{64}$/.test(String(x.evidence_sha256))&&
   unsigned(String(x.filled_hundredths))&&unsigned(String(x.remaining_hundredths))&&String(x.filled_hundredths)===String(i.filled_hundredths)&&BigInt(String(x.filled_hundredths))+BigInt(String(x.remaining_hundredths))===qty&&
   object(o)&&typeof m.order_request_json==='string'&&createHash('sha256').update(m.order_request_json).digest('hex')===m.order_digest&&o.client_order_id===i.client_order_id&&o.ticker===i.market&&
   o.side===(i.side==='YES'?'ask':'bid')&&o.count===`${qty/100n}.${String(qty%100n).padStart(2,'0')}`&&
   typeof o.price==='string'&&/^0\.\d{4}$/.test(o.price)&&BigInt(o.price.slice(2))*100n===BigInt(i.side==='YES'?Number(r.limitMicros):1000000-Number(r.limitMicros))&&
   o.self_trade_prevention_type==='taker_at_cross'&&o.reduce_only===true&&o.post_only===false&&o.time_in_force==='immediate_or_cancel'&&o.subaccount===1&&o.exchange_index===2,fail);
 }
 requireProof(receipts.every(x=>postedExits.some(i=>i.client_order_id===x.client_order_id)),fail);
 requireProof(positions.every(p=>p.account_id===account&&String(p.quantity_hundredths)==='0'&&String(p.basis_micros)==='0'&&signed(p.realized_pnl_micros)&&
  history.rows.some(i=>i.id===p.id&&i.kind==='ENTRY'&&i.market===p.market&&i.side===p.side)),fail);
 requireProof(posted.filter(i=>i.kind==='ENTRY').every(i=>positions.some(p=>p.id===i.id)),fail);
 return {...history,events,positions,markers,receipts,accountingOnlyExitClients,reconciliationDigest:digest({history:history.historyDigest,events,positions,markers,receipts,accountingOnlyExitClients})};
}
export type ReconciledReleaseHistory=Awaited<ReturnType<typeof readReconciledReleaseRenewalHistory>>;
/** Exact two-way correspondence, not merely exchange flatness or a balance
 * match. Every stored financial event must appear in the fresh signed history. */
export function verifyReconciledReleaseRenewalSnapshot(history:ReconciledReleaseHistory,snapshot:Snapshot){
 assertNoEconomicExitContradiction(history.economicDischarges??[],snapshot);
 const excluded=new Set(history.neverPosted.map(x=>x.clientOrderId));
 requireProof(!snapshot.orders.some(o=>excluded.has(o.request.clientOrderId))&&migrationFlatHistoryCheck(snapshot,history.expectedRequests).ok,fail);
 const clients=new Set(snapshot.orders.map(o=>o.request.clientOrderId));
 requireProof(clients.size===snapshot.orders.length&&new Set(snapshot.orders.map(o=>o.orderId)).size===snapshot.orders.length&&
  history.expectedRequests.every(r=>clients.has(r.clientOrderId)),fail);
 // Bind each reservation baseline to signed inventory at its actual capture time.
 // Equal provider timestamps are ambiguous; never invent ordering against a position read.
 for(const marker of history.markers.filter(m=>m.state==='RECONCILED')){
  const exit=history.rows.find(i=>i.kind==='EXIT'&&i.client_order_id===marker.client_order_id);
  requireProof(exit,fail);const at=Number(marker.position_observed_at_ms),initial=signedFp(marker.initial_position_fp);
  requireProof(Number.isSafeInteger(at)&&at>=0&&at<=snapshot.observedAtMs&&initial!==null,fail);
  const related=snapshot.fills.filter(f=>history.rows.some(i=>(i.id===exit.parent_id||i.parent_id===exit.parent_id)&&i.client_order_id===f.clientOrderId));
  const settlements=snapshot.settlements.filter(x=>x.market===exit.market&&x.side===exit.side);
  requireProof(related.every(f=>f.occurredAtMs!==at)&&settlements.every(x=>x.occurredAtMs!==at)&&
   snapshot.fills.filter(f=>f.clientOrderId===exit.client_order_id).every(f=>f.occurredAtMs>at),fail);
  let qty=0n;for(const f of related.filter(f=>f.occurredAtMs<at)){requireProof(unsigned(f.quantityHundredths),fail);qty+=(f.action==='BUY'?1n:-1n)*BigInt(f.quantityHundredths);}
  // Settlements for this market/side before the capture must have a uniquely attributable parent.
  for(const x of settlements.filter(x=>x.occurredAtMs<at)){requireProof(history.rows.filter(i=>i.kind==='ENTRY'&&i.market===x.market&&i.side===x.side).length===1&&unsigned(x.quantityHundredths),fail);qty-=BigInt(x.quantityHundredths);}
  requireProof(qty>0n&&qty===(initial!<0n?-initial!:initial!),fail);
 }
 const expected=new Map<string,{kind:string;intentId:string;payload:unknown;cash:bigint;pnl:bigint;at:number}>();
 const basis=new Map<string,bigint>(),filled=new Map<string,bigint>(),realized=new Map<string,bigint>(),remaining=new Map<string,bigint>();
 for(const f of snapshot.fills.slice().sort((a,b)=>a.occurredAtMs-b.occurredAtMs||a.id.localeCompare(b.id))){
  const i=history.rows.find(i=>i.client_order_id===f.clientOrderId);
  const request=i?json(i.request):null;
  requireProof(i&&object(request)&&['ENTRY','EXIT'].includes(String(i.kind))&&f.orderId===i.exchange_order_id&&f.action===(i.kind==='ENTRY'?'BUY':'SELL')&&f.market===i.market&&f.side===i.side&&
   unsigned(f.grossMicros)&&unsigned(f.feeMicros)&&unsigned(f.quantityHundredths)&&BigInt(f.quantityHundredths)>0n&&
   Number.isSafeInteger(f.priceMicros)&&f.priceMicros>0&&f.priceMicros<1000000&&(i.kind==='ENTRY'?f.priceMicros<=Number(request.limitMicros):f.priceMicros>=Number(request.limitMicros))&&
   BigInt(f.quantityHundredths)*BigInt(f.priceMicros)%100n===0n&&BigInt(f.grossMicros)===BigInt(f.quantityHundredths)*BigInt(f.priceMicros)/100n&&
   Number.isSafeInteger(f.occurredAtMs)&&f.occurredAtMs<=snapshot.observedAtMs,fail);
  const id=String(i.id),parent=i.kind==='ENTRY'?id:String(i.parent_id),qty=BigInt(f.quantityHundredths),gross=BigInt(f.grossMicros),fee=BigInt(f.feeMicros),key=`fill:${f.id}`;
  let cash:bigint,pnl=0n;
  if(i.kind==='ENTRY'){cash=-(gross+fee);basis.set(parent,(basis.get(parent)??0n)+gross+fee);remaining.set(parent,(remaining.get(parent)??0n)+qty);}
  else {const available=remaining.get(parent)??0n;requireProof(available>=qty&&available>0n,fail);const removed=(basis.get(parent)??0n)*qty/available;cash=gross-fee;pnl=cash-removed;basis.set(parent,(basis.get(parent)??0n)-removed);remaining.set(parent,available-qty);realized.set(parent,(realized.get(parent)??0n)+pnl);}
  requireProof(!expected.has(key),fail);expected.set(key,{kind:'FILL',intentId:id,payload:f,cash,pnl,at:f.occurredAtMs});
  filled.set(id,(filled.get(id)??0n)+qty);
 }
 const settled=new Set<string>();
 for(const s of snapshot.settlements){
  const parents=history.rows.filter(i=>i.kind==='ENTRY'&&i.state==='TERMINAL'&&i.market===s.market&&i.side===s.side&&(remaining.get(String(i.id))??0n)>0n);
  requireProof(parents.length===1&&unsigned(s.quantityHundredths)&&unsigned(s.payoutMicros)&&unsigned(s.feeMicros)&&
   ['YES','NO'].includes(s.side)&&['YES','NO'].includes(s.result)&&s.feeMicros==='0'&&
   BigInt(s.payoutMicros)===(s.side===s.result?BigInt(s.quantityHundredths)*10000n:0n)&&
   Number.isSafeInteger(s.occurredAtMs)&&s.occurredAtMs<=snapshot.observedAtMs,fail);
  const id=String(parents[0]!.id),key=`settlement:${s.id}`,cash=BigInt(s.payoutMicros)-BigInt(s.feeMicros);
  requireProof(!settled.has(id)&&!expected.has(key)&&BigInt(s.quantityHundredths)===(remaining.get(id)??0n)&&BigInt(s.quantityHundredths)>0n,fail);
  requireProof(snapshot.fills.filter(f=>history.rows.some(i=>(i.id===id||i.parent_id===id)&&i.client_order_id===f.clientOrderId)).every(f=>f.occurredAtMs<=s.occurredAtMs),fail);
  settled.add(id);const pnl=cash-(basis.get(id)??0n);realized.set(id,(realized.get(id)??0n)+pnl);remaining.set(id,0n);basis.set(id,0n);
  expected.set(key,{kind:'SETTLEMENT',intentId:id,payload:s,cash,pnl,at:s.occurredAtMs});
 }
 for(const i of history.rows)if(i.state==='TERMINAL'){
  const id=String(i.id);requireProof(BigInt(String(i.filled_hundredths))===(filled.get(id)??0n),fail);
  if(i.kind==='ENTRY')requireProof((remaining.get(id)??0n)===0n&&(basis.get(id)??0n)===0n,fail);
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
