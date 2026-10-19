import {readAuthenticatedProtectiveExitOutcome} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import {persistAuthenticatedExitReconciliation} from "./ownerFeeEmergencyExitReconciliationCommit";
import {reconcileIocEmergencyExit} from "./ownerFeeEmergencyExitReconcile";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";

/**
 * Server-only restart recovery of a previously committed UNKNOWN reservation.
 * No order transport, signer POST, grant bypass, or attempt-state reset exists here.
 * The authenticated provider history MUST uniquely establish all filled contracts
 * and the exact position delta; absent or ambiguous history remains UNKNOWN.
 * Controllers must source owner, account, reservation and credentials from the
 * verified server session / secret vault, never from request JSON.
 */
export async function reconcileUnknownProtectiveExitAfterRestart(input:{
 ownerId:string;accountId:string;reservationId:string;
 material:{keyId:string;privateKey:string};
 order:Readonly<EmergencyExitOrder>;
}):Promise<{state:"UNKNOWN"|"RECONCILED";reason:string;mayRetry:false;postAttempted:false}> {
 try {
  const observation=await readAuthenticatedProtectiveExitOutcome(input,null);
  const verified=reconcileIocEmergencyExit(observation);
  if(verified.state!=="RECONCILED")
   return {state:"UNKNOWN",reason:verified.reason,mayRetry:false,postAttempted:false};
  const committed=await persistAuthenticatedExitReconciliation(input,observation);
  if(!committed.committed)
   return {state:"UNKNOWN",reason:committed.reason,mayRetry:false,postAttempted:false};
  return {state:"RECONCILED",reason:"signed_exchange_history_reconciled",mayRetry:false,postAttempted:false};
 }catch {
  return {state:"UNKNOWN",reason:"authenticated_restart_history_unproven",mayRetry:false,postAttempted:false};
 }
}
