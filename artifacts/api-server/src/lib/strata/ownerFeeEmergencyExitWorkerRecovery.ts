import {readStoppedSettledExitDispositions,settledReserveReadinessEnabled,verifyDisposedExitAgainstSnapshot} from './armSettledReserveScope';
import {runtimeSettledExitReceipt} from './runtimeSettledExitGuard';
import {dedicatedSignerFingerprint} from './commissioning';
import {personalAccountSnapshot,readOwnedKalshiFeeds} from './personalExchangeRead';
import type {Request} from '../v13-production/types';
import {createHash} from "node:crypto";
import {pool} from "@workspace/db";
import {reconcileUnknownProtectiveExitAfterRestart,type RestartDiagnosticStage} from "./ownerFeeEmergencyExitRestartRecovery";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";

/** Trusted, account-scoped UNKNOWN recovery poll. NEVER posts an IOC.
 * The exact immutable body is re-read from the ledger and compared with its
 * reserved digest. Missing or corrupt bodies remain UNKNOWN: no synthesis,
 * no replay, no permission to continue making entries.
 */
type Db={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type Recover=typeof reconcileUnknownProtectiveExitAfterRestart;
export type ExitRecoveryPoll={ok:boolean;reason:string;attempted:number;mayRetry:false;postAttempted:false;diagnosticStage?:RestartDiagnosticStage};
const blocked=(reason:string):ExitRecoveryPoll=>({ok:false,reason,attempted:0,mayRetry:false,postAttempted:false});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLIENT=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
export async function reconcileOwnedProtectiveExits(input:{
  ownerId:string;accountId:string;material:{keyId:string;privateKey:string};
},db:Db=pool,deps:{recover?:Recover;readFeeds?:typeof readOwnedKalshiFeeds}={}):Promise<ExitRecoveryPoll>{
 const hosted=Boolean(process.env.RAILWAY_PROJECT_ID||process.env.RAILWAY_SERVICE_ID||process.env.RAILWAY_ENVIRONMENT_ID);
 if((deps.recover||deps.readFeeds)&&(process.env.NODE_ENV!=="test"||hosted))
  return blocked("protective_exit_test_recovery_forbidden");
 if(!UUID.test(input.ownerId)||!ACCOUNT.test(input.accountId)||!input.material.keyId||!input.material.privateKey)
  return blocked("protective_exit_recovery_identity_unverified");
 try{
  const rs=await db.query(
   "SELECT reservation_id::text AS reservation_id,market_ticker,client_order_id,"+
   "order_digest,order_request_json FROM private.strata_emergency_exit_reservations "+
   "WHERE owner_user_id=$1::uuid AND execution_account_id=$2::text "+
   "AND state='UNKNOWN' ORDER BY created_at,reservation_id LIMIT 3",
   [input.ownerId,input.accountId],
  );
  if(rs.rows.length===0)return {ok:true,reason:"no_unresolved_protective_exits",attempted:0,mayRetry:false,postAttempted:false};
  if(rs.rows.length>2)return blocked("multiple_unknown_protective_exits_require_manual_review");
  let pending=rs.rows;
  // Receipt recognition here selects a read-only restart target. It must never
  // permit entry or replay a POST while the successor still needs reconciliation.
  if(settledReserveReadinessEnabled()){
   const receipts=await readStoppedSettledExitDispositions(db,input.accountId,input.ownerId);
   const retired=receipts.find(r=>pending.some(row=>r.reservationId===row.reservation_id&&r.clientOrderId===row.client_order_id));
   if(retired){
    // This is economic closure, not proof the old HTTP request was never
    // sent. Recheck complete signed history; don't retry or rewrite the row.
    const fp=dedicatedSignerFingerprint(input.material.keyId,input.material.privateKey);
    if(!fp)return blocked("protective_exit_historical_signer_unverified");
    const found=(await db.query("SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id LIMIT 1001",[input.accountId])).rows;
    if(found.length>1000)return blocked("protective_exit_historical_history_unverified");
    const requests=found.map(r=>typeof r.request==="string"?JSON.parse(r.request):r.request) as Request[];
    const started=Date.now(),feed=await (deps.readFeeds??readOwnedKalshiFeeds)(input.material,started);
    if(!feed.ok||feed.historicalCoverageComplete!==true||feed.observedAtMs!==started)
     return blocked("protective_exit_historical_history_unverified");
    const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:fp},feed,requests);
    if(!("identity" in snapshot))return blocked("protective_exit_historical_history_unverified");
    if(pending.length===2){
     const next=pending.filter(row=>row.reservation_id!==retired.reservationId);
     if(next.length!==1||next[0]!.market_ticker===retired.market||
        next[0]!.client_order_id===retired.clientOrderId||!snapshot.orders.every(o=>o.terminal))
      return blocked("multiple_unknown_protective_exits_require_manual_review");
     // Cash may have legitimately changed due to the successor fill. The
     // ordinary locked signed recovery and financial reconciliation must prove
     // that change, not this read-only classification. Ensure the sole other
     // unresolved marker and financial intent are the exact successor.
     verifyDisposedExitAgainstSnapshot(retired,snapshot);
     const successor=(await db.query(`SELECT a.key_fingerprint,
      EXISTS(SELECT 1 FROM public.v13_production_intent i
       JOIN public.v13_production_position p ON p.id=i.parent_id AND p.account_id=i.account_id AND p.market=i.market AND p.side=i.side
       JOIN private.strata_emergency_exit_reservations m ON m.reservation_id=$8::uuid AND m.execution_account_id=i.account_id
        AND m.owner_user_id=a.owner_user_id AND m.state='UNKNOWN' AND NOT m.trading_authorized
        AND m.client_order_id=i.client_order_id AND m.market_ticker=i.market AND m.reducing_side=i.side
       WHERE i.account_id=a.id AND i.kind='EXIT' AND NOT i.terminal
        AND i.state IN ('DISPATCHED','UNKNOWN') AND i.client_order_id=$4
        AND i.market=$5 AND i.created_at>to_timestamp($6::double precision/1000)) AS matching,
      EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=a.id
        AND (i.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR NOT i.terminal)
        AND i.id<>$3 AND i.client_order_id<>$4) AS conflicting_intents,
      EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations m WHERE m.execution_account_id=a.id
        AND m.state IN ('PREPARED','DISPATCHED','UNKNOWN') AND m.reservation_id NOT IN ($7::uuid,$8::uuid)) AS conflicting_markers
      FROM public.v13_production_account a WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2`,
      [input.accountId,input.ownerId,retired.exitId,next[0]!.client_order_id,next[0]!.market_ticker,
       retired.settledAtMs,retired.reservationId,next[0]!.reservation_id])).rows;
     const currentAt=Date.now();
     if(successor.length!==1||successor[0]!.key_fingerprint!==fp||successor[0]!.matching!==true||
        successor[0]!.conflicting_intents!==false||successor[0]!.conflicting_markers!==false||
        currentAt<started||currentAt-started>5000)return blocked("protective_exit_historical_history_unverified");
     pending=next;
    }else{
     const current=await runtimeSettledExitReceipt(db,{accountId:input.accountId,ownerId:input.ownerId,snapshot,nowMs:Date.now()});
     if(current?.receiptDigest===retired.receiptDigest&&Date.now()-started<=5000&&Date.now()>=started)
      return {ok:true,reason:"historical_protective_exit_economic_receipt_matches",attempted:0,mayRetry:false,postAttempted:false};
     // A newly acknowledged BUY can change exchange cash before ordinary
     // ledger reconciliation. Permit only that read-only reconciliation, not
     // another entry. The ledger independently verifies fills/positions/cash.
     if(!snapshot.orders.every(o=>o.terminal))return blocked("protective_exit_historical_history_unverified");
     verifyDisposedExitAgainstSnapshot(retired,snapshot);
     const entries=(await db.query(`SELECT i.client_order_id,i.market,i.exchange_order_id
      FROM public.v13_production_intent i JOIN public.v13_production_account a ON a.id=i.account_id
      WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2 AND a.key_fingerprint=$3
       AND i.id<>$4 AND (i.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR NOT i.terminal)
       AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations m WHERE m.execution_account_id=a.id
        AND m.reservation_id<>$5::uuid AND m.state IN ('PREPARED','DISPATCHED','UNKNOWN'))
       AND i.kind='ENTRY' AND i.state IN ('DISPATCHED','UNKNOWN') AND NOT i.terminal
       AND i.market<>$6 AND i.created_at>to_timestamp($7::double precision/1000)
       AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent other WHERE other.account_id=a.id
        AND other.id NOT IN ($4,i.id) AND (other.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR NOT other.terminal))
      LIMIT 2`,[input.accountId,input.ownerId,fp,retired.exitId,retired.reservationId,retired.market,retired.settledAtMs])).rows;
     const entry=entries[0],age=Date.now()-started;
     if(entries.length!==1||!entry||!Number.isSafeInteger(age)||age<0||age>5000||
        snapshot.orders.filter(o=>o.request.clientOrderId===entry.client_order_id&&o.request.market===entry.market&&
         o.terminal&&o.request.action==='BUY'&&!o.request.reduceOnly&&
         (entry.exchange_order_id===null||entry.exchange_order_id===o.orderId)).length!==1)
      return blocked("protective_exit_historical_history_unverified");
     return {ok:true,reason:"historical_receipt_pending_owned_entry_reconcile_only",attempted:0,mayRetry:false,postAttempted:false};
    }
   }
  }
  if(pending.length!==1)return blocked("multiple_unknown_protective_exits_require_manual_review");
  const row=pending[0]!,rid=row.reservation_id;
  const raw=row.order_request_json;
  if(typeof rid!=="string"||!UUID.test(rid)||typeof raw!=="string"||raw.length>4096||
     typeof row.order_digest!=="string"||!SHA.test(row.order_digest))
   return blocked("exit_recovery_persisted_request_missing");
  const digest=createHash("sha256").update(raw).digest("hex");
  if(digest!==row.order_digest)return blocked("exit_recovery_persisted_request_digest_mismatch");
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{return blocked("exit_recovery_persisted_request_invalid");}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))
   return blocked("exit_recovery_persisted_request_invalid");
  const order=parsed as Record<string,unknown>;
  if(order.client_order_id!==row.client_order_id||!CLIENT.test(String(order.client_order_id))||
     order.ticker!==row.market_ticker||
     order.reduce_only!==true||order.time_in_force!=="immediate_or_cancel"||
     order.post_only!==false||order.subaccount!==1||order.exchange_index!==2||
     !["ask","bid"].includes(String(order.side))||
     typeof order.count!=="string"||!/^[0-9]{1,9}\.[0-9]{2}$/.test(order.count)||
     typeof order.price!=="string"||!/^0\.[0-9]{4}$/.test(order.price))
   return blocked("exit_recovery_persisted_request_identity_mismatch");
  const outcome=await (deps.recover??reconcileUnknownProtectiveExitAfterRestart)({
   ownerId:input.ownerId,accountId:input.accountId,reservationId:rid,
   material:input.material,order:order as unknown as Readonly<EmergencyExitOrder>,
  });
  return {ok:outcome.state==="RECONCILED",
   reason:outcome.reason,attempted:1,mayRetry:false,postAttempted:false,
   ...(outcome.diagnosticStage?{diagnosticStage:outcome.diagnosticStage}:{})};
 }catch{
  return blocked("protective_exit_recovery_read_or_provider_unavailable");
 }
}
