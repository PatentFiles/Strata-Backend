import {createHash,randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {dedicatedSignerFingerprint} from "./commissioning";
import {inspectOwnedEmergencyExitRead} from "./ownerFeeEmergencyExitRead";
import type {EmergencyExitOrder,EmergencyExitDecision} from "./ownerFeeEmergencyExit";

/**
 * Durable ADVISORY exit reservation. No transport, no signing, no order POST.
 * Cannot override global/account kills, owner authentication or an expired
 * source grant for actual orders. A future independently approved dispatcher
 * must separately revalidate and reconcile a one-time order.
 */
type Client={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;release():void};
type DB={connect():Promise<Client>};
export type ExitReservationResult={
  ok:false;reason:string;tradingAuthorized:false;reservationPrepared:boolean;
  clientOrderId?:string;reservationId?:string;
};
const deny=(reason:string):ExitReservationResult=>({
  ok:false,reason,tradingAuthorized:false,reservationPrepared:false,
});
export type ExitWorkerLease={
  holderId:string;
  fencingToken:number;
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLIENT=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/**
 * IMPORTANT: this helper is not a live recovery route. Future invocation
 * needs an authenticated owner context and vault-scoped credential, NOT inputs
 * from an arbitrary HTTP request.
 */
export async function reserveOwnedEmergencyExitProof(
  ownerId:string,accountId:string,
  material:{keyId:string;privateKey:string},
  order:EmergencyExitOrder,lease:ExitWorkerLease,
  deps:{
    inspect?:typeof inspectOwnedEmergencyExitRead;
    signerFingerprint?:typeof dedicatedSignerFingerprint;
    db?:DB;
    now?:()=>number;
  }={},
):Promise<ExitReservationResult>{
  if(!UUID.test(ownerId)||!ACCOUNT.test(accountId)||
     !lease||typeof lease.holderId!=="string"||
     !/^[A-Za-z0-9._:-]{1,128}$/.test(lease.holderId)||
     !Number.isSafeInteger(lease.fencingToken)||lease.fencingToken<1)
    return deny("emergency_exit_lease_unverified");
  const inspected:EmergencyExitDecision=await
    (deps.inspect??inspectOwnedEmergencyExitRead)(ownerId,accountId,material,order);
  if(inspected.diagnosticEligible!==true||inspected.tradingAuthorized!==false)
    return deny(inspected.reason);
  if(typeof order.client_order_id!=="string"||!CLIENT.test(order.client_order_id)||
     typeof order.ticker!=="string"||
     typeof order.count!=="string"||
     !/^\d{1,9}\.\d{2}$/.test(order.count)||
     (order.side!=="bid"&&order.side!=="ask"))
    return deny("emergency_exit_request_unverified");
  const baseline=inspected.verifiedPositionFp;
  const observed=inspected.verifiedPositionObservedAtMs;
  const now=(deps.now??Date.now)();
  if(typeof baseline!=="string"||!/(^-?[0-9]{1,9}\.[0-9]{2}$)/.test(baseline)||
     !Number.isSafeInteger(observed)||observed!>now||now-observed!>3000||
     !Number.isSafeInteger(now)||now<=0)
    return deny("emergency_exit_verified_baseline_unavailable");
  if((order.side==="ask"&&baseline.startsWith("-"))||
     (order.side==="bid"&&!baseline.startsWith("-")))
    return deny("emergency_exit_verified_baseline_wrong_side");
  const [whole,fraction]=order.count.split(".");
  const quantity=BigInt(whole!)*100n+BigInt(fraction!);
  if(quantity<=0n)return deny("emergency_exit_request_unverified");
  const value=baseline.startsWith("-")?baseline.slice(1):baseline;
  const [posWhole,posFraction]=value.split(".");
  const position=BigInt(posWhole!)*100n+BigInt(posFraction!);
  if(position<quantity)return deny("emergency_exit_verified_baseline_exceeds_inventory");
  const side=order.side==="ask"?"YES":"NO";
  const fingerprint=(deps.signerFingerprint??dedicatedSignerFingerprint)(material.keyId,material.privateKey);
  if(!fingerprint||!/^[a-f0-9]{64}$/.test(fingerprint))
    return deny("emergency_exit_signer_unverified");
  const orderRequestJson=JSON.stringify(order);
  // The exact serialized bytes are immutable and are required after a crash.
  const bodyHash=createHash("sha256").update(orderRequestJson).digest("hex");
  const reservationId=randomUUID();
  let client:Client|null=null,committed=false;
  try{
    client=await (deps.db??(pool as unknown as DB)).connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='750ms'");
    await client.query("SET LOCAL statement_timeout='5000ms'");
    // Match ledger reconciliation/dispatch lock order. A stale preparation
    // callback must not create a private marker after financial cleanup.
    const accountLock=await client.query("SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE",[accountId,ownerId]);
    if(accountLock.rows.length!==1)return deny("emergency_exit_worker_or_position_lock_unavailable");
    // The active, freshly heartbeating worker lease and existing position
    // are locked together before any reservation can be prepared.
    const locked=await client.query(
      "SELECT a.id FROM public.v13_production_account a " +
      "JOIN private.kalshi_account_worker_lease w " +
      "ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id " +
      "JOIN public.v13_production_position pos " +
      "ON pos.account_id=a.id AND pos.market=$3::text AND pos.side=$4::text " +
      "JOIN public.v13_production_intent fi ON fi.account_id=a.id AND fi.parent_id=pos.id " +
      "AND fi.client_order_id=$9::text AND fi.kind='EXIT' AND fi.state='PREPARED' " +
      "AND fi.terminal=false AND fi.dispatch_at IS NULL AND fi.exchange_order_id IS NULL " +
      "AND fi.filled_hundredths=0 AND fi.request->>'action'='SELL' AND fi.request->>'reduceOnly'='true' " +
      "AND fi.request->>'timeInForce'='IOC' AND fi.request->>'market'=$3::text " +
      "AND fi.request->>'side'=$4::text AND fi.request->>'clientOrderId'=$9::text " +
      "AND private.strata_exit_request_quantity_hundredths(fi.request)=$6::bigint " +
      "AND (fi.request->>'limitMicros')::integer=$10::integer " +
      "JOIN public.live_execution_config g ON g.id='singleton' " +
      "WHERE a.id=$1::text AND a.owner_user_id=$2::uuid " +
      "AND a.subaccount=1 AND a.exchange_index=2 " +
      "AND a.key_fingerprint=$5::text AND a.commissioned=true " +
      "AND a.kill_switch=false AND a.execution_enabled=true " +
      "AND g.live_execution_enabled=true AND g.manual_kill_switch=false " +
      "AND pos.quantity_hundredths >= $6::bigint " +
      "AND w.state='owned' AND w.account_kill=false " +
      "AND w.credential_fingerprint=$5::text " +
      "AND w.holder_id=$7::text AND w.fencing_token=$8::bigint " +
      "AND w.heartbeat_at > now()-interval '5 seconds' " +
      "AND NOT EXISTS (SELECT 1 FROM public.v13_production_intent i " +
      "WHERE i.account_id=a.id AND " +
      "(i.state IN ('DISPATCHED','UNKNOWN') OR " +
      "(i.terminal=false AND i.exchange_order_id IS NOT NULL))) " +
      "FOR UPDATE OF a,w,pos,fi",
      [accountId,ownerId,order.ticker,side,fingerprint,quantity.toString(),
       lease.holderId,lease.fencingToken,order.client_order_id,
       order.side==="ask"?Number(String(order.price).slice(2))*100:1_000_000-Number(String(order.price).slice(2))*100],
    );
    if(locked.rows.length!==1)return deny("emergency_exit_worker_or_position_lock_unavailable");
    // UNIQUE(client_order_id) and partial UNIQUE(account,market) prohibit
    // concurrent unresolved reservations across restarts and workers.
    const inserted=await client.query(
      "INSERT INTO private.strata_emergency_exit_reservations (" +
      "reservation_id,owner_user_id,execution_account_id,market_ticker," +
      "client_order_id,reducing_side,quantity_hundredths,order_digest," +
      "worker_fencing_token,worker_holder_id,initial_position_fp,position_observed_at_ms,order_request_json,trading_authorized,state) " +
      "VALUES ($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text," +
      "$7::bigint,$8::text,$9::bigint,$10::text,$11::text,$12::bigint,$13::text,false,'PREPARED') " +
      "ON CONFLICT DO NOTHING RETURNING reservation_id",
      [reservationId,ownerId,accountId,order.ticker,order.client_order_id,
       side,quantity.toString(),bodyHash,lease.fencingToken,lease.holderId,baseline,observed,orderRequestJson],
    );
    if(inserted.rows.length!==1)return deny("emergency_exit_duplicate_or_unresolved_reservation");
    await client.query("COMMIT");committed=true;
    // A committed reservation is NOT an order, nor permission to transmit one.
    return {ok:false,reason:"emergency_exit_reserved_dispatch_still_disabled",
      tradingAuthorized:false,reservationPrepared:true,clientOrderId:order.client_order_id,reservationId};
  }catch{
    return deny("emergency_exit_reservation_unavailable");
  }finally{
    if(client){
      if(!committed){try{await client.query("ROLLBACK");}catch{}}
      client.release();
    }
  }
}
