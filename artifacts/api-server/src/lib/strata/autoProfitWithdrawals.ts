import { pool } from "@workspace/db";
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
 `UPDATE ${R} SET trigger_cents=$3,withdraw_cents=$4,retain_cents=$5,enabled=$6,revision=revision+1,latched=CASE WHEN $6 THEN false ELSE latched END,updated_at=now() WHERE owner_user_id=$1::uuid AND execution_account_id=$2 RETURNING id::text,enabled,trigger_cents,withdraw_cents,retain_cents,revision,latched,last_attempt_id::text`:
 `INSERT INTO ${R}(owner_user_id,execution_account_id,trigger_cents,withdraw_cents,retain_cents,enabled) VALUES($1::uuid,$2,$3,$4,$5,$6) RETURNING id::text,enabled,trigger_cents,withdraw_cents,retain_cents,revision,latched,last_attempt_id::text`;
 const next=await db.query(sql,[owner,id,t,w,k,v.enabled]);await db.query("COMMIT");return make(next.rows[0]!,"rule_saved");
 }catch{await db.query("ROLLBACK").catch(()=>undefined);return make(null,"save_failed",false);}finally{db.release();}
}
export async function processAutoRule(owner:string):Promise<string>{
 if(!live())return "money_movement_disabled";
 const r=await readAutoRule(owner);if(!r.ok||!r.enabled||!r.id)return "rule_disabled";
 if(r.lastAttemptId){const last=await pool.query(`SELECT state,origin FROM ${W} WHERE id=$1::uuid AND owner_user_id=$2::uuid`,[r.lastAttemptId,owner]);
 const row=last.rows[0];if(row?.origin==="automatic"&&["pending","attempted","uncertain"].includes(String(row.state))){await reconcileManualSweep(owner,r.lastAttemptId);return "previous_attempt_reconciling";}
 if(r.latched&&row?.state!=="completed")return "previous_attempt_unresolved";}
 const a=await sweepAvailability(owner,r.minimumRetainedCents);
 if(!a.ok||a.botCashCents===null||a.maximumCents===null)return "waiting_for_safe_stopped_bot";
 if(r.latched){if(a.botCashCents<r.thresholdCents){await pool.query(`UPDATE ${R} SET latched=false,updated_at=now(),last_observed_below_at=now() WHERE id=$1::uuid AND owner_user_id=$2::uuid AND revision=$3 AND enabled=true`,[r.id,owner,r.revision]);return "rearmed";}return "awaiting_next_crossing";}
 if(a.botCashCents<r.thresholdCents)return "below_threshold";
 if(a.maximumCents<r.withdrawCents)return "insufficient_excess_cash";
 const quote=await quoteManualSweep(owner,{amountCents:r.withdrawCents,minimumRetainedCents:r.minimumRetainedCents});if(!quote.ok||!quote.id)return "quote_unavailable";
 const db=await pool.connect();let authorized=false;
 try{await db.query("BEGIN");
 const rule=await db.query(`UPDATE ${R} SET latched=true,last_attempt_id=$4::uuid,last_triggered_at=now(),updated_at=now() WHERE id=$1::uuid AND owner_user_id=$2::uuid AND revision=$3 AND enabled=true AND latched=false AND trigger_cents<=$5 AND withdraw_cents=$6 AND retain_cents=$7 RETURNING id`,[r.id,owner,r.revision,quote.id,a.botCashCents,r.withdrawCents,r.minimumRetainedCents]);
 if(rule.rows.length!==1){await db.query("ROLLBACK");return "rule_changed";}
 const ledger=await db.query(`UPDATE ${W} SET origin='automatic',auto_rule_id=$3::uuid,auto_rule_revision=$4 WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='prepared' RETURNING id`,[quote.id,owner,r.id,r.revision]);
 if(ledger.rows.length!==1){await db.query("ROLLBACK");return "quote_changed";}
 await db.query("COMMIT");authorized=true;
 }catch{await db.query("ROLLBACK").catch(()=>undefined);}finally{db.release();}
 if(!authorized)return "authorization_failed";
 const result=await confirmManualSweep(owner,{quoteId:quote.id,confirmation:CASHIER_SWEEP_CONFIRMATION},undefined,undefined,true);
 return result.reason;
}
export function startAutoSweepWorker():void{
 if(process.env.NODE_ENV!=="production"||process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED!=="true")return;
 let running=false;
 const tick=async()=>{if(running||!live())return;running=true;const db=await pool.connect().catch(()=>null);if(!db){running=false;return;}
 let lock=false;try{const l=await db.query("SELECT pg_try_advisory_lock(619811017) AS locked");lock=l.rows[0]?.locked===true;if(!lock)return;
 const owners=await db.query(`SELECT owner_user_id::text AS owner FROM ${R} WHERE enabled=true ORDER BY updated_at LIMIT 40`);
 for(const row of owners.rows)if(typeof row.owner==="string"){try{await processAutoRule(row.owner);}catch{}}
 }catch{}finally{if(lock)await db.query("SELECT pg_advisory_unlock(619811017)").catch(()=>undefined);db.release();running=false;}};
 const handle=setInterval(()=>void tick(),60000);handle.unref();void tick();
}
