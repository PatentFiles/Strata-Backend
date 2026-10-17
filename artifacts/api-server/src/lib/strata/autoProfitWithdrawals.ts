import { pool } from "@workspace/db";
import { processAutoWithdrawalMaintenance } from "./autoWithdrawalMaintenance";
import { quoteManualSweep, confirmManualSweep, reconcileManualSweep, sweepAvailability, withdrawalTransfersEnabled, CASHIER_SWEEP_CONFIRMATION } from "./manualProfitWithdrawals";
export const AUTO_CONFIRMATION="ENABLE_AUTOMATIC_KALSHI_CASH_SWEEPS_FOR_MY_ACCOUNT";
const R="private.strata_auto_profit_withdrawal_rules", W="private.strata_manual_profit_withdrawals";
type Obj=Record<string,unknown>;
const cash=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<=1e11;
const live=()=>withdrawalTransfersEnabled()&&process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED==="true";
export type AutoRule={ok:boolean;reason:string;id:string|null;enabled:boolean;liveExecutionEnabled:boolean;thresholdCents:number;withdrawCents:number;minimumRetainedCents:number;revision:number;latched:boolean;lastAttemptId:string|null};
const make=(r:Obj|null,reason:string,ok=true):AutoRule=>({ok,reason,id:typeof r?.id==="string"?r.id:null,enabled:r?.enabled===true,liveExecutionEnabled:live(),thresholdCents:Number(r?.trigger_cents??100000),withdrawCents:Number(r?.withdraw_cents??75000),minimumRetainedCents:Number(r?.retain_cents??25000),revision:Number(r?.revision??0),latched:r?.latched===true,lastAttemptId:typeof r?.last_attempt_id==="string"?r.last_attempt_id:null});
const account="SELECT id FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2";
const read=`SELECT id::text,enabled,trigger_cents,withdraw_cents,retain_cents,revision,latched,last_attempt_id::text FROM ${R} WHERE owner_user_id=$1::uuid AND execution_account_id=$2`;
export async function readAutoRule(owner:string):Promise<AutoRule>{
 try{const a=await pool.query(account,[owner]);if(a.rows.length!==1)return make(null,"execution_account_unavailable",false);
 const r=await pool.query(read,[owner,a.rows[0]!.id]);return r.rows.length<=1?make(r.rows[0]??null,r.rows.length?"rule_loaded":"not_configured"):make(null,"ambiguous_rule",false);}
 catch{return make(null,"rule_unavailable",false);}
}
export async function saveAutoRule(owner:string,input:unknown):Promise<AutoRule>{
 if(!input||typeof input!=="object"||Array.isArray(input))return make(null,"invalid_rule",false);
 const v=input as Obj,t=v.thresholdCents,w=v.withdrawCents,k=v.minimumRetainedCents;
 if(!cash(t)||!cash(w)||!cash(k)||!cash(v.expectedRevision)||!t||!w||t<w+k||typeof v.enabled!=="boolean")return make(null,"invalid_values",false);
 if(v.enabled&&v.confirmation!==AUTO_CONFIRMATION)return make(null,"owner_authorization_required",false);
 const db=await pool.connect();
 try{await db.query("BEGIN");const a=await db.query(account,[owner]);if(a.rows.length!==1){await db.query("ROLLBACK");return make(null,"account_unavailable",false);}
 const id=a.rows[0]!.id;await db.query("SELECT id FROM v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE",[id,owner]);
 const old=await db.query(read+" FOR UPDATE",[owner,id]);if(old.rows.length>1||Number(old.rows[0]?.revision??0)!==v.expectedRevision){await db.query("ROLLBACK");return make(old.rows[0]??null,"revision_changed",false);}
 if(v.enabled){const busy=await db.query(`SELECT 1 FROM ${W} WHERE execution_account_id=$1 AND state IN ('prepared','attempted','pending','uncertain') LIMIT 1`,[id]);if(busy.rows.length){await db.query("ROLLBACK");return make(old.rows[0]??null,"withdrawal_unresolved",false);}}
 const sql=old.rows.length?
 `UPDATE ${R} SET trigger_cents=$3,withdraw_cents=$4,retain_cents=$5,enabled=$6,revision=revision+1,latched=latched,updated_at=now() WHERE owner_user_id=$1::uuid AND execution_account_id=$2 RETURNING id::text,enabled,trigger_cents,withdraw_cents,retain_cents,revision,latched,last_attempt_id::text`:
 `INSERT INTO ${R}(owner_user_id,execution_account_id,trigger_cents,withdraw_cents,retain_cents,enabled) VALUES($1::uuid,$2,$3,$4,$5,$6) RETURNING id::text,enabled,trigger_cents,withdraw_cents,retain_cents,revision,latched,last_attempt_id::text`;
 const next=await db.query(sql,[owner,id,t,w,k,v.enabled]);await db.query("COMMIT");return make(next.rows[0]!,"rule_saved");
 }catch{await db.query("ROLLBACK").catch(()=>undefined);return make(null,"save_failed",false);}finally{db.release();}
}
export async function processAutoRule(owner:string):Promise<string>{
 if(!live())return "money_movement_disabled";
 const rule=await readAutoRule(owner);
 if(!rule.ok || !rule.id)return "rule_unavailable";
 return processAutoWithdrawalMaintenance(owner,rule);
}
export function startAutoSweepWorker():void{
 if(process.env.NODE_ENV!=="production"||process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED!=="true")return;
 let running=false;
 const tick=async()=>{if(running||!live())return;running=true;const db=await pool.connect().catch(()=>null);if(!db){running=false;return;}
 let lock=false;try{const l=await db.query("SELECT pg_try_advisory_lock(619811017) AS locked");lock=l.rows[0]?.locked===true;if(!lock)return;
 const owners=await db.query(`SELECT owner FROM (
  SELECT owner_user_id::text AS owner,updated_at AS changed FROM ${R} WHERE enabled=true
  UNION
  SELECT owner_user_id::text AS owner,changed_at AS changed
  FROM private.strata_auto_withdrawal_maintenance
  WHERE state IN ('pause_requested','waiting_flat','ready_to_transfer','reconciling','resume_requested')
) pending ORDER BY changed LIMIT 40`);
 for(const row of owners.rows)if(typeof row.owner==="string"){try{await processAutoRule(row.owner);}catch{}}
 }catch{}finally{if(lock)await db.query("SELECT pg_advisory_unlock(619811017)").catch(()=>undefined);db.release();running=false;}};
 const handle=setInterval(()=>void tick(),60000);handle.unref();void tick();
}
