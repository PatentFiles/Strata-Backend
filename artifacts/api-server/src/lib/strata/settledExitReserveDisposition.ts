import type {Pool,PoolClient} from '@workspace/db';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {requireProof} from '../v13-production/types';
import {transactionConnectionFence} from '../v13-production/transactionConnectionFence';
import {inspectSettledExitReserve} from './settledExitReserveEvidence';
import type {EconomicSettlementInput} from './ownerEconomicSettlementProof';

type Scope={requestId:string;ownerId:string;scopeDigest:string;releaseSha:string;controlEpoch:string;workerFence:string};
type Deps={db:Pool;now?:()=>number;
 /** Must use the canonical owner-account-first locked capture. Never accept a
  * serialized or browser-supplied snapshot in place of the authenticated one. */
 verifyLocked:(tx:PoolClient,account:Account,expectedScope:string)=>Promise<void>};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unsigned=/^(0|[1-9][0-9]*)$/;
const fail='settled_exit_reserve_transaction_refused';
const result=(status:'REFUSED'|'RECORDED'|'UNKNOWN'|'NOT_RECORDED',requestId:string)=>({status,requestId,
 reserveReleased:status==='UNKNOWN'?null:status==='RECORDED',transportOutcome:'UNKNOWN' as const,
 accountingPosted:false,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false});

/** Only a server-side stopped-account action may call this. The immutable
 * economic receipt is the only eligible source for the payout. Account cash,
 * ledger events, exit intent, position, lease and marker are never changed.
 * This writer creates no live eligibility.
 */
export async function disposeSettledExitReserve(input:EconomicSettlementInput,scope:Scope,deps:Deps){
 input=structuredClone(input);scope={...scope};
 const now=deps.now??Date.now;
 const {account,exitId,reservationId}=input;
 if(!uuid.test(scope.requestId)||!uuid.test(scope.ownerId)||account.owner_user_id!==scope.ownerId||
  !/^[a-f0-9]{64}$/.test(scope.scopeDigest)||!/^[a-f0-9]{40}$/.test(scope.releaseSha)||
  !unsigned.test(scope.controlEpoch)||!unsigned.test(scope.workerFence))return result('REFUSED',scope.requestId);
 let tx:PoolClient|undefined,fence:ReturnType<typeof transactionConnectionFence>|undefined;
 let committing=false,committed=false,discard=false;
 try{
  tx=await deps.db.connect();fence=transactionConnectionFence(tx);
  await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='750ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
  const found=(await tx.query<Account>('SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',
   [account.id,scope.ownerId])).rows;
  requireProof(found.length===1,fail);const a=found[0]!;
  const prior=(await tx.query(`SELECT * FROM private.strata_settled_exit_reserve_disposition
   WHERE request_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3`,[scope.requestId,scope.ownerId,a.id])).rows;
  if(prior.length===1){
   const r=prior[0]!;
   requireProof(r.release_sha===scope.releaseSha&&r.scope_digest===scope.scopeDigest&&r.exit_intent_id===exitId&&
    r.reservation_id===reservationId&&String(r.control_epoch)===scope.controlEpoch&&String(r.worker_fencing_token)===scope.workerFence,fail);
   return result('RECORDED',scope.requestId);
  }
  requireProof(String(a.revision)===account.revision&&a.cash_micros===account.cash_micros&&a.reserved_micros===account.reserved_micros&&
   String((a as unknown as Record<string,unknown>).owner_control_epoch)===scope.controlEpoch,fail);
  await deps.verifyLocked(tx,a,scope.scopeDigest);
  const receipts=(await tx.query(`SELECT * FROM private.strata_economic_settlement_receipt
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND exit_intent_id=$3 AND reservation_id=$4::uuid FOR SHARE`,
   [scope.ownerId,a.id,exitId,reservationId])).rows;
  requireProof(receipts.length===1,fail);const receipt=receipts[0]!;
  const p=inspectSettledExitReserve({...input,nowMs:now()},receipt);
  requireProof(p.reservedMicros===a.reserved_micros&&BigInt(p.reservedMicros)>0n,fail);
  const current=()=>{const n=now();requireProof(Number.isSafeInteger(n)&&n>=input.snapshot.observedAtMs&&n-input.snapshot.observedAtMs<=5000,fail);fence!.assertLive();};
  const ledger=new ProductionLedger(deps.db,a.id);
  current();await ledger.assertConservation(tx,a);
  const entry=await tx.query(`UPDATE public.v13_production_intent SET reserved_micros=0
   WHERE id=$1 AND account_id=$2 AND kind='ENTRY' AND terminal AND reserved_micros=$3 RETURNING id`,
   [receipt.entry_intent_id,a.id,p.reservedMicros]);
  requireProof(entry.rows.length===1,fail);
  const update=await tx.query(`UPDATE public.v13_production_account SET reserved_micros=0,revision=revision+1
   WHERE id=$1 AND owner_user_id=$2::uuid AND revision=$3 AND owner_control_epoch=$4 AND reserved_micros=$5
    AND cash_micros=$6 RETURNING revision::text`,[a.id,scope.ownerId,account.revision,scope.controlEpoch,p.reservedMicros,a.cash_micros]);
  requireProof(update.rows.length===1,fail);
  await ledger.assertConservation(tx,{...a,reserved_micros:'0'});
  await tx.query(`INSERT INTO private.strata_settled_exit_reserve_disposition
   (settlement_request_id,owner_user_id,execution_account_id,entry_intent_id,exit_intent_id,reservation_id,
    request_id,scope_digest,evidence_digest,release_sha,released_micros,prior_revision,applied_revision,control_epoch,worker_fencing_token)
   VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15)`,
   [receipt.request_id,scope.ownerId,a.id,receipt.entry_intent_id,exitId,reservationId,scope.requestId,scope.scopeDigest,
    p.evidenceDigest,scope.releaseSha,p.reservedMicros,account.revision,update.rows[0]!.revision,scope.controlEpoch,scope.workerFence]);
  current();committing=true;await tx.query('COMMIT');committed=true;
  return result('RECORDED',scope.requestId);
 }catch{
  discard=committing&&!committed;
  return result(discard?'UNKNOWN':'REFUSED',scope.requestId);
 }finally{
  if(tx){
   if(!committing)try{await tx.query('ROLLBACK');}catch{discard=true;}
   fence?.close();discard=discard||(fence?.broken()??false);
   try{tx.release(discard?new Error(fail):undefined);}catch{}finally{fence?.cleanup(discard);}
  }
 }
}

/** Bound readback only. A blocked/failed read yields UNKNOWN, not absence.
 * A not-yet-started request can still arrive; NOT_RECORDED is not cancellation.
 */
export async function readSettledExitReserveOutcome(db:Pool,owner:string,requestId:string){
 if(!uuid.test(owner)||!uuid.test(requestId))return result('REFUSED',requestId);
 let tx:PoolClient|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN');
  await tx.query("SET LOCAL lock_timeout='1200ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
  const accounts=(await tx.query(`SELECT id FROM public.v13_production_account
   WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 ORDER BY id LIMIT 2 FOR SHARE`,[owner])).rows;
  requireProof(accounts.length===1,fail);
  const rows=(await tx.query(`SELECT request_id FROM private.strata_settled_exit_reserve_disposition
   WHERE owner_user_id=$1::uuid AND request_id=$2::uuid AND execution_account_id=$3`,[owner,requestId,accounts[0]!.id])).rows;
  return result(rows.length===1?'RECORDED':'NOT_RECORDED',requestId);
 }catch{return result('UNKNOWN',requestId);}
 finally{if(tx){let discard=false;try{await tx.query('ROLLBACK');}catch{discard=true;}
  try{tx.release(discard?new Error(fail):undefined);}catch{}}}
}
