import {isDurableProtectiveExitNoSend,type dispatchReviewedProtectiveExitOnce} from "./ownerFeeEmergencyExitSignedDispatch";
import type {TechnicalReleaseEntryGate} from "./technicalReleaseEntryGate";

/** Trusted supervisor continuation only, never an approval or order entrypoint.
 * A known local no-send may reconcile without latching STOP. Only the supplied
 * existing signed-reconciliation path can reopen the technical gate after
 * proving flatness and all approvals. Any uncertain/forged outcome or failed
 * reconciliation keeps the ordinary sticky entry hold. */
export async function reconcileOwnedProtectiveExitOutcome(input:{
 outcome:Awaited<ReturnType<typeof dispatchReviewedProtectiveExitOnce>>;
 ownerId:string;accountId:string;reservationId:string;
 technicalRelease:Pick<TechnicalReleaseEntryGate,"beginReconciliation">;
 state:{entriesAuthorized?:boolean};
 reconcile:()=>Promise<void>;
}):Promise<void>{
 input.technicalRelease.beginReconciliation();
 try{
  const outcome=input.outcome;
  if(outcome.state!=="RECONCILED"&&!isDurableProtectiveExitNoSend(outcome,input))
   throw Error(outcome.reason);
  await input.reconcile();
 }catch(error){input.technicalRelease.beginReconciliation();input.state.entriesAuthorized=false;throw error;}
}
