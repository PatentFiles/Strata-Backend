import {readAuthenticatedProtectiveExitOutcome,protectiveHistoryReadDiagnostic,type ProtectiveHistoryDiagnosticStage} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
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
export type RestartDiagnosticStage=ProtectiveHistoryDiagnosticStage|"signed_history_reader_exception"|"reconciliation_check_exception"|"reconciliation_persist_exception";
type RestartPorts={
 readOutcome?:typeof readAuthenticatedProtectiveExitOutcome;
 persistReconciled?:typeof persistAuthenticatedExitReconciliation;
};
export async function reconcileUnknownProtectiveExitAfterRestart(input:{
 ownerId:string;accountId:string;reservationId:string;
 material:{keyId:string;privateKey:string};
 order:Readonly<EmergencyExitOrder>;
},ports:RestartPorts={}):Promise<{state:"UNKNOWN"|"RECONCILED";reason:string;mayRetry:false;postAttempted:false;
 diagnosticStage?:RestartDiagnosticStage;
 reconciliationCommitState?:"NOT_ATTEMPTED"|"UNKNOWN"|"COMMITTED";reconciliationFreshnessVerified?:boolean}> {
 // Injected ports are strictly for offline unit tests, never a hosted worker.
 const hosted=Boolean(process.env.RAILWAY_ENVIRONMENT_ID||
   process.env.RAILWAY_SERVICE_ID||process.env.RAILWAY_PROJECT_ID);
 if((ports.readOutcome||ports.persistReconciled)&&
    (process.env.NODE_ENV!=="test"||hosted))
  return {state:"UNKNOWN",reason:"restart_test_ports_prohibited",
    mayRetry:false,postAttempted:false};
 let phase:RestartDiagnosticStage="signed_history_reader_exception";
 try {
  const observation=await (ports.readOutcome??readAuthenticatedProtectiveExitOutcome)(input,null);
  phase="reconciliation_check_exception";
  const verified=reconcileIocEmergencyExit(observation);
  if(verified.state!=="RECONCILED")
   return {state:"UNKNOWN",reason:verified.reason,mayRetry:false,postAttempted:false};
  phase="reconciliation_persist_exception";
  const committed=await (ports.persistReconciled??persistAuthenticatedExitReconciliation)(input,observation);
  if(!committed.committed||committed.freshnessVerified!==true||committed.commitState!=="COMMITTED"||committed.mayRetry!==false)
   // UNKNOWN is the caller's verification outcome, not proof of durable
   // rollback. Preserve acknowledged/uncertain COMMIT explicitly.
   return {state:"UNKNOWN",reason:committed.reason,mayRetry:false,postAttempted:false,
    reconciliationCommitState:committed.commitState,reconciliationFreshnessVerified:committed.freshnessVerified};
  return {state:"RECONCILED",reason:"signed_exchange_history_reconciled",mayRetry:false,postAttempted:false};
 }catch(error) {
  const diagnosticStage=phase==="signed_history_reader_exception"?protectiveHistoryReadDiagnostic(error)??phase:phase;
  return {state:"UNKNOWN",reason:"authenticated_restart_history_unproven",mayRetry:false,postAttempted:false,diagnosticStage};
 }
}
