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
  clientOrderId?:string;
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
  const [whole,fraction]=order.count.split(".");
  const quantity=BigInt(whole!)*100n+BigInt(fraction!);
  if(quantity<=0n)return deny("emergency_exit_request_unverified");
  const side=order.side==="ask"?"YES":"NO";
  const fingerprint=(deps.signerFingerprint??dedicatedSignerFingerprint)(material.keyId,material.privateKey);
  if(!fingerprint||!/^[a-f0-9]{64}$/.test(fingerprint))
    return deny("emergency_exit_signer_unverified");
  const bodyHash=createHash("sha256").update(JSON.stringify(order)).digest("hex");
  let client:Client|null=null,committed=false;
  try{
    client=await (deps.db??(pool as unknown as DB)).connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='750ms'");
    await client.query("SET LOCAL statement_timeout='5000ms'");
    // The active, freshly heartbeating worker lease and existing position
    // are locked together before any reservation can be prepared.
    const locked=await client.query(
      "SELECT a.id FROM public.v13_production_account a " +
      "JOIN private.kalshi_account_worker_lease w " +
      "ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id " +
      "JOIN public.v13_production_position pos " +
      "ON pos.account_id=a.id AND pos.market=$3::text AND pos.side=$4::text " +
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
      "FOR UPDATE OF a,w,pos",
      [accountId,ownerId,order.ticker,side,fingerprint,quantity.toString(),
       lease.holderId,lease.fencingToken],
    );
    if(locked.rows.length!==1)return deny("emergency_exit_worker_or_position_lock_unavailable");
    // UNIQUE(client_order_id) and partial UNIQUE(account,market) prohibit
    // concurrent unresolved reservations across restarts and workers.
    const inserted=await client.query(
      "INSERT INTO private.strata_emergency_exit_reservations (" +
      "reservation_id,owner_user_id,execution_account_id,market_ticker," +
      "client_order_id,reducing_side,quantity_hundredths,order_digest," +
      "worker_fencing_token,worker_holder_id,trading_authorized,state) " +
      "VALUES ($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text," +
      "$7::bigint,$8::text,$9::bigint,$10::text,false,'PREPARED') " +
      "ON CONFLICT DO NOTHING RETURNING reservation_id",
      [randomUUID(),ownerId,accountId,order.ticker,order.client_order_id,
       side,quantity.toString(),bodyHash,lease.fencingToken,lease.holderId],
    );
    if(inserted.rows.length!==1)return deny("emergency_exit_duplicate_or_unresolved_reservation");
    await client.query("COMMIT");committed=true;
    // A committed reservation is NOT an order, nor permission to transmit one.
    return {ok:false,reason:"emergency_exit_reserved_dispatch_still_disabled",
      tradingAuthorized:false,reservationPrepared:true,clientOrderId:order.client_order_id};
  }catch{
    return deny("emergency_exit_reservation_unavailable");
  }finally{
    if(client){
      if(!committed){try{await client.query("ROLLBACK");}catch{}}
      client.release();
    }
  }
}
