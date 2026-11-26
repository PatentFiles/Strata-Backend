import {pool,type Pool,type PoolClient} from '@workspace/db';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {canonical,digest,requireProof} from '../v13-production/types';
import {transactionConnectionFence} from '../v13-production/transactionConnectionFence';
import {economicSettlementPlan,type EconomicSettlementProof,type EconomicSettlementPlan} from './ownerEconomicSettlementProof';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const no=(reason:string,status='REFUSED')=>({ok:false as const,reason,status,accountingPosted:false as boolean|null,
 ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,transportOutcome:'UNKNOWN' as const,reserveReleased:false,leaseReleased:false});
type Row=Record<string,unknown>;
const json=(v:unknown):Row=>typeof v==='string'?JSON.parse(v):v as Row;
export type EconomicCommitScope={requestId:string;ownerId:string;scopeDigest:string;releaseSha:string;controlEpoch:string;workerFence:string};
type CommitDeps={db?:Pool;now?:()=>number;verifyLocked:(tx:PoolClient,account:Account,plan:EconomicSettlementPlan)=>Promise<void>};

/** Exact-owner readback serializes behind any pending financial COMMIT. It does
 * not retry the writer, import exchange clients, or grant trading authority. */
export async function economicSettlementOutcome(owner:string,requestId:string,db:Pool=pool){
 if(!UUID.test(owner)||!UUID.test(requestId))return no('economic_settlement_exact_owner_request_required');
 let tx:PoolClient|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1200ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
  // Lock the owner's account BEFORE the receipt snapshot; a lost COMMIT may
  // still be executing and must not be misclassified as an absent receipt.
  await tx.query('SELECT id FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 ORDER BY id FOR SHARE',[owner]);
  await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['strata-economic:'+owner+':'+requestId]);
  const rows=(await tx.query(`SELECT r.*,e.digest AS event_digest,e.payload AS event_payload,
   e.cash_delta_micros::text,e.pnl_micros::text,a.revision::text AS current_revision,a.cash_micros::text AS current_cash_micros,
   a.reserved_micros::text AS current_reserved_micros,i.state AS exit_state,i.terminal AS exit_terminal,
   marker.state AS reservation_state,w.arm_requested,w.state AS lease_state
   FROM private.strata_economic_settlement_receipt r
   JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
   JOIN public.v13_production_event e ON e.account_id=a.id AND e.event_id=r.settlement_event_id AND e.intent_id=r.entry_intent_id AND e.kind='SETTLEMENT'
   JOIN public.v13_production_intent i ON i.id=r.exit_intent_id AND i.account_id=a.id
   JOIN private.strata_emergency_exit_reservations marker ON marker.reservation_id=r.reservation_id AND marker.execution_account_id=a.id
   JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
   WHERE r.request_id=$1::uuid AND r.owner_user_id=$2::uuid LIMIT 2`,[requestId,owner])).rows;
  if(rows.length===0){
   const canceled=(await tx.query('SELECT 1 FROM private.strata_economic_settlement_cancel WHERE owner_user_id=$1::uuid AND request_id=$2::uuid',[owner,requestId])).rows.length===1;
   return {...no(canceled?'economic_settlement_request_canceled':'economic_settlement_receipt_not_recorded',canceled?'CANCELED':'NOT_RECORDED'),requestId};
  }
  requireProof(rows.length===1,'economic_settlement_receipt_ambiguous');const r=rows[0]!,p=json(r.payload);
  requireProof(digest(p)===r.payload_digest&&p.ownerId===owner&&p.accountId===r.execution_account_id&&
   p.eventId===r.settlement_event_id&&p.parentId===r.entry_intent_id&&p.exitId===r.exit_intent_id&&p.reservationId===r.reservation_id&&
   p.transportOutcome==='UNKNOWN'&&p.tradingAuthorized===false&&r.transport_outcome==='UNKNOWN'&&r.trading_authorized===false&&
   digest(p.settlement)===r.settlement_digest&&r.event_digest===r.settlement_digest&&canonical(json(r.event_payload))===canonical(p.settlement)&&
   r.cash_delta_micros===p.cashDeltaMicros&&r.pnl_micros===p.pnlMicros&&
   BigInt(String(r.posted_revision))===BigInt(String(r.prior_revision))+1n&&BigInt(String(r.current_revision))>=BigInt(String(r.posted_revision)),
   'economic_settlement_receipt_unverified');
  return {ok:true as const,status:'RECORDED',reason:'economic_settlement_posted_transport_remains_unknown',requestId,
   accountingPosted:true,scopeDigest:String(r.scope_digest),releaseSha:String(r.release_sha),market:(p.settlement as Row).market as string,settlementEventId:String(p.eventId),
   cashDeltaMicros:String(p.cashDeltaMicros),pnlMicros:String(p.pnlMicros),cashAfterPostingMicros:String(p.cashAfterMicros),
   currentCashMicros:String(r.current_cash_micros),currentReservedMicros:String(r.current_reserved_micros),
   transportOutcome:'UNKNOWN' as const,exitTransportStillUnknown:r.reservation_state==='UNKNOWN'&&['DISPATCHED','UNKNOWN'].includes(r.exit_state)&&r.exit_terminal===false,
   accountDisarmed:r.arm_requested===false,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,reserveReleased:false,leaseReleased:false};
 }catch{return {...no('economic_settlement_readback_unverified','UNKNOWN'),requestId,accountingPosted:null,outcomeUnknown:true};}
 finally{if(tx){let discard=false;try{await tx.query('ROLLBACK');}catch{discard=true;}try{tx.release(discard?new Error('economic_settlement_readback_connection_discarded'):undefined);}catch{}}}
}

/** Canonical event + exact position/cash update + immutable economic receipt are
 * one account-first transaction. No intent, lease, reserve, authorization, kill,
 * worker, or strategy row is changed. A missing POST receipt never becomes a
 * fake terminal order; ambiguous COMMITs require outcome readback, never retry. */
export async function commitEconomicSettlement(proof:EconomicSettlementProof,scope:EconomicCommitScope,deps:CommitDeps){
 if(!UUID.test(scope.requestId)||!UUID.test(scope.ownerId)||!HASH.test(scope.scopeDigest)||!/^[a-f0-9]{40}$/.test(scope.releaseSha)||
  !/^(0|[1-9]\d*)$/.test(scope.controlEpoch)||!/^(0|[1-9]\d*)$/.test(scope.workerFence))return no('economic_settlement_scope_invalid');
 const plan=economicSettlementPlan(proof),db=deps.db??pool,now=deps.now??Date.now;
 requireProof(plan.ownerId===scope.ownerId,'economic_settlement_owner_changed');
 let tx:PoolClient|undefined,committing=false,committed=false,discard=false;let fence:ReturnType<typeof transactionConnectionFence>|undefined;
 try{
  tx=await db.connect();fence=transactionConnectionFence(tx);await tx.query('BEGIN');
  await tx.query("SET LOCAL lock_timeout='750ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
  const rows=(await tx.query<Account>('SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[plan.accountId,scope.ownerId])).rows;
  requireProof(rows.length===1,'economic_settlement_account_missing');const a=rows[0]!;
  requireProof(String(a.revision)===plan.expectedRevision&&String((a as unknown as Row).owner_control_epoch)===scope.controlEpoch&&
   String(a.cash_micros)===plan.cashBeforeMicros&&String(a.reserved_micros)===plan.reservedMicros,
   'economic_settlement_account_changed');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['strata-economic:'+scope.ownerId+':'+scope.requestId]);
  // Cancellation takes the same owner-account lock before writing a durable
  // tombstone. It also defeats a delayed POST that has not begun its transaction.
  requireProof((await tx.query('SELECT 1 FROM private.strata_economic_settlement_cancel WHERE owner_user_id=$1::uuid AND request_id=$2::uuid',
   [scope.ownerId,scope.requestId])).rows.length===0,'economic_settlement_request_canceled');
  await deps.verifyLocked(tx,a,plan);
  const validClock=()=>{const current=now();requireProof(Number.isSafeInteger(current)&&current>=plan.observedAtMs&&current-plan.observedAtMs<=5000,'economic_settlement_evidence_expired');fence!.assertLive();};
  validClock();const ledger=new ProductionLedger(db,plan.accountId);await ledger.assertConservation(tx,a);
  const s=plan.settlement;
  await tx.query(`INSERT INTO public.v13_production_event(account_id,event_id,intent_id,kind,digest,payload,cash_delta_micros,pnl_micros,occurred_at)
   VALUES($1,$2,$3,'SETTLEMENT',$4,$5::jsonb,$6,$7,$8)`,
  [plan.accountId,plan.eventId,plan.parentId,digest(s),JSON.stringify(s),plan.cashDeltaMicros,plan.pnlMicros,new Date(s.occurredAtMs)]);
  const position=await tx.query(`UPDATE public.v13_production_position SET quantity_hundredths=0,basis_micros=0,
   realized_pnl_micros=realized_pnl_micros+$4 WHERE id=$1 AND account_id=$2 AND quantity_hundredths=$3
    AND basis_micros=$5 RETURNING id`,[plan.parentId,plan.accountId,s.quantityHundredths,plan.pnlMicros,String(BigInt(plan.cashDeltaMicros)-BigInt(plan.pnlMicros))]);
  requireProof(position.rows.length===1,'economic_settlement_position_changed');
  const update=await tx.query(`UPDATE public.v13_production_account SET cash_micros=$4,revision=revision+1
   WHERE id=$1 AND owner_user_id=$2::uuid AND revision=$3 AND owner_control_epoch=$5 RETURNING revision::text`,
  [plan.accountId,scope.ownerId,plan.expectedRevision,plan.cashAfterMicros,scope.controlEpoch]);
  requireProof(update.rows.length===1,'economic_settlement_revision_changed');
  await ledger.assertConservation(tx,{...a,cash_micros:plan.cashAfterMicros});
  await tx.query(`INSERT INTO private.strata_economic_settlement_receipt(request_id,owner_user_id,execution_account_id,entry_intent_id,exit_intent_id,reservation_id,
   settlement_event_id,settlement_digest,scope_digest,release_sha,prior_revision,posted_revision,control_epoch,worker_fencing_token,payload,payload_digest)
   VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`,
  [scope.requestId,scope.ownerId,plan.accountId,plan.parentId,plan.exitId,plan.reservationId,plan.eventId,digest(s),scope.scopeDigest,scope.releaseSha,
   plan.expectedRevision,update.rows[0]!.revision,scope.controlEpoch,scope.workerFence,JSON.stringify(plan),digest(plan)]);
  await ledger.observe(tx,'OWNER_ECONOMIC_SETTLEMENT_POSTED',{requestId:scope.requestId,owner:scope.ownerId,accountId:plan.accountId,
   settlementEventId:plan.eventId,receiptDigest:digest(plan),transportOutcome:'UNKNOWN',reserveReleased:false,leaseReleased:false,tradingAuthorized:false});
  validClock();committing=true;await tx.query('COMMIT');committed=true;
 }catch(error){
  if(committing){discard=true;return {...no('economic_settlement_commit_outcome_unverified','UNKNOWN'),requestId:scope.requestId,accountingPosted:null,outcomeUnknown:true};}
  const reason=error instanceof Error&&/^economic_settlement_[a-z_]+$/.test(error.message)?error.message:'economic_settlement_transaction_refused';
  return {...no(reason),requestId:scope.requestId};
 }finally{
  if(tx){
   if(!committed&&!committing)try{await tx.query('ROLLBACK');}catch{discard=true;}
   fence?.close();discard=discard||(fence?.broken()??false);
   try{tx.release(discard?new Error('economic_settlement_connection_discarded'):undefined);}catch{discard=true;}
   finally{fence?.cleanup(discard);}
  }
 }
 return economicSettlementOutcome(scope.ownerId,scope.requestId,db);
}
/** Cancel only this owner request, not a worker/order. Account-first locking
 * serializes against a pending COMMIT; the immutable tombstone fences even a
 * delayed, not-yet-started POST. A recorded settlement can never be canceled. */
export async function cancelEconomicSettlement(owner:string,requestId:string,db:Pool=pool){
 if(!UUID.test(owner)||!UUID.test(requestId))return no('economic_settlement_exact_owner_request_required');
 let tx:PoolClient|undefined,committing=false,committed=false,discard=false;
 try{
  tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1200ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
  await tx.query('SELECT id FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 ORDER BY id FOR UPDATE',[owner]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['strata-economic:'+owner+':'+requestId]);
  const recorded=(await tx.query('SELECT 1 FROM private.strata_economic_settlement_receipt WHERE owner_user_id=$1::uuid AND request_id=$2::uuid',[owner,requestId])).rows.length;
  if(!recorded)await tx.query('INSERT INTO private.strata_economic_settlement_cancel(owner_user_id,request_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING',[owner,requestId]);
  committing=true;await tx.query('COMMIT');committed=true;
 }catch{discard=committing;return {...no('economic_settlement_cancel_outcome_unverified','UNKNOWN'),requestId,accountingPosted:null,outcomeUnknown:true};}
 finally{if(tx){if(!committing)try{await tx.query('ROLLBACK');}catch{discard=true;}try{tx.release(discard?new Error('economic_settlement_cancel_discarded'):undefined);}catch{}}}
 if(!committed)return {...no('economic_settlement_cancel_unverified','UNKNOWN'),requestId};
 return economicSettlementOutcome(owner,requestId,db);
}
