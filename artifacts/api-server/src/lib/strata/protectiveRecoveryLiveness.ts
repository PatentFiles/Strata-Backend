/** Only the current supervised owner can record liveness after denied signed
 * history. This changes the existing lease timestamp only, not trade authority,
 * order state, reconciliation, or terminal accounting. */
const UPDATE_RECOVERY_LIVENESS = `
 UPDATE private.kalshi_account_worker_lease AS w
 SET heartbeat_at=GREATEST(w.heartbeat_at,$3::timestamptz)
 WHERE w.execution_account_id=$1 AND w.owner_user_id=$2::uuid
   AND w.holder_id=$4 AND w.fencing_token=$5::bigint
   AND w.credential_fingerprint=$6 AND w.state='owned'
   AND w.account_kill=false AND w.arm_requested=true
   AND EXISTS (SELECT 1 FROM public.v13_production_account a
     WHERE a.id=w.execution_account_id AND a.owner_user_id=w.owner_user_id
       AND a.key_fingerprint=w.credential_fingerprint AND a.kill_switch=false AND a.execution_enabled=true)
   AND EXISTS (SELECT 1 FROM public.live_execution_config g WHERE g.id='singleton'
     AND g.live_execution_enabled=true AND g.manual_kill_switch=false)
   AND EXISTS (SELECT 1 FROM private.strata_emergency_exit_reservations r
     WHERE r.execution_account_id=w.execution_account_id AND r.owner_user_id=w.owner_user_id
       AND r.worker_holder_id=w.holder_id AND r.worker_fencing_token=w.fencing_token AND r.state='UNKNOWN')
 RETURNING 1 AS recovery_heartbeat
`;
type QueryPort={query(text:string,args:unknown[]):Promise<{rows:unknown[]}>};
export async function markBlockedProtectiveRecoveryLiveness(db:QueryPort,input:{
 enabled:boolean; sameFencedSession:()=>boolean; recovery:{reason:string;attempted:number};
 accountId:string; ownerId:string; holderId:string; fencingToken:number;
 fingerprint:string; observedAt:string;
}):Promise<'SKIPPED'|'RECOVERY_ONLY'|'STALE_FENCE'>{
 if(!input.enabled || input.recovery.reason!=='authenticated_restart_history_unproven' ||
    input.recovery.attempted!==1 || !input.sameFencedSession())return 'SKIPPED';
 try{
  const beat=await db.query(UPDATE_RECOVERY_LIVENESS,[input.accountId,input.ownerId,
   input.observedAt,input.holderId,input.fencingToken,input.fingerprint]);
  return beat.rows.length===1&&input.sameFencedSession()?'RECOVERY_ONLY':'STALE_FENCE';
 }catch{return 'STALE_FENCE';}
}
