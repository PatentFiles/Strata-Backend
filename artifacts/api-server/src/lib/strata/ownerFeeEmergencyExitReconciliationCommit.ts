import {createHash} from "node:crypto";
import {pool} from "@workspace/db";
import {reconcileIocEmergencyExit,type IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
import {authenticatedProtectiveRecoveryFresh} from "./ownerFeeEmergencyExitAuthenticatedRecovery";

/**
 * Persist a proved IOC outcome without authorizing transport or another attempt.
 * A signed exchange read is required *before* this function. A DB transaction
 * pins the reservation, identity and immutable initial position, inserts the
 * single reconciliation audit row, and changes UNKNOWN -> RECONCILED atomically.
 * A crash or ambiguous commit leaves retry permanently forbidden.
 */
type DBClient={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;release(error?:Error|boolean):void};
type DB={connect():Promise<DBClient>};
export type ReconciliationCommit={
 committed:boolean;reason:string;mayRetry:false;tradingAuthorized:false;
 /** COMMITTED reports an acknowledged commit, even when its acknowledgment
  * arrived after expiry. UNKNOWN never claims that a rollback undid COMMIT. */
 commitState:"NOT_ATTEMPTED"|"UNKNOWN"|"COMMITTED";
 freshnessVerified:boolean;
};
const fail=(reason:string,commitState:"NOT_ATTEMPTED"|"UNKNOWN"="NOT_ATTEMPTED"):ReconciliationCommit=>
 ({committed:false,reason,commitState,freshnessVerified:false,mayRetry:false,tradingAuthorized:false});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const CLIENT=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function persistAuthenticatedExitReconciliation(
 input:{ownerId:string;accountId:string;reservationId:string;
  order:{ticker:unknown;client_order_id:unknown;count:unknown;side:unknown}},
 observation:IocRecoveryObservation,
 deps:{db?:DB}={},
):Promise<ReconciliationCommit>{
 input={...input,order:structuredClone(input.order)};
 const {ownerId,accountId,reservationId,order}=input;
 if(!UUID.test(ownerId)||!UUID.test(reservationId)||!MARKET.test(String(order.ticker??""))||
    !CLIENT.test(String(order.client_order_id??""))||
    typeof order.count!=="string"||!/^\d{1,9}\.\d{2}$/.test(order.count)||
    !["bid","ask"].includes(String(order.side??""))||
    observation.clientOrderId!==order.client_order_id||
    observation.marketTicker!==order.ticker||
    observation.requestedCountFp!==order.count||
    observation.reducingBookSide!==order.side)
  return fail("exit_reconcile_identity_not_verified");
 const result=reconcileIocEmergencyExit(observation);
 if(result.state!=="RECONCILED"||result.filledHundredths===undefined||
    result.remainingHundredths===undefined)
  return fail("exit_reconcile_history_unproven");
 const digest=createHash("sha256").update(JSON.stringify(observation)).digest("hex");
 const filled=result.filledHundredths,remaining=result.remainingHundredths;
 if(!authenticatedProtectiveRecoveryFresh(input,observation))
  return fail("exit_reconcile_freshness_unverified");
 const assertFresh=()=>{
  if(!authenticatedProtectiveRecoveryFresh(input,observation))throw Error("exit_reconcile_freshness_unverified");
 };
 let c:DBClient|null=null,committed=false,commitAttempted=false;
 try{
  c=await (deps.db??(pool as unknown as DB)).connect();
  assertFresh();
  await c.query("BEGIN");
  assertFresh();
  await c.query("SET LOCAL lock_timeout='750ms'");
  assertFresh();
  await c.query("SET LOCAL statement_timeout='5000ms'");
  assertFresh();
  const locked=await c.query(
   "SELECT r.reservation_id,r.initial_position_fp,r.quantity_hundredths,"+
   "r.reducing_side FROM private.strata_emergency_exit_reservations r "+
   "JOIN public.v13_production_account a ON a.id=r.execution_account_id "+
   "AND a.owner_user_id=r.owner_user_id "+
   "WHERE r.reservation_id=$1::uuid AND r.owner_user_id=$2::uuid "+
   "AND r.execution_account_id=$3::text AND r.client_order_id=$4::text "+
   "AND r.market_ticker=$5::text AND r.state='UNKNOWN' "+
   "AND a.subaccount=1 AND a.exchange_index=2 FOR UPDATE OF r",
   [reservationId,ownerId,accountId,order.client_order_id,order.ticker]);
  assertFresh();
  if(locked.rows.length!==1||locked.rows[0]!.reservation_id!==reservationId||
    locked.rows[0]!.initial_position_fp!==observation.initialPositionFp||
    String(locked.rows[0]!.quantity_hundredths)!==
      String(BigInt(order.count.split(".")[0]!)*100n+BigInt(order.count.split(".")[1]!))||
    locked.rows[0]!.reducing_side!==(order.side==="ask"?"YES":"NO"))
   return fail("exit_reconcile_persisted_baseline_changed");
  const inserted=await c.query(
   "INSERT INTO private.strata_protective_exit_reconciliations ("+
   "reservation_id,owner_user_id,execution_account_id,client_order_id,"+
   "market_ticker,evidence_sha256,filled_hundredths,remaining_hundredths,"+
   "observed_position_fp) VALUES "+
   "($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::bigint,$8::bigint,$9::text) "+
   "ON CONFLICT DO NOTHING RETURNING reservation_id",
   [reservationId,ownerId,accountId,order.client_order_id,order.ticker,
     digest,filled,remaining,observation.observedPositionFp]);
  assertFresh();
  if(inserted.rows.length!==1||inserted.rows[0]!.reservation_id!==reservationId)
   return fail("exit_reconcile_duplicate_or_ambiguous");
  const changed=await c.query(
    "UPDATE private.strata_emergency_exit_reservations SET state='RECONCILED',updated_at=now() "+
    "WHERE reservation_id=$1::uuid AND owner_user_id=$2::uuid "+
    "AND client_order_id=$3::text AND state='UNKNOWN' RETURNING reservation_id",
    [reservationId,ownerId,order.client_order_id]);
  assertFresh();
  if(changed.rows.length!==1||changed.rows[0]!.reservation_id!==reservationId)
   return fail("exit_reconcile_terminal_transition_not_unique");
  // This is a local admission deadline, not a guarantee about when PostgreSQL
  // commits or an acknowledgment arrives. Once attempted, never infer rollback.
  assertFresh();commitAttempted=true;
  await c.query("COMMIT");
  committed=true;
  const freshnessVerified=authenticatedProtectiveRecoveryFresh(input,observation);
  return {committed:true,commitState:"COMMITTED",freshnessVerified,
   reason:freshnessVerified?"exit_reconcile_durable_terminal":"exit_reconcile_committed_freshness_unverified",
   mayRetry:false,tradingAuthorized:false};
 }catch(error){
  if(committed)return {committed:true,commitState:"COMMITTED",freshnessVerified:false,
   reason:"exit_reconcile_committed_freshness_unverified",mayRetry:false,tradingAuthorized:false};
  return fail(error instanceof Error&&error.message==="exit_reconcile_freshness_unverified"
   ?error.message:"exit_reconcile_db_commit_unverified",commitAttempted?"UNKNOWN":"NOT_ATTEMPTED");
 }
 finally{
  if(c){
   // An unacknowledged rollback may leave staged changes on the connection.
   // Never return that client (or an uncertain COMMIT client) to the pool.
   let releaseError=commitAttempted&&!committed?Error("exit_reconcile_commit_unverified"):undefined;
   if(!committed){try{await c.query("ROLLBACK");}catch{releaseError=Error("exit_reconcile_rollback_unverified");}}
   try{c.release(releaseError);}catch{/* Cleanup cannot relabel an acknowledged commit. */}
  }
 }
}
