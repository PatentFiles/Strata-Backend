import {pool} from "@workspace/db";
import {deployedGitSha} from "../strata/deployedGitSha";
export type LiveSignalPhase =
 "QUALIFYING_SEEN"|"PREPARE_REJECTED"|"ENTRY_PREPARED"|
 "DISPATCH_COMPLETED"|"DISPATCH_REJECTED"|"STALE_AT_WORKER"|
 "UNSEEN_IN_WINDOW";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const PHASES=new Set<LiveSignalPhase>([
 "QUALIFYING_SEEN","PREPARE_REJECTED","ENTRY_PREPARED",
 "DISPATCH_COMPLETED","DISPATCH_REJECTED","STALE_AT_WORKER","UNSEEN_IN_WINDOW",
]);
type Queryable={query(text:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
export function sanitizedDecisionReason(error:unknown):string {
 const r=error instanceof Error?error.message:
  (typeof error==="string"?error:"unclassified_entry_failure");
 const safe=r.match(/^[a-z][a-z0-9_]{0,127}$/i);
 return safe?r:"live_execution_rejection_details_redacted";
}
export async function recordLiveSignalDecision(input:{
 accountId:string;evaluationId:string;phase:LiveSignalPhase;
 sourceAgeMs?:number|null;reason?:string;
},db:Queryable=pool,sha=deployedGitSha()):Promise<boolean> {
 if(!input.accountId||!UUID.test(input.evaluationId)||!SHA.test(sha)||
   !PHASES.has(input.phase))return false;
 const age=input.sourceAgeMs;
 if(age!==undefined&&age!==null&&(!Number.isSafeInteger(age)||age<0))return false;
 const why=input.reason?sanitizedDecisionReason(input.reason):null;
 try {
  const out=await db.query(`
   INSERT INTO private.strata_v13_signal_decisions
    (execution_account_id,evaluation_id,phase,source_age_ms,reason,release_commit_sha)
   VALUES($1,$2::uuid,$3,$4,$5,$6)
   ON CONFLICT(execution_account_id,evaluation_id,phase) DO NOTHING
   RETURNING decision_id`,
   [input.accountId,input.evaluationId,input.phase,age??null,why,sha]);
  // A duplicate phase is already durable; idempotent retries are success.
  return out.rows.length<=1;
 }catch{return false}
}
/** Low-priority observability scan: qualifying paper signals that were NEVER
 * seen by the live worker in their approved freshness window. No orders
 * or admission gates are changed. The scanner runs off the critical path.
 */
export async function auditUnseenExpiredSignals(accountId:string,
 db:Queryable=pool):Promise<number> {
 const sha=deployedGitSha();
 if(!accountId||!SHA.test(sha))return 0;
 try {
  const r=await db.query(`
   WITH candidates AS (
    SELECT e.id,e.evaluated_at,p.max_quote_age_ms
    FROM public.forward_test_evaluations e
    JOIN public.v13_production_account a ON a.id=$1
    JOIN public.v13_live_money_policy p ON p.id=a.policy_id
     AND p.execution_account_id=a.id AND p.state='APPROVED'
    WHERE e.evaluation_source='paper' AND e.qualifying_trigger=true
     AND e.fresh_cross=true AND e.signal IN ('SCOUT','CONFIRM')
     AND e.evaluated_at BETWEEN now()-interval '15 minutes'
                          AND now()-(p.max_quote_age_ms*interval '1 millisecond')
     AND NOT EXISTS(
       SELECT 1 FROM private.strata_v13_signal_decisions d
       WHERE d.execution_account_id=$1 AND d.evaluation_id=e.id
     )
    ORDER BY e.evaluated_at DESC LIMIT 100
   )
   INSERT INTO private.strata_v13_signal_decisions
    (execution_account_id,evaluation_id,phase,source_age_ms,reason,release_commit_sha)
   SELECT $1,c.id,'UNSEEN_IN_WINDOW',
     GREATEST(0,EXTRACT(EPOCH FROM(now()-c.evaluated_at))*1000)::integer,
     'not_observed_during_live_entry_window',$2
   FROM candidates c
   ON CONFLICT(execution_account_id,evaluation_id,phase) DO NOTHING
   RETURNING decision_id`,[accountId,sha]);
  return r.rows.length;
 }catch{return 0}
}
