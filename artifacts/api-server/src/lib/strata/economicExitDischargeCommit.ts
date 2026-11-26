import {pool,type Pool,type PoolClient} from '@workspace/db';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {canonical,digest,requireProof} from '../v13-production/types';
import {transactionConnectionFence} from '../v13-production/transactionConnectionFence';
import {economicDischargePlan,type EconomicDischargeProof,type EconomicDischargePlan} from './economicExitDischargeEvidence';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;type Row=Record<string,unknown>;
export const dischargeNo=(reason:string,status='REFUSED')=>({ok:false as const,status,reason,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,
 transportOutcome:'UNKNOWN' as const,reserveReleased:false as boolean|null,leaseReleased:false as boolean|null});
export type DischargeScope={ownerId:string;requestId:string;scopeDigest:string;releaseSha:string;controlEpoch:string;workerFence:string};
type Deps={db?:Pool;now?:()=>number;verifyLocked:(tx:PoolClient,a:Account,p:EconomicDischargePlan)=>Promise<void>};
/** Read-only durable outcome. The account lock serializes behind a COMMIT whose
 * acknowledgement was lost. Absence is never authority to replay the writer. */
export async function economicDischargeOutcome(owner:string,id:string,db:Pool=pool){
 if(!UUID.test(owner)||!UUID.test(id))return dischargeNo('economic_discharge_exact_owner_request_required');
 let tx:PoolClient|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1200ms'; SET LOCAL statement_timeout='4000ms'");
  await tx.query('SELECT id FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 ORDER BY id FOR SHARE',[owner]);
  await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['economic-discharge:'+owner+':'+id]);
  const rows=(await tx.query(`SELECT d.*,a.revision::text AS current_revision,a.cash_micros::text AS current_cash,
   a.reserved_micros::text AS current_reserved,a.execution_enabled,a.kill_switch,w.state AS current_lease,w.arm_requested,
   private.strata_has_economic_exit_discharge(d.execution_account_id,d.client_order_id) AS verified
   FROM private.strata_economic_exit_discharge d JOIN public.v13_production_account a ON a.id=d.execution_account_id AND a.owner_user_id=d.owner_user_id
   JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
   WHERE d.request_id=$1::uuid AND d.owner_user_id=$2::uuid LIMIT 2`,[id,owner])).rows;
  if(!rows.length){const canceled=(await tx.query('SELECT 1 FROM private.strata_economic_exit_discharge_cancel WHERE owner_user_id=$1::uuid AND request_id=$2::uuid',[owner,id])).rows.length===1;
   return {...dischargeNo(canceled?'economic_discharge_request_canceled':'economic_discharge_not_recorded',canceled?'CANCELED':'NOT_RECORDED'),requestId:id};}
  requireProof(rows.length===1,'economic_discharge_receipt_ambiguous');const r=rows[0]!,p=(typeof r.payload==='string'?JSON.parse(r.payload):r.payload) as Row;
  requireProof(r.verified===true&&digest(p)===r.payload_digest&&p.ownerId===owner&&p.accountId===r.execution_account_id&&p.exitId===r.exit_intent_id&&
   p.bookingRequestId===r.booking_request_id&&p.bookingDigest===r.booking_digest&&p.releaseReserveMicros===String(r.released_reserve_micros)&&
   p.transportOutcome==='UNKNOWN'&&p.tradingAuthorized===false&&canonical(p.exitRequest)===canonical(r.exit_request)&&
   BigInt(String(r.current_revision))>=BigInt(String(r.posted_revision)),'economic_discharge_receipt_unverified');
  return {ok:true as const,status:'RECORDED',reason:'economic_discharge_recorded_transport_remains_unknown',requestId:id,
   scopeDigest:String(r.scope_digest),releaseSha:String(r.release_sha),market:(p.settlement as Row).market,
   reserveReleased:true,leaseReleased:true,releasedReserveMicros:String(r.released_reserve_micros),cashMicros:String(r.current_cash),reservedMicros:String(r.current_reserved),
   accountStopped:r.execution_enabled===false&&r.kill_switch===true&&r.arm_requested===false&&['released','killed'].includes(String(r.current_lease)),
   transportOutcome:'UNKNOWN' as const,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false};
 }catch{return {...dischargeNo('economic_discharge_outcome_unverified','UNKNOWN'),requestId:id,outcomeUnknown:true,reserveReleased:null,leaseReleased:null};}
 finally{if(tx){let discard=false;try{await tx.query('ROLLBACK');}catch{discard=true;}try{tx.release(discard?new Error('economic_discharge_read_connection_discarded'):undefined);}catch{}}}
}
/** Only the modeled reserve and stopped worker fence change. No cash, P&L,
 * funding, policy, fee authority, intent transport or exchange state is written.
 * Everything commits together, including the immutable discharge receipt. */
export async function commitEconomicDischarge(proof:EconomicDischargeProof,scope:DischargeScope,deps:Deps){
 if(!UUID.test(scope.ownerId)||!UUID.test(scope.requestId)||!HASH.test(scope.scopeDigest)||!/^[a-f0-9]{40}$/.test(scope.releaseSha)||
  !/^(0|[1-9]\d*)$/.test(scope.controlEpoch)||!/^(0|[1-9]\d*)$/.test(scope.workerFence))return dischargeNo('economic_discharge_scope_invalid');
 const plan=economicDischargePlan(proof),db=deps.db??pool,now=deps.now??Date.now;
 requireProof(plan.ownerId===scope.ownerId,'economic_discharge_owner_changed');
 let tx:PoolClient|undefined,committing=false,committed=false,discard=false;let connection:ReturnType<typeof transactionConnectionFence>|undefined;
 try{
  tx=await db.connect();connection=transactionConnectionFence(tx);await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='750ms'; SET LOCAL statement_timeout='4000ms'");
  const accounts=(await tx.query<Account>('SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[plan.accountId,scope.ownerId])).rows;
  requireProof(accounts.length===1,'economic_discharge_account_missing');const a=accounts[0]!;
  requireProof(String(a.revision)===plan.expectedRevision&&String((a as unknown as Row).owner_control_epoch)===scope.controlEpoch&&a.blocked_reason===null&&
   String(a.cash_micros)===plan.cashMicros&&String(a.initial_cash_micros)===plan.initialCashMicros&&String(a.reserved_micros)===plan.releaseReserveMicros,
   'economic_discharge_account_changed');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['economic-discharge:'+scope.ownerId+':'+scope.requestId]);
  requireProof((await tx.query('SELECT 1 FROM private.strata_economic_exit_discharge_cancel WHERE owner_user_id=$1::uuid AND request_id=$2::uuid',[scope.ownerId,scope.requestId])).rows.length===0,'economic_discharge_request_canceled');
  await deps.verifyLocked(tx,a,plan);
  let high=plan.observedAtMs;
  const clock=()=>{const at=now();requireProof(Number.isSafeInteger(at)&&at>=high&&at-plan.observedAtMs<=5000,'economic_discharge_evidence_expired');high=at;connection!.assertLive();};
  clock();const ledger=new ProductionLedger(db,a.id);await ledger.assertConservation(tx,a);
  const parent=await tx.query('UPDATE public.v13_production_intent SET reserved_micros=0 WHERE id=$1 AND account_id=$2 AND kind=\'ENTRY\' AND terminal AND state=\'TERMINAL\' AND reserved_micros=$3 RETURNING id',[plan.parentId,a.id,plan.releaseReserveMicros]);
  requireProof(parent.rows.length===1,'economic_discharge_parent_changed');
  const worker=await tx.query(`UPDATE private.kalshi_account_worker_lease SET state=CASE WHEN account_kill THEN 'killed' ELSE 'released' END,
   arm_requested=false,fencing_token=fencing_token+1,released_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND fencing_token=$3::bigint AND NOT arm_requested
    AND (state='released' OR state IN ('owned','killed') AND heartbeat_at<clock_timestamp()-interval '120 seconds') RETURNING fencing_token::text`,[a.id,scope.ownerId,scope.workerFence]);
  requireProof(worker.rows.length===1,'economic_discharge_worker_fence_changed');
  const updated=await tx.query(`UPDATE public.v13_production_account SET reserved_micros=0,execution_enabled=false,kill_switch=true,
   owner_control_epoch=owner_control_epoch+1,revision=revision+1,reconciled_at=$5,evidence_digest=$6
   WHERE id=$1 AND owner_user_id=$2::uuid AND revision=$3 AND owner_control_epoch=$4 AND blocked_reason IS NULL
    RETURNING revision::text,owner_control_epoch::text`,[a.id,scope.ownerId,plan.expectedRevision,scope.controlEpoch,new Date(plan.observedAtMs),plan.evidenceDigest]);
  requireProof(updated.rows.length===1,'economic_discharge_stop_epoch_changed');
  await ledger.assertConservation(tx,{...a,reserved_micros:'0'});
  await tx.query(`INSERT INTO private.strata_economic_exit_discharge(request_id,owner_user_id,execution_account_id,booking_request_id,booking_digest,
   entry_intent_id,exit_intent_id,reservation_id,client_order_id,settlement_event_id,settlement_digest,exit_request,exit_capability_digest,exit_dispatch_at,marker_order_digest,
   scope_digest,release_sha,released_reserve_micros,prior_revision,posted_revision,prior_control_epoch,control_epoch,prior_worker_fence,worker_fence,payload,payload_digest)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
   [scope.requestId,scope.ownerId,a.id,plan.bookingRequestId,plan.bookingDigest,plan.parentId,plan.exitId,plan.reservationId,plan.exitRequest.clientOrderId,
    plan.settlementEventId,plan.settlementDigest,plan.exitRequest,plan.exitCapabilityDigest,new Date(plan.exitDispatchAt),plan.markerOrderDigest,
    scope.scopeDigest,scope.releaseSha,plan.releaseReserveMicros,plan.expectedRevision,updated.rows[0]!.revision,scope.controlEpoch,updated.rows[0]!.owner_control_epoch,
    scope.workerFence,worker.rows[0]!.fencing_token,plan,digest(plan)]);
  const recognized=await tx.query('SELECT private.strata_has_economic_exit_discharge($1,$2) AS verified',[a.id,plan.exitRequest.clientOrderId]);
  requireProof(recognized.rows.length===1&&recognized.rows[0].verified===true,'economic_discharge_receipt_not_recognized');
  await ledger.observe(tx,'OWNER_ECONOMIC_OBLIGATION_DISCHARGED',{requestId:scope.requestId,bookingRequestId:plan.bookingRequestId,accountId:a.id,
   releasedReserveMicros:plan.releaseReserveMicros,priorWorkerFence:scope.workerFence,workerFence:worker.rows[0]!.fencing_token,
   receiptDigest:digest(plan),cashChanged:false,transportOutcome:'UNKNOWN',tradingAuthorized:false});
  clock();committing=true;await tx.query('COMMIT');committed=true;
 }catch(error){
  if(committing){discard=true;return {...dischargeNo('economic_discharge_commit_outcome_unverified','UNKNOWN'),requestId:scope.requestId,outcomeUnknown:true,reserveReleased:null,leaseReleased:null};}
  return {...dischargeNo(error instanceof Error&&/^economic_discharge_[a-z_]+$/.test(error.message)?error.message:'economic_discharge_transaction_refused'),requestId:scope.requestId};
 }finally{if(tx){if(!committed&&!committing)try{await tx.query('ROLLBACK');}catch{discard=true;}connection?.close();discard=discard||(connection?.broken()??false);
  try{tx.release(discard?new Error('economic_discharge_connection_discarded'):undefined);}catch{discard=true;}finally{connection?.cleanup(discard);}}}
 return economicDischargeOutcome(scope.ownerId,scope.requestId,db);
}
export async function cancelEconomicDischarge(owner:string,id:string,db:Pool=pool){
 if(!UUID.test(owner)||!UUID.test(id))return dischargeNo('economic_discharge_exact_owner_request_required');
 let tx:PoolClient|undefined,commitSent=false,done=false,discard=false;
 try{
  tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1200ms'; SET LOCAL statement_timeout='4000ms'");
  await tx.query('SELECT id FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 ORDER BY id FOR UPDATE',[owner]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['economic-discharge:'+owner+':'+id]);
  const prior=await tx.query('SELECT 1 FROM private.strata_economic_exit_discharge WHERE owner_user_id=$1::uuid AND request_id=$2::uuid',[owner,id]);
  if(!prior.rows.length)await tx.query('INSERT INTO private.strata_economic_exit_discharge_cancel(owner_user_id,request_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING',[owner,id]);
  commitSent=true;await tx.query('COMMIT');done=true;
 }catch{discard=commitSent;return {...dischargeNo('economic_discharge_cancel_unverified','UNKNOWN'),requestId:id,outcomeUnknown:true,reserveReleased:null,leaseReleased:null};}
 finally{if(tx){if(!done&&!commitSent)try{await tx.query('ROLLBACK');}catch{discard=true;}try{tx.release(discard?new Error('economic_discharge_cancel_connection_discarded'):undefined);}catch{}}}
 return economicDischargeOutcome(owner,id,db);
}