import {verifySupabaseAccessToken} from './supabaseAuth';
import type {JWTVerifyGetKey} from 'jose';
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;release:(error?:Error)=>void};
/** Disabled/unmounted readback only. A historical receipt is not current readiness.
 * Absence never licenses a retry: a disconnected COMMIT may still be in flight.
 */
export async function readOwnerRecoveryOutcome(input:{token:string;accountId:string;requestId:string},deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey;verifyCurrentSession:(token:string,ownerId:string)=>Promise<boolean>;db:{connect:()=>Promise<Client>}}){
 const out=(status:string,extra:Record<string,unknown>={})=>({status,historicalReleaseRecorded:false,currentReadinessVerified:false,retryAuthorized:false,tradingAuthorized:false,stateChanged:false,...extra});
 if(!deps.enabled)return out('feature_disabled');
 if(!input.accountId||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId))return out('exact_request_required');
 let actor;try{actor=await verifySupabaseAccessToken(input.token,deps);if(!await deps.verifyCurrentSession(input.token,actor.subject))throw Error('session');}catch{return out('current_owner_session_required');}
 let tx:Client;try{tx=await deps.db.connect();}catch{return out('readback_unavailable');}
 let discard:Error|undefined;
 try{
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await tx.query("SET LOCAL statement_timeout='1500ms'");
  await tx.query("SET LOCAL lock_timeout='500ms'");
  const a=await tx.query('SELECT id,execution_enabled,kill_switch,revision::text FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid LIMIT 2',[input.accountId,actor.subject]);
  if(a.rows.length!==1){await tx.query('ROLLBACK');return out('owner_account_scope_refused');}
  const r=await tx.query('SELECT release_sha,authority_digest FROM private.strata_owner_recovery_release_receipt WHERE request_id=$1::uuid AND account_id=$2 AND owner_id=$3::uuid LIMIT 2',[input.requestId,input.accountId,actor.subject]);
  const l=await tx.query('SELECT state,account_kill,arm_requested,fencing_token::text,consent_epoch::text FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid LIMIT 2',[input.accountId,actor.subject]);
  // Recheck current session after reads; do not disclose stale-session account facts.
  if(!await deps.verifyCurrentSession(input.token,actor.subject)){await tx.query('ROLLBACK');return out('current_owner_session_required');}
  await tx.query('ROLLBACK');
  if(r.rows.length===0)return out('release_not_observed_outcome_unresolved');
  if(r.rows.length!==1||!/^[a-f0-9]{40}$/.test(r.rows[0].release_sha)||!/^[a-f0-9]{64}$/.test(r.rows[0].authority_digest))return out('release_receipt_invalid');
  return out('historical_release_recorded',{historicalReleaseRecorded:true,releaseSha:r.rows[0].release_sha,accountSnapshot:{executionEnabled:a.rows[0].execution_enabled,killSwitch:a.rows[0].kill_switch,revision:a.rows[0].revision},leaseSnapshot:l.rows.length===1?l.rows[0]:null});
 }catch{discard=Error('owner_recovery_readback_failed');try{await tx.query('ROLLBACK');}catch{}return out('readback_unavailable');}finally{tx.release(discard);}
}
