import type {Snapshot} from "../v13-production/types";

/** Read-only continuation evidence, called only AFTER committed reconciliation.
 * It grants no authority, changes no intent, and never clears a sticky STOP.
 * Unknown submissions, open positions, and remaining reservations stay held.
 */
export async function reconciledFlatEntryEvidence(
 db:{query(sql:string,params:unknown[]):Promise<{rows:Record<string,unknown>[]}>},
 input:{accountId:string;ownerId:string;snapshot:Snapshot;nowMs:number},
):Promise<boolean>{
 try {
  const s=input.snapshot,age=input.nowMs-s.observedAtMs;
  if(!s.authenticated||!s.complete||!s.cashExact||s.unexplainedCashActivity||
    !Number.isFinite(age)||age<0||age>15_000||
    !Array.isArray(s.orders)||s.orders.some(o=>o.terminal!==true)||
    !Array.isArray(s.positions)||s.positions.some(p=>p.quantityHundredths!=="0"))return false;
  const result=await db.query(`-- personal-session:reconciled-flat-entry
    SELECT a.reserved_micros::text AS reserved_micros,a.cash_micros::text AS cash_micros,
      a.blocked_reason,a.kill_switch,a.execution_enabled,
      (SELECT count(*)::text FROM v13_production_intent i WHERE i.account_id=a.id
        AND (i.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR NOT i.terminal)) AS unresolved,
      (SELECT count(*)::text FROM private.strata_emergency_exit_reservations r
        WHERE r.execution_account_id=a.id AND r.state IN ('PREPARED','DISPATCHED','UNKNOWN')) AS exits,
      (SELECT count(*)::text FROM v13_production_position p WHERE p.account_id=a.id
        AND (p.quantity_hundredths<>0 OR p.basis_micros<>0)) AS positions
    FROM v13_production_account a WHERE a.id=$1 AND a.owner_user_id=$2::uuid`,
   [input.accountId,input.ownerId]);
  if(result.rows.length!==1)return false;
  const r=result.rows[0];
  return r.reserved_micros==="0"&&r.cash_micros===s.cashMicros&&
    r.blocked_reason===null&&r.kill_switch===false&&r.execution_enabled===true&&
    r.unresolved==="0"&&r.exits==="0"&&r.positions==="0";
 }catch{return false;}
}
