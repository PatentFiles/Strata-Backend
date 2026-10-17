/**
 * CONTROLLED SANDBOX ONLY. Exercises the one-shot emergency IOC execution
 * sequence using an explicitly provided sandbox transport. This module has
 * no production route or network client and cannot enable real-money orders.
 *
 * 1. The production-shaped database fence must durably mark UNKNOWN.
 * 2. At most one exchange POST attempt may be made for this invocation.
 * 3. Exchange-authenticated post-trade evidence is required for a terminal
 * result. HTTP responses alone never resolve UNKNOWN or permit a retry.
 *
 * Do NOT bind this module to production without independent approval,
 * true signed exchange testing, and an audited recovery authorization policy.
 */
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
import {reconcileIocEmergencyExit} from "./ownerFeeEmergencyExitReconcile";

type SandboxMark = {unknownRecorded:boolean;mayRetry:false;transportAuthorized:false;clientOrderId?:string};
export type SandboxCycleResult = {
  state:"BLOCKED"|"UNKNOWN"|"RECONCILED";
  mayRetry:false;
  tradingAuthorized:false;
  productionOrderSubmitted:false;
  sandboxPostAttempted:boolean;
  reason:string;
  filledHundredths?:string;
};
const blocked=(reason:string):SandboxCycleResult=>({
  state:"BLOCKED",mayRetry:false,tradingAuthorized:false,
  productionOrderSubmitted:false,sandboxPostAttempted:false,reason,
});
type SignedSandboxReceipt=IocRecoveryObservation["response"];
export interface SandboxSignedTransport {
  /** Injection MUST be a controlled, separately authenticated sandbox adapter. */
  environment:"KALSHI_SANDBOX";
  submitSignedIocOnce(order:Readonly<EmergencyExitOrder>):Promise<SignedSandboxReceipt>;
  /**
   * Independently re-read the complete scoped position, order and fill history.
   * A missing/failed read must never make an ambiguous submit look rejected.
   */
  readVerifiedPostOrder(
    clientOrderId:string, receipt:SignedSandboxReceipt
  ):Promise<IocRecoveryObservation>;
}
export async function exerciseSandboxExitAfterUnknown(input:{
  order:Readonly<EmergencyExitOrder>;
  durableMarker:()=>Promise<SandboxMark>;
  sandbox:SandboxSignedTransport;
}):Promise<SandboxCycleResult>{
  const {order,sandbox}=input;
  if(!sandbox || sandbox.environment!=="KALSHI_SANDBOX" ||
     !order || order.reduce_only!==true ||
     order.time_in_force!=="immediate_or_cancel" ||
     order.post_only!==false ||
     order.self_trade_prevention_type!=="taker_at_cross" ||
     order.exchange_index!==2 || order.subaccount!==1 ||
     typeof order.client_order_id!=="string" ||
     !/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(order.client_order_id))
    return blocked("sandbox_exit_scope_invalid");
  let marked:SandboxMark;
  try{
    marked=await input.durableMarker();
  }catch{
    return blocked("sandbox_exit_unknown_marker_unverified");
  }
  if(marked?.unknownRecorded!==true ||
     marked.transportAuthorized!==false ||
     marked.mayRetry!==false ||
     marked.clientOrderId!==order.client_order_id)
    return blocked("sandbox_exit_unknown_not_durable");
  // UNKNOWN is already persisted. A timeout, rejected response or process
  // crash may have submitted a real order: never invoke submit a second time.
  const unknown=(reason:string):SandboxCycleResult=>({
    state:"UNKNOWN",mayRetry:false,tradingAuthorized:false,
    productionOrderSubmitted:false,sandboxPostAttempted:true,reason,
  });
  let receipt:SignedSandboxReceipt=null;
  try{
    receipt=await sandbox.submitSignedIocOnce(Object.freeze({...order}));
  }catch{
    return unknown("sandbox_exit_submit_outcome_unknown");
  }
  let observation:IocRecoveryObservation;
  try{
    observation=await sandbox.readVerifiedPostOrder(order.client_order_id,receipt);
  }catch{
    return unknown("sandbox_exit_exchange_reconciliation_unavailable");
  }
  if(observation.clientOrderId!==order.client_order_id ||
     observation.marketTicker!==order.ticker ||
     observation.positionMarketTicker!==order.ticker ||
     observation.requestedCountFp!==order.count ||
     observation.reducingBookSide!==order.side)
    return unknown("sandbox_exit_verified_identity_mismatch");
  const result=reconcileIocEmergencyExit(observation);
  if(result.state!=="RECONCILED")
    return unknown(result.reason);
  return {...unknown("sandbox_exit_reconciled_no_retry"),state:"RECONCILED",
    filledHundredths:result.filledHundredths};
}
