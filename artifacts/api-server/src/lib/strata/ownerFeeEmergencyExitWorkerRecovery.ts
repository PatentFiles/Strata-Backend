import {createHash} from "node:crypto";
import {pool} from "@workspace/db";
import {reconcileUnknownProtectiveExitAfterRestart} from "./ownerFeeEmergencyExitRestartRecovery";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";

/** Trusted, account-scoped UNKNOWN recovery poll. NEVER posts an IOC.
 * The exact immutable body is re-read from the ledger and compared with its
 * reserved digest. Missing or corrupt bodies remain UNKNOWN: no synthesis,
 * no replay, no permission to continue making entries.
 */
type Db={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type Recover=typeof reconcileUnknownProtectiveExitAfterRestart;
export type ExitRecoveryPoll={ok:boolean;reason:string;attempted:number;mayRetry:false;postAttempted:false};
const blocked=(reason:string):ExitRecoveryPoll=>({ok:false,reason,attempted:0,mayRetry:false,postAttempted:false});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLIENT=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
export async function reconcileOwnedProtectiveExits(input:{
  ownerId:string;accountId:string;material:{keyId:string;privateKey:string};
},db:Db=pool,deps:{recover?:Recover}={}):Promise<ExitRecoveryPoll>{
 const hosted=Boolean(process.env.RAILWAY_PROJECT_ID||process.env.RAILWAY_SERVICE_ID||process.env.RAILWAY_ENVIRONMENT_ID);
 if(deps.recover&&(process.env.NODE_ENV!=="test"||hosted))
  return blocked("protective_exit_test_recovery_forbidden");
 if(!UUID.test(input.ownerId)||!ACCOUNT.test(input.accountId)||!input.material.keyId||!input.material.privateKey)
  return blocked("protective_exit_recovery_identity_unverified");
 try{
  const rs=await db.query(
   "SELECT reservation_id::text AS reservation_id,market_ticker,client_order_id,"+
   "order_digest,order_request_json FROM private.strata_emergency_exit_reservations "+
   "WHERE owner_user_id=$1::uuid AND execution_account_id=$2::text "+
   "AND state='UNKNOWN' ORDER BY created_at,reservation_id LIMIT 2",
   [input.ownerId,input.accountId],
  );
  if(rs.rows.length===0)return {ok:true,reason:"no_unresolved_protective_exits",attempted:0,mayRetry:false,postAttempted:false};
  if(rs.rows.length!==1)return blocked("multiple_unknown_protective_exits_require_manual_review");
  const row=rs.rows[0]!;
  const rid=row.reservation_id;
  const raw=row.order_request_json;
  if(typeof rid!=="string"||!UUID.test(rid)||typeof raw!=="string"||raw.length>4096||
     typeof row.order_digest!=="string"||!SHA.test(row.order_digest))
   return blocked("exit_recovery_persisted_request_missing");
  const digest=createHash("sha256").update(raw).digest("hex");
  if(digest!==row.order_digest)return blocked("exit_recovery_persisted_request_digest_mismatch");
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{return blocked("exit_recovery_persisted_request_invalid");}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))
   return blocked("exit_recovery_persisted_request_invalid");
  const order=parsed as Record<string,unknown>;
  if(order.client_order_id!==row.client_order_id||!CLIENT.test(String(order.client_order_id))||
     order.ticker!==row.market_ticker||
     order.reduce_only!==true||order.time_in_force!=="immediate_or_cancel"||
     order.post_only!==false||order.subaccount!==1||order.exchange_index!==2||
     !["ask","bid"].includes(String(order.side))||
     typeof order.count!=="string"||!/^[0-9]{1,9}\.[0-9]{2}$/.test(order.count)||
     typeof order.price!=="string"||!/^0\.[0-9]{4}$/.test(order.price))
   return blocked("exit_recovery_persisted_request_identity_mismatch");
  const outcome=await (deps.recover??reconcileUnknownProtectiveExitAfterRestart)({
   ownerId:input.ownerId,accountId:input.accountId,reservationId:rid,
   material:input.material,order:order as unknown as Readonly<EmergencyExitOrder>,
  });
  return {ok:outcome.state==="RECONCILED",
   reason:outcome.reason,attempted:1,mayRetry:false,postAttempted:false};
 }catch{
  return blocked("protective_exit_recovery_read_or_provider_unavailable");
 }
}
