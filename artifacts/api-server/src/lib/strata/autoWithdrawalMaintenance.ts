import { pool } from "@workspace/db";
import { CASHIER_SWEEP_CONFIRMATION, confirmManualSweep, observeAutomaticSweepCash, quoteManualSweep, reconcileManualSweep, sweepAvailability } from "./manualProfitWithdrawals";
import { personalTradingControls, personalTradingSession } from "./sharedPersonalTradingControls";
import { reconcileOwnedSubaccountCash } from "./personalAccountActivation";
import { RECORD_OWNED_CASH_CONFIRMATION } from "./personalCashReconciliation";
import type { AutoRule } from "./autoProfitWithdrawals";

// Real trading is fenced by the same worker lease and STOP path as the Dashboard.
// No code in this module clears an existing account or global kill switch.
const M="private.strata_auto_withdrawal_maintenance";
const R="private.strata_auto_profit_withdrawal_rules";
const W="private.strata_manual_profit_withdrawals";
type Row=Record<string,unknown>;
export type MaintenancePhase="idle"|"pause_requested"|"waiting_flat"|"ready_to_transfer"|"reconciling"|"resume_requested"|"completed"|"blocked";
export interface MaintenanceView {
 phase:MaintenancePhase;reason:string;cycle:number;wasRunning:boolean;
 wasArmed:boolean;interrupted:boolean;transferId:string|null;changedAt:string|null;
}
const txt=(x:unknown)=>typeof x==="string"?x:null;
/** Pure fail-closed restart decision. Live START still rechecks every risk gate. */
export function automaticResumeAuthorized(input:{
  wasRunning:boolean;wasArmed:boolean;initialKillSwitch:boolean;
  ownerInterrupted:boolean;ruleEnabled:boolean;ruleMatches:boolean;
}):boolean{
  return input.wasRunning===true && input.wasArmed===true &&
    input.initialKillSwitch===false && input.ownerInterrupted===false &&
    input.ruleEnabled===true && input.ruleMatches===true;
}

async function read(owner:string):Promise<Row|null>{
 const r=await pool.query(`SELECT m.execution_account_id,m.owner_user_id::text,m.rule_id::text,m.rule_revision,
 m.cycle,m.state,m.was_running,m.was_armed,m.initial_kill_switch,m.operator_interrupted,
 m.transfer_id::text,m.last_reason,m.changed_at
 FROM ${M} m JOIN v13_production_account a
 ON a.id=m.execution_account_id AND a.owner_user_id=m.owner_user_id
 WHERE m.owner_user_id=$1::uuid`,[owner]);
 if(r.rows.length>1)throw Error("maintenance_owner_ambiguous");
 return r.rows[0]??null;
}
export async function readAutoWithdrawalMaintenance(owner:string):Promise<MaintenanceView>{
 try{const m=await read(owner);return {
  phase:(txt(m?.state)??"idle") as MaintenancePhase,reason:txt(m?.last_reason)??"none",
  cycle:Number(m?.cycle??0),wasRunning:m?.was_running===true,wasArmed:m?.was_armed===true,
  interrupted:m?.operator_interrupted===true,transferId:txt(m?.transfer_id),
  changedAt:m?.changed_at instanceof Date?m.changed_at.toISOString():txt(m?.changed_at),
 };}catch{return {phase:"blocked",reason:"maintenance_database_unavailable",cycle:0,
   wasRunning:false,wasArmed:false,interrupted:false,transferId:null,changedAt:null};}
}
async function change(owner:string,state:MaintenancePhase,reason:string,expected?:MaintenancePhase):Promise<boolean>{
 const q=await pool.query(`UPDATE ${M}
 SET state=$2,last_reason=$3,changed_at=now(),
 completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END
 WHERE owner_user_id=$1::uuid AND ($4::text IS NULL OR state=$4)
 RETURNING execution_account_id`,[owner,state,reason,expected??null]);
 return q.rows.length===1;
}
async function flat(owner:string,account:string):Promise<boolean>{
 const q=await pool.query(`SELECT a.id FROM v13_production_account a
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.reserved_micros=0
 AND a.cash_precision_verified=true
 AND NOT EXISTS(SELECT 1 FROM v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths>0)
 AND NOT EXISTS(SELECT 1 FROM v13_production_intent i WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED'))
 AND NOT EXISTS(SELECT 1 FROM private.kalshi_account_worker_lease l
 WHERE l.execution_account_id=a.id AND (l.state='owned' OR l.arm_requested=true))`,[account,owner]);
 return q.rows.length===1 && !personalTradingSession.isScheduled(owner,account);
}
async function initialize(owner:string,rule:AutoRule):Promise<string>{
 if(!rule.id||!rule.enabled)return "auto_rule_disabled";
 const cash=await observeAutomaticSweepCash(owner);
 if(!cash)return "auto_scoped_cash_unavailable";
 const prior=await read(owner);
 if(prior && prior.state!=="completed")return "maintenance_active";
 if(rule.latched){
  if(cash.botCashCents<rule.thresholdCents && rule.lastAttemptId){
   const transfer=await pool.query(`SELECT state FROM ${W} WHERE owner_user_id=$1::uuid AND id=$2::uuid`,[owner,rule.lastAttemptId]);
   if(transfer.rows[0]?.state==="completed")
    await pool.query(`UPDATE ${R} SET latched=false,last_observed_below_at=now(),updated_at=now()
     WHERE owner_user_id=$1::uuid AND id=$2::uuid AND enabled=true AND revision=$3 AND latched=true`,
     [owner,rule.id,rule.revision]);
  }
  return "auto_waiting_for_new_threshold_crossing";
 }
 if(cash.botCashCents<rule.thresholdCents)return "auto_below_threshold";
 if(!cash.cashPrecisionVerified)return "auto_cash_precision_unverified";
 // Do not pause a running strategy when the requested sweep exceeds the
 // owner's actual withdrawable cash after preserving verified starting capital.
 const requiredFloor=Math.max(cash.initialCapitalCents,rule.minimumRetainedCents);
 if(cash.botCashCents-rule.withdrawCents<requiredFloor)
   return "auto_threshold_reached_but_safe_cash_insufficient";
 const running=personalTradingSession.isScheduled(owner,cash.accountId);
 const armed=cash.executionEnabled && !cash.killSwitch;
 const q=await pool.query(`INSERT INTO ${M}
 (execution_account_id,owner_user_id,rule_id,rule_revision,state,was_running,was_armed,initial_kill_switch,last_reason)
 SELECT a.id,$2::uuid,$3::uuid,$4,'pause_requested',$5,$6,$7,'threshold_reached'
 FROM v13_production_account a WHERE a.id=$1 AND a.owner_user_id=$2::uuid
 AND NOT EXISTS(SELECT 1 FROM ${W} w WHERE w.execution_account_id=a.id AND w.state IN ('prepared','attempted','pending','uncertain'))
 AND EXISTS(SELECT 1 FROM ${R} r WHERE r.id=$3::uuid AND r.owner_user_id=$2::uuid
   AND r.enabled=true AND NOT r.latched AND r.revision=$4)
 ON CONFLICT(execution_account_id) DO UPDATE SET
 rule_id=EXCLUDED.rule_id,rule_revision=EXCLUDED.rule_revision,cycle=${M}.cycle+1,
 state='pause_requested',was_running=EXCLUDED.was_running,was_armed=EXCLUDED.was_armed,
 initial_kill_switch=EXCLUDED.initial_kill_switch,operator_interrupted=false,
 transfer_id=NULL,last_reason='threshold_reached',started_at=now(),changed_at=now(),completed_at=NULL
 WHERE ${M}.state='completed' RETURNING execution_account_id`,
 [cash.accountId,owner,rule.id,rule.revision,running,armed,cash.killSwitch]);
 return q.rows.length===1?"maintenance_started":"maintenance_conflict";
}
async function pause(owner:string,m:Row):Promise<string>{
 const id=txt(m.execution_account_id);
 if(!id)return "missing_execution_account";
 if(m.operator_interrupted===true){await change(owner,"blocked","owner_interrupted");return "owner_interrupted";}
 if(m.was_running===true){
  const stop=await personalTradingSession.stop({userId:owner,accountId:id,action:"STOP"});
  if(!stop.workerStopped || stop.managingExposure){
   await change(owner,"waiting_flat","protective_exits_still_managed");
   return "waiting_for_protective_exits";
  }
 }
 if(!await flat(owner,id)){
  await change(owner,"waiting_flat","positions_orders_or_worker_unresolved");
  return "waiting_for_flat_account";
 }
 await change(owner,"ready_to_transfer","worker_stopped_cash_sweep_ready");
 return "auto_stopped_and_flat";
}
async function submit(owner:string,m:Row,rule:AutoRule):Promise<string>{
 if(m.operator_interrupted===true || !rule.enabled || m.rule_id!==rule.id ||
    Number(m.rule_revision)!==rule.revision){
  await change(owner,"blocked","auto_rule_or_owner_changed");
  return "auto_rule_or_owner_changed";
 }
 const observed=await observeAutomaticSweepCash(owner);
 if(!observed || observed.botCashCents<rule.thresholdCents)return "threshold_not_verified";
 const avail=await sweepAvailability(owner,rule.minimumRetainedCents,undefined,"automatic");
 if(!avail.ok || avail.maximumCents===null || avail.maximumCents<rule.withdrawCents)
  return "waiting_for_safe_excess_cash";
 const quote=await quoteManualSweep(owner,
  {amountCents:rule.withdrawCents,minimumRetainedCents:rule.minimumRetainedCents},undefined,"automatic");
 if(!quote.ok||!quote.id)return "quote_failed";
 const db=await pool.connect();let claimed=false;
 try{
  await db.query("BEGIN");
  const ruleRow=await db.query(`UPDATE ${R} SET latched=true,last_attempt_id=$4::uuid,
   last_triggered_at=now(),updated_at=now()
   WHERE id=$1::uuid AND owner_user_id=$2::uuid AND enabled=true AND revision=$3
   AND latched=false AND withdraw_cents=$5 AND retain_cents=$6 RETURNING id`,
   [rule.id,owner,rule.revision,quote.id,rule.withdrawCents,rule.minimumRetainedCents]);
  if(ruleRow.rows.length!==1){await db.query("ROLLBACK");return "rule_changed";}
  const ledger=await db.query(`UPDATE ${W} SET origin='automatic',auto_rule_id=$3::uuid,
   auto_rule_revision=$4 WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='prepared'
   RETURNING id`,[quote.id,owner,rule.id,rule.revision]);
  if(ledger.rows.length!==1){await db.query("ROLLBACK");return "quote_changed";}
  const maintenance=await db.query(`UPDATE ${M} SET state='reconciling',transfer_id=$3::uuid,
   last_reason='transfer_claim_persisted',changed_at=now()
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND state='ready_to_transfer'
     AND rule_id=$4::uuid AND rule_revision=$5 AND operator_interrupted=false RETURNING execution_account_id`,
   [owner,m.execution_account_id,quote.id,rule.id,rule.revision]);
  if(maintenance.rows.length!==1){await db.query("ROLLBACK");return "maintenance_changed";}
  await db.query("COMMIT");claimed=true;
 }catch{await db.query("ROLLBACK").catch(()=>null);}
 finally{db.release();}
 if(!claimed)return "auto_claim_not_persisted";
 const result=await confirmManualSweep(owner,{quoteId:quote.id,confirmation:CASHIER_SWEEP_CONFIRMATION},
  undefined,undefined,true);
 return result.reason;
}
async function reconcile(owner:string,m:Row):Promise<string>{
 const id=txt(m.transfer_id);
 if(!id){await change(owner,"blocked","missing_transfer_id");return "manual_review_missing_transfer_id";}
 const result=await reconcileManualSweep(owner,id);
 if(result.state==="completed" && result.ok){
  await change(owner,"resume_requested","cashier_receipt_and_balances_verified","reconciling");
  return "receipt_verified";
 }
 if(result.reason==="transfer_unconfirmed_manual_review_required"){
  await change(owner,"blocked","uncertain_transfer_no_automatic_retry");
  return "manual_review_uncertain_transfer";
 }
 return result.reason;
}
async function resume(owner:string,m:Row,rule:AutoRule):Promise<string>{
 if(m.operator_interrupted===true){await change(owner,"blocked","owner_interrupted");return "owner_interrupted";}
 const cash=await reconcileOwnedSubaccountCash(pool,{
  ownerUserId:owner,confirmation:RECORD_OWNED_CASH_CONFIRMATION,nowMs:Date.now(),
 });
 if(!cash.ok)return "post_transfer_cash_reconciliation_pending";
 const canRestart=automaticResumeAuthorized({
  wasRunning:m.was_running===true,wasArmed:m.was_armed===true,
  initialKillSwitch:m.initial_kill_switch!==false,
  ownerInterrupted:m.operator_interrupted!==false,ruleEnabled:rule.enabled,
  ruleMatches:m.rule_id===rule.id && Number(m.rule_revision)===rule.revision,
 });
 if(!await change(owner,"completed","verified_auto_withdrawal","resume_requested"))return "maintenance_changed";
 if(!canRestart)return "auto_completed_bot_remains_stopped";
 const result=await personalTradingControls.control(owner,"START");
 if(!result.ok){
  await change(owner,"blocked","restart_refused_by_safety","completed");
  return "auto_restart_refused";
 }
 return "auto_transfer_completed_and_bot_restarted";
}
export async function processAutoWithdrawalMaintenance(owner:string,rule:AutoRule):Promise<string>{
 let m=await read(owner);
 if(!m || m.state==="completed"){
  const status=await initialize(owner,rule);
  if(status!=="maintenance_started")return status;
  m=await read(owner);
 }
 if(!m)return "maintenance_missing";
 switch(m.state){
  case "pause_requested":
  case "waiting_flat":return pause(owner,m);
  case "ready_to_transfer":return submit(owner,m,rule);
  case "reconciling":return reconcile(owner,m);
  case "resume_requested":return resume(owner,m,rule);
  case "blocked":return "maintenance_blocked_manual_review";
  default:return "maintenance_state_invalid";
 }
}
