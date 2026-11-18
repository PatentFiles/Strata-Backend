import { HEARTBEAT_LEASE_SQL } from "./accountScopedExecution";

// Only for a caller-owned transaction. UPDATE retains the lease row lock until
// that caller commits/rolls back, so a subsequent SELECT cannot see a newer
// STOP/KILL/holder state. The ordinary pool heartbeat must retain its reread.
export const TRANSACTIONAL_HEARTBEAT_SQL = HEARTBEAT_LEASE_SQL.replace(
  "RETURNING fencing_token::text AS fencing_token",
  "RETURNING fencing_token::text AS fencing_token, arm_requested, account_kill, state",
);
export async function heartbeatLeaseInTransaction(
  db: {query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>},
  input: {executionAccountId:string;ownerUserId:string;holderId:string;fencingToken:number;fingerprint:string;now:string},
):Promise<{ok:true;armRequested:boolean}|{ok:false;reason:string}> {
  try {
    const beat=await db.query(TRANSACTIONAL_HEARTBEAT_SQL,[input.executionAccountId,input.ownerUserId,input.now,input.holderId,input.fencingToken,input.fingerprint]);
    if(beat.rows.length!==1)return {ok:false,reason:"stale_worker_fence"};
    const row=beat.rows[0];
    if(!row||row.state!=="owned"||row.account_kill===true)return {ok:false,reason:"stale_worker_fence"};
    return {ok:true,armRequested:row.arm_requested===true||row.arm_requested==="t"||row.arm_requested==="true"};
  }catch{return {ok:false,reason:"stale_worker_fence"};}
}
