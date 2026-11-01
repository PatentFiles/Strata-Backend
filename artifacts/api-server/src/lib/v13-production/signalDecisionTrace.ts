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
   VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(execution_account_id,evaluation_id,phase) DO NOTHING
   RETURNING decision_id`,
   [input.accountId,input.evaluationId,input.phase,age??null,why,sha]);
  // A duplicate phase is already durable; idempotent retries are success.
  return out.rows.length<=1;
 }catch{return false}
}
/** A bounded historical audit page; zero inserts is NOT proof of completeness.
 * The durable cursor advances over SOURCE rows, including already-traced rows.
 * A fixed-cutoff cycle is revisited from the immutable scope start on completion
 * so late/backfilled commits behind a previous cursor are eventually observed.
 * This is catch-up telemetry, never evidence of a missed active-live trade.
 */
type AuditClient=Queryable&{release(error?:Error):void};
type AuditPool={connect():Promise<AuditClient>};
export const AUDIT_SOURCE_PAGE_SIZE=100;
export const AUDIT_FIRST_PAGE_SQL=`
 SELECT id,evaluated_at::text AS evaluated_at
 FROM public.forward_test_evaluations
 WHERE evaluation_source='paper' AND qualifying_trigger=true
  AND fresh_cross=true AND signal IN ('SCOUT','CONFIRM')
  AND evaluated_at >= $1::timestamptz AND evaluated_at <= $2::timestamptz
 ORDER BY forward_test_evaluations.evaluated_at,id LIMIT 100`;
export const AUDIT_NEXT_PAGE_SQL=`
 SELECT id,evaluated_at::text AS evaluated_at
 FROM public.forward_test_evaluations
 WHERE evaluation_source='paper' AND qualifying_trigger=true
  AND fresh_cross=true AND signal IN ('SCOUT','CONFIRM')
  AND evaluated_at >= $1::timestamptz AND evaluated_at <= $2::timestamptz
  AND (evaluated_at,id)>($3::timestamptz,$4::text)
 ORDER BY forward_test_evaluations.evaluated_at,id LIMIT 100`;
export const AUDIT_INSERT_PAGE_SQL=`INSERT INTO private.strata_v13_signal_decisions
    (execution_account_id,evaluation_id,phase,source_age_ms,reason,release_commit_sha)
    SELECT $1,s.id,'UNSEEN_IN_WINDOW',
     LEAST(2147483647,GREATEST(0,EXTRACT(EPOCH FROM(clock_timestamp()-s.evaluated_at))*1000))::integer,
     'not_observed_during_live_entry_window',$2
    FROM unnest($3::text[],$4::timestamptz[]) AS s(id,evaluated_at)
    WHERE (SELECT 1 FROM private.strata_v13_signal_decisions d
     WHERE d.execution_account_id=$1 AND d.evaluation_id=s.id LIMIT 1) IS NULL
    ON CONFLICT(execution_account_id,evaluation_id,phase) DO NOTHING
    RETURNING decision_id`;
export async function auditUnseenExpiredSignals(accountId:string,
 db:AuditPool=pool):Promise<number> {
 const sha=deployedGitSha();
 if(!accountId||!SHA.test(sha))throw new Error("production_signal_trace_sweep_unavailable");
 let client:AuditClient|undefined;
 let discardClient:Error|undefined;
 try {
  client=await db.connect();
  await client.query("BEGIN");
  // Transaction-local budgets; never leave altered pool-session settings behind.
  await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='2s'");
  await client.query(`INSERT INTO private.strata_v13_signal_audit_progress(execution_account_id)
   VALUES($1) ON CONFLICT DO NOTHING`,[accountId]);
  const state=(await client.query(`SELECT cycle_cutoff::text,cursor_evaluated_at::text,
   cursor_evaluation_id FROM private.strata_v13_signal_audit_progress
   WHERE execution_account_id=$1 FOR UPDATE`,[accountId])).rows[0];
  if(!state)throw new Error("audit_progress_missing");
  const scope=(await client.query(`SELECT scope.started_at::text,p.state AS policy_state,
   (clock_timestamp()-(p.max_quote_age_ms*interval '1 millisecond'))::text AS cutoff
   FROM public.v13_production_account a
   JOIN private.strata_v13_signal_trace_scope scope ON scope.execution_account_id=a.id
   LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id
    AND p.execution_account_id=a.id
   WHERE a.id=$1`,[accountId])).rows[0];
  // Policy holds do not advance historical progress; no admission gate is changed.
  if(!scope)throw new Error("audit_scope_missing");
  if(scope.policy_state!=="APPROVED"){await client.query("ROLLBACK");return 0;}
  if(!scope.cutoff)throw new Error("audit_policy_clock_missing");
  const cutoff=state.cycle_cutoff??scope.cutoff;
  const args=state.cursor_evaluated_at===null?[scope.started_at,cutoff]:
   [scope.started_at,cutoff,state.cursor_evaluated_at,state.cursor_evaluation_id];
  const page=(await client.query(state.cursor_evaluated_at===null?
   AUDIT_FIRST_PAGE_SQL:AUDIT_NEXT_PAGE_SQL,args)).rows;
  let inserted=0;
  if(page.length){
   const result=await client.query(AUDIT_INSERT_PAGE_SQL,[accountId,sha,page.map(r=>r.id),page.map(r=>r.evaluated_at)]);
   inserted=result.rows.length;
   const last=page[page.length-1];
   await client.query(`UPDATE private.strata_v13_signal_audit_progress SET
    cycle_cutoff=$2::timestamptz,cursor_evaluated_at=$3::timestamptz,cursor_evaluation_id=$4,
    cycle_started_at=CASE WHEN cycle_cutoff IS NULL THEN clock_timestamp() ELSE cycle_started_at END,
    last_success_at=clock_timestamp(),sources_examined=sources_examined+$5,
    decisions_inserted=decisions_inserted+$6 WHERE execution_account_id=$1`,
    [accountId,cutoff,last.evaluated_at,last.id,page.length,inserted]);
  }else{
   await client.query(`UPDATE private.strata_v13_signal_audit_progress SET
    cycle_cutoff=NULL,cursor_evaluated_at=NULL,cursor_evaluation_id=NULL,
    cycle_started_at=NULL,last_success_at=clock_timestamp(),
    last_completed_cycle_at=clock_timestamp(),completed_cycles=completed_cycles+1
    WHERE execution_account_id=$1`,[accountId]);
  }
  await client.query("COMMIT");
  return inserted;
 }catch{
  if(client){try{await client.query("ROLLBACK");}catch{discardClient=new Error("audit_rollback_failed");}}
  throw new Error("production_signal_trace_sweep_unavailable");
 }finally{client?.release(discardClient);}
}
