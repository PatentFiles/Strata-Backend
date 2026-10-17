/** DEMO-ONLY durable reservation/commit. No production execution linkage.
 * Backend caller MUST independently authenticate the demo account and
 * operator consent before preparing; there is deliberately no HTTP route.
 *
 * Uncertain COMMIT must remain blocked: never re-run unknown consumption
 * or infer that a transaction did not commit after connection failure.
 */
import {pool} from "@workspace/db";
import {randomUUID} from "node:crypto";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {DurableDemoUnknown} from "./kalshiDemoSignedIoc";

type Client={
  query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
  release():void;
};
type DB={
  connect():Promise<Client>;
  query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const CID=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const DEC=/^(0|[1-9]\d{0,8})\.\d{2}$/;
export type DemoLedgerIdentity={
  ownerId:string;
  demoAccountId:string;
  attemptId:string;
  operatorApprovalId:string;
  workerHolderId:string;
  workerFencingToken:number;
};
const valid=(p:DemoLedgerIdentity,order:Readonly<EmergencyExitOrder>,fp:string,feeFp:string)=>
  !!p && UUID.test(p.ownerId) && UUID.test(p.attemptId) &&
  UUID.test(p.operatorApprovalId) &&
  typeof p.demoAccountId==="string" &&
  /^[A-Za-z0-9._:-]{1,128}$/.test(p.demoAccountId) &&
  typeof p.workerHolderId==="string" &&
  /^[A-Za-z0-9._:-]{1,128}$/.test(p.workerHolderId) &&
  Number.isSafeInteger(p.workerFencingToken) && p.workerFencingToken>0 &&
  SHA.test(fp) && SHA.test(feeFp) &&
  typeof order.client_order_id==="string" && CID.test(order.client_order_id) &&
  typeof order.ticker==="string" && MARKET.test(order.ticker) &&
  (order.side==="bid" || order.side==="ask") &&
  typeof order.count==="string" && DEC.test(order.count) &&
  typeof order.price==="string" && /^0\.(?!0000)\d{4}$/.test(order.price) &&
  order.time_in_force==="immediate_or_cancel" && order.reduce_only===true &&
  order.post_only===false &&
  order.self_trade_prevention_type==="taker_at_cross" &&
  order.subaccount===1 && order.exchange_index===2 &&
  order.expiration_time===undefined;
function qty(s:string):bigint {
  const [a,b]=s.split(".");return BigInt(a!)*100n+BigInt(b!);
}
export async function prepareDemoIocOnce(input:{
  identity:DemoLedgerIdentity;
  order:Readonly<EmergencyExitOrder>;
  signerFingerprint:string;
  feeFingerprint:string;
  approvalExpiresAtMs:number;
  nowMs:number;
},db:DB=pool as unknown as DB):Promise<boolean>{
  const {identity,order,signerFingerprint,feeFingerprint,approvalExpiresAtMs,nowMs}=input;
  if(!valid(identity,order,signerFingerprint,feeFingerprint)||
     !Number.isSafeInteger(nowMs)||!Number.isSafeInteger(approvalExpiresAtMs)||
     approvalExpiresAtMs<=nowMs||approvalExpiresAtMs>nowMs+60_000||
     qty(order.count as string)<=0n||qty(order.count as string)>100000n)
    return false;
  try{
    const r=await db.query(
      "INSERT INTO private.strata_demo_ioc_attempt "+
      "(attempt_id,owner_user_id,demo_account_id,signer_fingerprint,"+
      "client_order_id,market_ticker,reducing_side,requested_hundredths,"+
      "price_dollars,fee_fingerprint,operator_approval_id,worker_holder_id,"+
      "worker_fencing_token,expires_at,state) "+
      "VALUES ($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::text,"+
      "$8::bigint,$9::text,$10::text,$11::uuid,$12::text,$13::bigint,$14::timestamptz,'PREPARED') "+
      "ON CONFLICT DO NOTHING RETURNING attempt_id",
      [identity.attemptId,identity.ownerId,identity.demoAccountId,signerFingerprint,
       order.client_order_id,order.ticker,order.side,
       qty(order.count as string).toString(),order.price,feeFingerprint,
       identity.operatorApprovalId,identity.workerHolderId,
       identity.workerFencingToken,new Date(approvalExpiresAtMs).toISOString()],
    );
    return r.rows.length===1 && r.rows[0]?.attempt_id===identity.attemptId;
  }catch{return false;}
}

/** Called only by the isolated DEMO IOC test adapter after a successful
 * unique PREPARED reservation has already been persisted. A successful COMMIT
 * ACKNOWLEDGEMENT is necessary before the FIRST (and only) demo POST.
 */
export async function consumeDemoIocUnknown(input:{
  identity:DemoLedgerIdentity;
  order:Readonly<EmergencyExitOrder>;
  signerFingerprint:string;
  feeFingerprint:string;
}, db:DB=pool as unknown as DB):Promise<DurableDemoUnknown|null>{
 const {identity,order,signerFingerprint,feeFingerprint}=input;
 if(!valid(identity,order,signerFingerprint,feeFingerprint))return null;
 let client:Client|null=null,committed=false;
 try{
   client=await db.connect();
   await client.query("BEGIN");
   await client.query("SET LOCAL lock_timeout='750ms'");
   await client.query("SET LOCAL statement_timeout='5000ms'");
   const changed=await client.query(
     "UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN',updated_at=now() "+
     "WHERE attempt_id=$1::uuid AND owner_user_id=$2::uuid "+
     "AND demo_account_id=$3::text AND signer_fingerprint=$4::text "+
     "AND client_order_id=$5::text AND market_ticker=$6::text "+
     "AND reducing_side=$7::text AND requested_hundredths=$8::bigint "+
     "AND price_dollars=$9::text AND fee_fingerprint=$10::text "+
     "AND operator_approval_id=$11::uuid AND worker_holder_id=$12::text "+
     "AND worker_fencing_token=$13::bigint AND state='PREPARED' "+
     "AND created_at > now()-interval '30 seconds' AND expires_at>now() "+
     "RETURNING attempt_id,client_order_id",
     [identity.attemptId,identity.ownerId,identity.demoAccountId,signerFingerprint,
      order.client_order_id,order.ticker,order.side,
      qty(order.count as string).toString(),order.price,feeFingerprint,
      identity.operatorApprovalId,identity.workerHolderId,identity.workerFencingToken],
   );
   if(changed.rows.length!==1||changed.rows[0]?.attempt_id!==identity.attemptId||
      changed.rows[0]?.client_order_id!==order.client_order_id)return null;
   await client.query("COMMIT");committed=true;
   return {persisted:true,state:"UNKNOWN",clientOrderId:order.client_order_id as string,
      fencingToken:identity.workerFencingToken,mayRetry:false,oneShot:true};
 }catch{return null;}
 finally{
   if(client){
     if(!committed)try{await client.query("ROLLBACK");}catch{}
     client.release();
   }
 }
}

/** No terminal update without exchange-authenticated reconciliation.
 * Caller has to prove confirmed fill/position to independent reviewer.
 * Raw HTTP status alone never transitions the ledger.
 */
export async function finalizeVerifiedDemoIoc(input:{
  identity:DemoLedgerIdentity;
  clientOrderId:string;
  independentlyVerified:true;
  exactAccountMarketOrderFillPositionMatched:true;
},db:DB=pool as unknown as DB):Promise<boolean>{
 const {identity,clientOrderId}=input;
 if(!UUID.test(identity?.ownerId??"")||
    !UUID.test(identity?.attemptId??"")||
    !CID.test(clientOrderId)||
    input.independentlyVerified!==true||
    input.exactAccountMarketOrderFillPositionMatched!==true)
    return false;
 try{
  const r=await db.query(
    "UPDATE private.strata_demo_ioc_attempt SET state='RECONCILED',updated_at=now() "+
    "WHERE attempt_id=$1::uuid AND owner_user_id=$2::uuid "+
    "AND demo_account_id=$3::text AND client_order_id=$4::text "+
    "AND worker_fencing_token=$5::bigint AND operator_approval_id=$6::uuid "+
    "AND state='UNKNOWN' RETURNING attempt_id",
    [identity.attemptId,identity.ownerId,identity.demoAccountId,clientOrderId,
     identity.workerFencingToken,identity.operatorApprovalId],
  );
  return r.rows.length===1&&r.rows[0]?.attempt_id===identity.attemptId;
 }catch{return false;}
}
