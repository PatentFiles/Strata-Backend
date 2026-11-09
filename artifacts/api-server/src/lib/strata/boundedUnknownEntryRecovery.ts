/** OFFLINE DESIGN CANDIDATE. Not imported by runtime or exposed to HTTP.
 * Pure scheduling policy, NOT authentication, reconciliation, or order authority.
 * The trusted coordinator must persist state under account/fence locking and
 * perform its own authorization before each read. Client events are not trusted.
 * No successful transition enables entries, exits, signing, or worker restart.
 */
export type RecoveryState = Readonly<{
  phase: 'waiting' | 'reading' | 'halted' | 'review';
  accountId: string; intentId: string; fence: string;
  startedAt: number; deadline: number; lastNow: number;
  attempts: number; nextAt: number; attemptId: string | null; reason: string;
}>;
export type RecoveryEvent =
  | { kind: 'tick'; now: number; fence: string }
  | { kind: 'read_failed'; now: number; fence: string; attemptId: string }
  | { kind: 'read_completed'; now: number; fence: string; attemptId: string }
  | { kind: 'stop'; now: number; fence: string };
export type RecoveryAction = 'NONE' | 'REQUEST_AUTHORIZED_READ' | 'ESCALATE';
export type RecoveryStep = Readonly<{ state: RecoveryState; action: RecoveryAction;
  tradingAuthorized: false; entriesEnabled: false; maySubmitOrder: false }>;
const clock = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 8640000000000000 - 15000;
export function beginUnknownEntryRecovery(accountId: string, intentId: string, fence: string, now: number): RecoveryState {
  if (![accountId,intentId].every(s=>typeof s === 'string' && /^[a-zA-Z0-9:_.-]{1,200}$/.test(s)) ||
      !/^[1-9][0-9]{0,19}$/.test(fence) || !clock(now)) throw Error('invalid_recovery_scope');
  return Object.freeze({phase:'waiting',accountId,intentId,fence,startedAt:now,deadline:now+15000,
    lastNow:now,attempts:0,nextAt:now,attemptId:null,reason:'entry_hold_required'});
}
export function stepUnknownEntryRecovery(state: RecoveryState, event: RecoveryEvent): RecoveryStep {
  const out=(s:RecoveryState,action:RecoveryAction='NONE'):RecoveryStep=>Object.freeze({
    state:Object.freeze(s),action,tradingAuthorized:false,entriesEnabled:false,maySubmitOrder:false});
  const halt=(reason:string)=>out({...state,phase:'halted',attemptId:null,reason},'ESCALATE');
  if(state.phase==='halted'||state.phase==='review') return out(state);
  if(!clock(event.now)||event.now<state.lastNow) return halt('invalid_or_regressing_clock');
  if(event.kind==='stop') return halt('owner_or_system_stop');
  if(event.fence!==state.fence) return halt('fence_changed');
  if(event.now>=state.deadline) return halt('recovery_deadline_exceeded');
  const current={...state,lastNow:event.now};
  if(event.kind==='tick') {
    if(state.phase==='reading'||event.now<state.nextAt) return out(current);
    if(state.attempts>=3) return halt('recovery_attempts_exhausted');
    const attempts=state.attempts+1;
    return out({...current,phase:'reading',attempts,
      attemptId:`${state.intentId}:${state.fence}:${attempts}`,reason:'read_requires_trusted_authorization'},'REQUEST_AUTHORIZED_READ');
  }
  // Delayed, duplicated and cross-attempt completions cannot advance authority.
  if(state.phase!=='reading'||event.attemptId!==state.attemptId) return halt('unmatched_read_completion');
  if(event.kind==='read_completed') return out({...current,phase:'review',attemptId:null,
    reason:'snapshot_requires_native_ledger_validation'},'ESCALATE');
  if(state.attempts>=3) return halt('recovery_attempts_exhausted');
  return out({...current,phase:'waiting',attemptId:null,nextAt:event.now+1000,
    reason:'bounded_read_retry_pending'});
}
