import {createHash} from 'node:crypto';

/** Pure evidence planner. This module has no DB, signer, HTTP, worker, or
 * financial-write dependency. The owner route uses the held-context service.
 * A positive result is a plan for the existing ledger, never evidence that
 * reconciliation committed or authority to release funds/restart execution.
 * Inputs must eventually be collected by an independently reviewed server-only
 * recovery boundary. Client JSON saying `authenticated: true` is NOT evidence.
 */
export const OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION =
 'I_AUTHORIZE_ACCOUNTING_ONLY_RECOVERY_OF_MY_UNKNOWN_ORDER_AND_KEEP_EXECUTION_KILLED';

type Row=Record<string,unknown>;
type Outcome={
 ok:boolean;reason:string;readOnly:true;ordersSubmitted:false;workerStarted:false;
 tradingAuthorized:false;riskFreezeCleared:false;accountingCommitted:false;
 reservationsReleased:false;ledgerValidationStillRequired:true;
 plan?:{
  ownerId:string;accountId:string;targetIntentId:string;targetOrderId:string;
  expectedAccountRevision:string;expectedFencingToken:string;
  holdDigest:string;historyDigest:string;snapshotDigest:string;
  evidenceObservedAtMs:number;expiresAtMs:number;
  targetFilledHundredths:string;
 };
};
const row=(x:unknown):x is Row=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
 (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const uint=(x:unknown):x is string=>typeof x==='string'&&/^(0|[1-9][0-9]{0,29})$/.test(x);
const positive=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
const clock=(x:unknown):x is number=>positive(x)&&x<=8640000000000000-15000;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const identifier=(x:unknown):x is string=>typeof x==='string'&&/^[a-zA-Z0-9:_.-]{1,200}$/.test(x);
function canonical(x:unknown):string{
 if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);
 if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
 if(row(x))return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
 throw Error('non_json_evidence');
}
const hash=(x:unknown)=>createHash('sha256').update(canonical(x)).digest('hex');
/** Stable across JSONB key ordering. Hashes bind evidence, not authority. */
export const ownerUnknownEvidenceDigest=hash;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const result=(reason:string,plan?:Outcome['plan']):Outcome=>({
 ok:plan!==undefined,reason,readOnly:true,ordersSubmitted:false,workerStarted:false,
 tradingAuthorized:false,riskFreezeCleared:false,accountingCommitted:false,
 reservationsReleased:false,ledgerValidationStillRequired:true,...(plan?{plan}:{}),
});
const need=(condition:unknown,reason:string):void=>{if(!condition)throw Error(reason);};
function quantity(request:Row):bigint{
 if(request.action==='BUY'){
  need(positive(request.contracts)&&request.contracts<=1000000&&
   request.quantityVersion===undefined&&request.quantityHundredths===undefined,'invalid_stored_request');
  return BigInt(request.contracts as number)*100n;
 }
 if(request.quantityVersion==='EXIT_HUNDREDTHS_V1'){
  need(request.contracts===undefined&&uint(request.quantityHundredths)&&BigInt(request.quantityHundredths)>0n,
   'invalid_stored_request');
  return BigInt(request.quantityHundredths as string);
 }
 need(positive(request.contracts)&&request.contracts<=1000000&&request.quantityVersion===undefined&&
  request.quantityHundredths===undefined,'invalid_stored_request');
 return BigInt(request.contracts as number)*100n;
}
function validateRequest(request:unknown):asserts request is Row{
 need(row(request),'invalid_stored_request');
 const r=request as Row;
 need(identifier(r.market)&&identifier(r.clientOrderId)&&(r.side==='YES'||r.side==='NO')&&
  (r.action==='BUY'||r.action==='SELL')&&positive(r.limitMicros)&&r.limitMicros<1000000&&
  r.timeInForce==='IOC'&&r.reduceOnly===(r.action==='SELL'),'invalid_stored_request');
 quantity(r);
}

/** Plan only the narrow terminal, exchange-flat UNKNOWN-entry case. In-flight
 * entries, protective reservations, open exposure and transfer activity require
 * their own supported workflows. A stale heartbeat is never a fencing proof.
 * `heldBefore` and `heldAfter` are exact server captures, including xmin-style
 * revision stamps; no caller-selected account or client boolean may supply them.
 */
export function planOwnerUnknownReconciliation(input:unknown):Outcome{
 try{
  need(row(input),'invalid_recovery_input');const x=input as Row;
  need(uuid(x.ownerId)&&x.confirmation===OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,
   'explicit_authenticated_owner_confirmation_required');
  need(clock(x.nowMs),'recovery_clock_invalid');
  need(row(x.heldBefore)&&row(x.heldAfter),'durable_execution_hold_missing');
  const h=x.heldBefore as Row;
  // Equality includes every captured metadata revision. ARM/KILL ABA, key
  // replacement, policy changes and account mutations cannot reuse a plan.
  need(same(h,x.heldAfter),'recovery_hold_changed');
  need(h.ownerId===x.ownerId&&identifier(h.accountId)&&h.subaccount===1&&h.exchangeIndex===2&&
   typeof h.keyFingerprint==='string'&&/^[a-f0-9]{64}$/.test(h.keyFingerprint),
   'recovery_owner_or_account_scope_mismatch');
  need(h.executionEnabled===false&&h.killSwitch===true&&h.leaseState==='killed'&&
   h.armRequested===false&&h.accountKill===true&&h.localWorkerRunning===false,
   'durable_execution_kill_required');
  need(uint(h.accountRevision)&&uint(h.fencingToken)&&uint(h.preKillFencingToken)&&
   BigInt(h.fencingToken)>BigInt(h.preKillFencingToken)&&clock(h.killCommittedAtMs)&&
   h.killCommittedAtMs<=(x.nowMs as number),'durable_kill_fence_unverified');
  need(row(h.revisions)&&['account','lease','credential','policy','financial','provider'].every(k=>
   uint((h.revisions as Row)[k])&&BigInt((h.revisions as Row)[k] as string)>0n),
   'recovery_revision_fences_missing');
  need(h.activeProtectiveReservations==='0'&&h.pendingTransfers==='0',
   'independent_exposure_or_transfer_recovery_required');
  need(uint(h.cashMicros)&&uint(h.reservedMicros)&&BigInt(h.reservedMicros)<=BigInt(h.cashMicros)&&
   (h.blockedReason===null||typeof h.blockedReason==='string'),'ledger_amounts_unverified');
  need(identifier(x.targetIntentId)&&Array.isArray(x.intents)&&x.intents.length>0&&
   Array.isArray(x.finalIntents)&&same(x.intents,x.finalIntents),'financial_history_changed_or_missing');
  const byClient=new Map<string,Row>(),byId=new Map<string,Row>();
  let earliest=x.nowMs as number;
  for(const item of x.intents as unknown[]){
   need(row(item),'invalid_intent_history');const i=item as Row;
   need(identifier(i.id)&&i.accountId===h.accountId&&clock(i.createdAtMs)&&
    i.createdAtMs<=(h.killCommittedAtMs as number)&&typeof i.terminal==='boolean'&&
    ['UNKNOWN','DISPATCHED','TERMINAL','BLOCKED'].includes(String(i.state))&&
    uint(i.reservedMicros)&&uint(i.filledHundredths),'invalid_intent_history');
   validateRequest(i.request);const r=i.request as Row;
   need(!byId.has(i.id as string)&&!byClient.has(r.clientOrderId as string),'duplicate_intent_history');
   need((i.state==='UNKNOWN'||i.state==='DISPATCHED')?i.terminal===false:i.terminal===true,
    'inconsistent_intent_state');
   need(i.kind===(r.action==='BUY'?'ENTRY':'EXIT'),'intent_request_kind_mismatch');
   need(i.kind!=='EXIT'||i.terminal===true,'independent_protective_recovery_required');
   need(i.exchangeOrderId===null||identifier(i.exchangeOrderId),'invalid_intent_history');
   byId.set(i.id as string,i);byClient.set(r.clientOrderId as string,i);
   earliest=Math.min(earliest,i.createdAtMs as number);
  }
  const target=byId.get(x.targetIntentId as string);
  need(target&&target.state==='UNKNOWN'&&target.kind==='ENTRY'&&target.terminal===false,
   'target_unknown_entry_required');
  need(row(x.snapshot),'complete_signed_history_required');const s=x.snapshot as Row;
  need(row(s.identity)&&same(s.identity,{subaccount:1,exchangeIndex:2,keyFingerprint:h.keyFingerprint}),
   'signed_snapshot_scope_mismatch');
  need(s.authenticated===true&&s.complete===true&&s.cashExact===true&&
   s.unexplainedCashActivity===false&&x.historicalCoverageComplete===true,
   'complete_signed_history_required');
  need(clock(s.observedAtMs)&&s.observedAtMs>=(h.killCommittedAtMs as number)&&
   s.observedAtMs<=(x.nowMs as number)&&(x.nowMs as number)-s.observedAtMs<=15000&&
   typeof s.historyFromMs==='number'&&Number.isSafeInteger(s.historyFromMs)&&s.historyFromMs>=0&&
   s.historyFromMs<=earliest,'signed_snapshot_stale_or_history_gap');
  need(uint(s.cashMicros)&&Array.isArray(s.orders)&&Array.isArray(s.fills)&&
   Array.isArray(s.positions)&&Array.isArray(s.settlements),'signed_snapshot_shape_invalid');
  need((s.positions as unknown[]).every(p=>row(p)&&identifier(p.market)&&
   (p.side==='YES'||p.side==='NO')&&p.quantityHundredths==='0'),'exchange_exposure_requires_separate_recovery');
  const orders=new Map<string,Row>(),seenClients=new Set<string>();
  for(const item of s.orders as unknown[]){
   need(row(item),'invalid_order_evidence');const o=item as Row;validateRequest(o.request);
   const r=o.request as Row,i=byClient.get(r.clientOrderId as string);
   need(identifier(o.orderId)&&!orders.has(o.orderId as string)&&!seenClients.has(r.clientOrderId as string),
    'duplicate_order_evidence');
   need(i&&i.state!=='BLOCKED'&&same(r,i.request)&&
    (i.exchangeOrderId===null||i.exchangeOrderId===o.orderId),'unattributed_or_changed_order');
   need(o.terminal===true&&uint(o.filledHundredths)&&BigInt(o.filledHundredths)<=quantity(r),
    'terminal_order_evidence_required');
   orders.set(o.orderId as string,o);seenClients.add(r.clientOrderId as string);
  }
  for(const i of byId.values())if(i.state==='UNKNOWN'||i.state==='DISPATCHED')
   need(seenClients.has((i.request as Row).clientOrderId as string),'unknown_order_absence_is_not_terminal_proof');
  const seenFills=new Set<string>(),totals=new Map<string,bigint>();
  for(const item of s.fills as unknown[]){
   need(row(item),'invalid_fill_evidence');const f=item as Row,o=orders.get(String(f.orderId));
   const r=o?.request as Row|undefined;
   need(identifier(f.id)&&!seenFills.has(f.id as string)&&r&&f.clientOrderId===r.clientOrderId&&
    f.market===r.market&&f.side===r.side&&f.action===r.action,'unattributed_or_duplicate_fill');
   need(uint(f.quantityHundredths)&&BigInt(f.quantityHundredths)>0n&&uint(f.grossMicros)&&
    uint(f.feeMicros)&&positive(f.priceMicros)&&f.priceMicros<1000000&&positive(f.occurredAtMs)&&
    f.occurredAtMs<=(s.observedAtMs as number),'fill_amount_or_time_invalid');
   const q=BigInt(f.quantityHundredths as string),price=BigInt(f.priceMicros as number);
   need(q*price%100n===0n&&q*price/100n===BigInt(f.grossMicros as string)&&
    (r!.action==='BUY'?(f.priceMicros as number)<=(r!.limitMicros as number):
     (f.priceMicros as number)>=(r!.limitMicros as number)),'fill_limit_or_amount_invalid');
   seenFills.add(f.id as string);totals.set(f.orderId as string,(totals.get(f.orderId as string)??0n)+q);
  }
  for(const [id,o] of orders)need((totals.get(id)??0n)===BigInt(o.filledHundredths as string),
   'terminal_fill_totals_incomplete');
  const seenSettlements=new Set<string>();
  for(const item of s.settlements as unknown[]){
   need(row(item),'invalid_settlement_evidence');const p=item as Row;
   need(identifier(p.id)&&!seenSettlements.has(p.id as string)&&identifier(p.market)&&
    (p.side==='YES'||p.side==='NO')&&(p.result==='YES'||p.result==='NO')&&
    uint(p.quantityHundredths)&&BigInt(p.quantityHundredths)>0n&&uint(p.payoutMicros)&&uint(p.feeMicros)&&
    positive(p.occurredAtMs)&&p.occurredAtMs<=(s.observedAtMs as number),'invalid_settlement_evidence');
   need(BigInt(p.payoutMicros as string)===(p.side===p.result?BigInt(p.quantityHundredths as string)*10000n:0n),
    'settlement_payout_invalid');
   seenSettlements.add(p.id as string);
  }
  const targetOrder=[...orders.values()].find(o=>(o.request as Row).clientOrderId===(target!.request as Row).clientOrderId)!;
  // Deliberately do not compare stale ledger cash to the exchange here. The
  // EXISTING ledger must account for exact fills/fees/settlements and prove the
  // resulting cash, positions, immutable event digests and conservation.
  return result('ready_for_locked_ledger_reconciliation',{
   ownerId:x.ownerId as string,accountId:h.accountId as string,targetIntentId:x.targetIntentId as string,
   targetOrderId:targetOrder.orderId as string,expectedAccountRevision:h.accountRevision as string,
   expectedFencingToken:h.fencingToken as string,holdDigest:hash(h),historyDigest:hash(x.intents),
   snapshotDigest:hash(s),evidenceObservedAtMs:s.observedAtMs as number,
   expiresAtMs:(s.observedAtMs as number)+15000,targetFilledHundredths:targetOrder.filledHundredths as string,
  });
 }catch(error){
  const reason=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'recovery_evidence_unreadable';
  return result(reason);
 }
}
