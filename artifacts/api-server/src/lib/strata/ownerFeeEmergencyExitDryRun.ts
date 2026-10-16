/**
 * OFFLINE ONLY: exercise a position-reduction lifecycle without constructing
 * an authenticated Kalshi transport or ever invoking a network request.
 * A green dry-run is not permission to route any live order.
 */
import {inspectEmergencyExitCandidate,type EmergencyExitOrder,
  type EmergencyExitEvidence,type EmergencyExitDecision} from "./ownerFeeEmergencyExit";
import {reconcileIocEmergencyExit,type IocRecoveryObservation,
  type IocRecoveryResult} from "./ownerFeeEmergencyExitReconcile";

export interface ExitDryRunScenario {
  ownerId:string;
  order:EmergencyExitOrder;
  evidence:EmergencyExitEvidence|null;
  observedAtMs:number;
  exchangeObservation:IocRecoveryObservation|null;
}
export interface ExitDryRunOutcome {
  ok:false;
  tradingAuthorized:false;
  exchangeOrderSubmitted:false;
  attemptedNetworkCalls:0;
  advisory:EmergencyExitDecision;
  reconciliation:IocRecoveryResult|null;
  reason:string;
}
function fail(advisory:EmergencyExitDecision,reason:string,reconciliation:IocRecoveryResult|null=null):
  ExitDryRunOutcome{
  return {ok:false,tradingAuthorized:false,exchangeOrderSubmitted:false,
    attemptedNetworkCalls:0,advisory,reconciliation,reason};
}
/**
 * Intake:
 *  - independently verified account ownership, position and fee metadata;
 *  - native IOC reduce-only shape, no pending order;
 *  - simulated receipt and signed position/fill observation, when available.
 *
 * No mockable "transport" or send callback exists; this routine cannot send
 * any order by design. UNKNOWN must remain UNKNOWN and non-retryable.
 */
export function simulateEmergencyExit(s:ExitDryRunScenario):ExitDryRunOutcome{
  const proof=inspectEmergencyExitCandidate(s.ownerId,s.order,s.evidence,s.observedAtMs);
  if(!proof.diagnosticEligible)
    return fail(proof,proof.reason);
  if(!s.exchangeObservation)
    return fail(proof,"emergency_exit_dry_run_missing_exchange_observation");
  const response=reconcileIocEmergencyExit(s.exchangeObservation);
  // Cross-validate independently supplied dry-run observations. No accepting
  // an exchange receipt that matches a *different* order or closing side.
  const order=s.order,obs=s.exchangeObservation;
  if(obs.clientOrderId!==order.client_order_id||
     obs.marketTicker!==order.ticker||
     obs.reducingBookSide!==order.side||
     obs.requestedCountFp!==order.count||
     obs.initialPositionFp!==s.evidence?.positionFp)
    return fail(proof,"emergency_exit_dry_run_cross_binding_failed",response);
  return fail(proof,response.reason,response);
}
