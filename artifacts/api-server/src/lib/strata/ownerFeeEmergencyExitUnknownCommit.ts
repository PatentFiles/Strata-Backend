import {createHash} from "node:crypto";
import {pool} from "@workspace/db";
import {dedicatedSignerFingerprint} from "./commissioning";
import {inspectOwnedEmergencyExitRead} from "./ownerFeeEmergencyExitRead";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {ExitWorkerLease} from "./ownerFeeEmergencyExitReserve";

/**
 * OFFLINE REVIEW STAGE: atomically consume a PREPARED emergency-exit reservation
 * into UNKNOWN before a future dispatcher would attempt any exchange POST.
 * This function NEVER signs, dispatches, supplies transport authority, or
 * permits a retry. A genuine dispatcher needs separate security approval,
 * live fee/position verification at its final fence and tested reconciliation.
 *
 * UNKNOWN means "possibly submitted" after any process crash, regardless of
 * whether a network call actually occurred. There is intentionally no reset
 * from UNKNOWN to PREPARED.
 */
type Client={
  query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
  release():void;
};
type DB={connect():Promise<Client>};
export type ExitUnknownCommitResult={
  ok:false;
  tradingAuthorized:false;
  transportAuthorized:false;
  mayRetry:false;
  /** The UNKNOWN marker is durable only after a successful COMMIT acknowledgement. */
  unknownRecorded:boolean;
  reason:string;
  clientOrderId?:string;
};
const deny=(reason:string):ExitUnknownCommitResult=>({
  ok:false,tradingAuthorized:false,transportAuthorized:false,
  mayRetry:false,unknownRecorded:false,reason,
});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLIENT_ID=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const QUANTITY=/^\d{1,9}\.\d{2}$/;
const PRICE=/^0\.(?!0000)\d{4}$/;
const HOLDER=/^[A-Za-z0-9._:-]{1,128}$/;
function hundredths(x:string):bigint {
  const [whole,fraction]=x.split(".");
  return BigInt(whole!)*100n+BigInt(fraction!);
}

/**
 * Reservation/owner/lease identity must come from trusted server context,
 * not a public JSON body. Even successful marking does not permit transport.
 */
export async function markOwnedEmergencyExitUnknownForReview(
  ownerId:string,accountId:string,reservationId:string,
  material:{keyId:string;privateKey:string},
  order:EmergencyExitOrder,lease:ExitWorkerLease,
  deps:{
    inspect?:typeof inspectOwnedEmergencyExitRead;
    signerFingerprint?:typeof dedicatedSignerFingerprint;
    db?:DB;
    now?:()=>number;
  }={},
):Promise<ExitUnknownCommitResult> {
  if(!UUID.test(ownerId)||!ACCOUNT.test(accountId)||!UUID.test(reservationId)||
     !lease||!HOLDER.test(lease.holderId)||
     !Number.isSafeInteger(lease.fencingToken)||lease.fencingToken<1)
    return deny("emergency_exit_unknown_identity_or_lease_invalid");
  if(!order||!MARKET.test(String(order.ticker??""))||
     typeof order.client_order_id!=="string"||!CLIENT_ID.test(order.client_order_id)||
     typeof order.count!=="string"||!QUANTITY.test(order.count)||
     typeof order.price!=="string"||!PRICE.test(order.price)||
     !["ask","bid"].includes(String(order.side??""))||
     hundredths(order.count)<=0n||hundredths(order.count)>100000n||
     order.reduce_only!==true||order.time_in_force!=="immediate_or_cancel"||
     order.self_trade_prevention_type!=="taker_at_cross"||
     order.post_only!==false||order.subaccount!==1||order.exchange_index!==2)
    return deny("emergency_exit_unknown_order_unverified");
  let advisory;
  try {
    advisory=await (deps.inspect??inspectOwnedEmergencyExitRead)(
      ownerId,accountId,material,order,
    );
  }catch{
    return deny("emergency_exit_unknown_read_failed");
  }
  if(!advisory||advisory.diagnosticEligible!==true||
     advisory.tradingAuthorized!==false)
    return deny("emergency_exit_unknown_advisory_unverified");
  const baseline=advisory.verifiedPositionFp;
  const observed=advisory.verifiedPositionObservedAtMs;
  const at=(deps.now??Date.now)();
  if(typeof baseline!=="string"||!/(^-?[0-9]{1,9}\.[0-9]{2}$)/.test(baseline)||
     !Number.isSafeInteger(observed)||observed!>at||at-observed!>3000)
    return deny("emergency_exit_unknown_authenticated_baseline_unverified");
  const fingerprint=(deps.signerFingerprint??dedicatedSignerFingerprint)(
    material.keyId,material.privateKey,
  );
  if(!fingerprint||!/^[a-f0-9]{64}$/.test(fingerprint))
    return deny("emergency_exit_unknown_signer_unverified");
  const digest=createHash("sha256").update(JSON.stringify(order)).digest("hex");
  const direction=order.side==="ask"?"YES":"NO";
  const count=hundredths(order.count).toString();
  let client:Client|null=null,committed=false;
  try{
    client=await (deps.db??(pool as unknown as DB)).connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='750ms'");
    await client.query("SET LOCAL statement_timeout='5000ms'");
    // Same account-first order as reservation and reconciler cleanup. If
    // this marker wins, both rows become attempted and can never be expired.
    const accountLock=await client.query("SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE",[accountId,ownerId]);
    if(accountLock.rows.length!==1)return deny("emergency_exit_unknown_position_or_fence_unavailable");
    // All identities, kills, worker fence and live position are checked under
    // the SAME transaction as the PREPARED -> UNKNOWN transition.
    const eligible=await client.query(
      "SELECT r.reservation_id,r.client_order_id FROM private.strata_emergency_exit_reservations r " +
      "JOIN public.v13_production_account a ON a.id=r.execution_account_id " +
      "AND a.owner_user_id=r.owner_user_id " +
      "JOIN private.kalshi_account_worker_lease w " +
      "ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id " +
      "JOIN public.v13_production_position pos " +
      "ON pos.account_id=a.id AND pos.market=r.market_ticker AND pos.side=r.reducing_side " +
      "JOIN public.v13_production_intent fi " +
      "ON fi.account_id=a.id AND fi.parent_id=pos.id " +
      "AND fi.client_order_id=r.client_order_id AND fi.kind='EXIT' " +
      "AND fi.state='PREPARED' AND fi.terminal=false " +
      "JOIN public.live_execution_config g ON g.id='singleton' " +
      "WHERE r.reservation_id=$1::uuid AND r.owner_user_id=$2::uuid " +
      "AND r.execution_account_id=$3::text AND r.order_digest=$4::text " +
      "AND r.client_order_id=$5::text AND r.market_ticker=$6::text " +
      "AND r.reducing_side=$7::text AND r.quantity_hundredths=$8::bigint " +
      "AND r.worker_holder_id=$9::text AND r.worker_fencing_token=$10::bigint AND r.initial_position_fp=$12::text " +
      "AND r.state='PREPARED' AND r.trading_authorized=false " +
      "AND r.created_at > now()-interval '30 seconds' " +
      "AND a.subaccount=1 AND a.exchange_index=2 " +
      "AND a.key_fingerprint=$11::text AND a.commissioned=true " +
      "AND a.kill_switch=false AND a.execution_enabled=true " +
      "AND g.live_execution_enabled=true AND g.manual_kill_switch=false " +
      "AND pos.quantity_hundredths >= r.quantity_hundredths " +
      "AND fi.request->>'action'='SELL' AND fi.request->>'reduceOnly'='true' " +
      "AND fi.request->>'timeInForce'='IOC' AND fi.request->>'market'=r.market_ticker " +
      "AND fi.request->>'side'=r.reducing_side " +
      "AND fi.request->>'clientOrderId'=r.client_order_id " +
      "AND private.strata_exit_request_quantity_hundredths(fi.request)=r.quantity_hundredths " +
      "AND (fi.request->>'limitMicros')::integer=$13::integer " +
      "AND w.state='owned' AND w.account_kill=false " +
      "AND w.credential_fingerprint=$11::text " +
      "AND w.holder_id=$9::text AND w.fencing_token=$10::bigint " +
      "AND w.heartbeat_at > now()-interval '5 seconds' " +
      "AND NOT EXISTS (SELECT 1 FROM public.v13_production_intent i " +
      "WHERE i.account_id=a.id AND (i.state IN ('DISPATCHED','UNKNOWN') " +
      "OR (i.terminal=false AND i.exchange_order_id IS NOT NULL))) " +
      "FOR UPDATE OF r,a,w,pos,fi",
      [reservationId,ownerId,accountId,digest,order.client_order_id,
       order.ticker,direction,count,lease.holderId,lease.fencingToken,fingerprint,baseline,
       order.side==="ask"?Number((order.price as string).slice(2))*100:
        1_000_000-Number((order.price as string).slice(2))*100],
    );
    if(eligible.rows.length!==1)
      return deny("emergency_exit_unknown_position_or_fence_unavailable");
    // Only PREPARED can transition; two workers cannot consume the same row.
    const changed=await client.query(
      "UPDATE private.strata_emergency_exit_reservations SET " +
      "state='UNKNOWN',updated_at=now() " +
      "WHERE reservation_id=$1::uuid AND owner_user_id=$2::uuid " +
      "AND execution_account_id=$3::text AND order_digest=$4::text " +
      "AND client_order_id=$5::text AND initial_position_fp=$6::text AND state='PREPARED' " +
      "AND created_at > now()-interval '30 seconds' " +
      "AND trading_authorized=false " +
      "RETURNING reservation_id,client_order_id",
      [reservationId,ownerId,accountId,digest,order.client_order_id,baseline],
    );
    if(changed.rows.length!==1||
       changed.rows[0]!.reservation_id!==reservationId||
       changed.rows[0]!.client_order_id!==order.client_order_id)
      return deny("emergency_exit_unknown_transition_not_unique");
    // Both ledgers consume the SAME order identity atomically before any
    // signed POST; a crash never permits either pathway to resubmit.
    const financial=await client.query(
      "UPDATE public.v13_production_intent SET state='DISPATCHED',dispatch_at=now() " +
      "WHERE account_id=$1::text AND client_order_id=$2::text " +
      "AND parent_id IN (SELECT id FROM public.v13_production_position " +
      "WHERE account_id=$1::text AND market=$3::text AND side=$4::text) " +
      "AND kind='EXIT' AND state='PREPARED' AND terminal=false " +
      "RETURNING client_order_id",
      [accountId,order.client_order_id,order.ticker,direction],
    );
    if(financial.rows.length!==1||
       financial.rows[0]!.client_order_id!==order.client_order_id)
      return deny("emergency_exit_financial_intent_transition_not_unique");
    await client.query("COMMIT");committed=true;
    return {
      ...deny("emergency_exit_unknown_committed_no_transport_authority"),
      unknownRecorded:true,clientOrderId:order.client_order_id,
    };
  }catch{
    // A failed COMMIT acknowledgement can be ambiguous. Never try again.
    return deny("emergency_exit_unknown_persistence_unverified");
  }finally{
    if(client){
      if(!committed){try{await client.query("ROLLBACK");}catch{}}
      client.release();
    }
  }
}
