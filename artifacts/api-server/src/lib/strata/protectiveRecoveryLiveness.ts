/** A diagnostic only. It never updates the execution lease, extends order
 * authority, changes a ledger, or substitutes for signed reconciliation. */
export function protectiveRecoveryLivenessStage(input:{
 enabled:boolean; sameFencedSession:boolean; recovery:{reason:string;attempted:number};
}):'recovery_only_entries_blocked'|null{
 return input.enabled && input.sameFencedSession && input.recovery.attempted===1 &&
   input.recovery.reason==='authenticated_restart_history_unproven'
   ? 'recovery_only_entries_blocked' : null;
}
