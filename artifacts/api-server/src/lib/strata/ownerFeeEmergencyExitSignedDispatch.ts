import {constants,createPrivateKey,createSign,createHash} from "node:crypto";
import {dedicatedSignerFingerprint} from "./commissioning";
import {pool} from "@workspace/db";
import {verifyMonetaryFeeContract} from "./monetaryFeeContract";
import {markOwnedEmergencyExitUnknownForReview} from "./ownerFeeEmergencyExitUnknownCommit";
import {reconcileIocEmergencyExit,type IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
import {readAuthenticatedProtectiveExitOutcome} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import {persistAuthenticatedExitReconciliation} from "./ownerFeeEmergencyExitReconciliationCommit";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {ExitWorkerLease} from "./ownerFeeEmergencyExitReserve";

/**
 * P0 protective-exit signed transport candidate. NOT wired to a public route or
 * worker. All production calls fail closed unless an independently approved,
 * commit-bound release exists AND a server-side feature flag is explicitly set.
 * Neither CI nor this module creates that release. Never retry UNKNOWN.
 *
 * An application controller MUST supply an authenticated owner identity and
 * credential-vault material. Never accept either from the browser JSON body.
 */
const HOST="https://external-api.kalshi.com";
const PATH="/trade-api/v2/portfolio/events/orders";
const SHA=/^[0-9a-f]{40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT=/^v13p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const QUANTITY=/^\d{1,9}\.\d{2}$/;
const PRICE=/^0\.(?!0000)\d{4}$/;
type DBClient={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;release():void};
type DB={connect():Promise<DBClient>};
type Result={
 state:"BLOCKED"|"UNKNOWN"|"RECONCILED";
 reason:string;clientOrderId?:string;filledHundredths?:string;
 mayRetry:false;tradingAuthorized:false;
 /** Means exactly one signed POST was attempted; NOT proof of a fill. */
 postAttempted:boolean;
};
const fail=(reason:string,state:Result["state"]="BLOCKED",postAttempted=false):Result=>
 ({state,reason,mayRetry:false,tradingAuthorized:false,postAttempted});
type Receipt=IocRecoveryObservation["response"];
type Material={keyId:string;privateKey:string};
type Input={ownerId:string;accountId:string;reservationId:string;
  material:Material;order:Readonly<EmergencyExitOrder>;lease:ExitWorkerLease};
/** Narrow seams are for isolated tests; not injectable by public controllers. */
type Ports={
 db?:DB;now?:()=>number;
 mark?:typeof markOwnedEmergencyExitUnknownForReview;
 verifyFee?:typeof verifyMonetaryFeeContract;
 post?:(material:Material,order:Readonly<EmergencyExitOrder>)=>Promise<Receipt>;
 readAuthenticatedOutcome?:(input:Input,receipt:Receipt)=>Promise<IocRecoveryObservation>;
 persistReconciled?:typeof persistAuthenticatedExitReconciliation;
};
function validOrder(o:EmergencyExitOrder):boolean{
 return !!o&&typeof o.ticker==="string"&&MARKET.test(o.ticker)&&
 typeof o.client_order_id==="string"&&CLIENT.test(o.client_order_id)&&
 (o.side==="ask"||o.side==="bid")&&
 typeof o.count==="string"&&QUANTITY.test(o.count)&&
 typeof o.price==="string"&&PRICE.test(o.price)&&
 o.reduce_only===true&&o.time_in_force==="immediate_or_cancel"&&
 o.self_trade_prevention_type==="taker_at_cross"&&o.post_only===false&&
 o.subaccount===1&&o.exchange_index===2&&o.expiration_time===undefined;
}
/** Use only the fixed production host/path and Kalshi's RSA-PSS signing rule. */
async function signedPost(material:Material,order:Readonly<EmergencyExitOrder>):Promise<Receipt>{
 const key=createPrivateKey(material.privateKey.trim().replaceAll("\\n","\n"));
 if(!["rsa","rsa-pss"].includes(key.asymmetricKeyType??""))throw Error("exit_signer_type_invalid");
 const timestamp=String(Date.now()),signer=createSign("sha256");
 signer.update(timestamp+"POST"+PATH);signer.end();
 const signature=signer.sign({key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString("base64");
 const response=await fetch(HOST+PATH,{
  method:"POST",redirect:"error",credentials:"omit",
  headers:{"Content-Type":"application/json","Accept":"application/json",
   "KALSHI-ACCESS-KEY":material.keyId,
   "KALSHI-ACCESS-TIMESTAMP":timestamp,"KALSHI-ACCESS-SIGNATURE":signature},
  body:JSON.stringify({ticker:order.ticker,client_order_id:order.client_order_id,
    side:order.side,count:order.count,price:order.price,
    time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",
    post_only:false,cancel_order_on_pause:true,reduce_only:true,subaccount:1,exchange_index:2}),
  signal:AbortSignal.timeout(8000),
 });
 if(response.status!==201)return null; // All HTTP failures are ambiguous after POST.
 const body=await response.text();
 if(body.length>8192)return null;
 let raw:unknown;
 try{raw=JSON.parse(body);}catch{return null;}
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const r=raw as Record<string,unknown>;
 if(r.client_order_id!==order.client_order_id||
    typeof r.order_id!=="string"||!/^[A-Za-z0-9._:-]{1,128}$/.test(r.order_id)||
    typeof r.fill_count!=="string"||typeof r.remaining_count!=="string"||
    !QUANTITY.test(r.fill_count)||!QUANTITY.test(r.remaining_count)||
    typeof r.ts_ms!=="number"||!Number.isSafeInteger(r.ts_ms))
  return null;
 return {httpStatus:201,order_id:r.order_id,client_order_id:r.client_order_id,
   fill_count:r.fill_count,remaining_count:r.remaining_count,ts_ms:r.ts_ms};
}
/** All row locks are held across the ONE signed POST, after UNKNOWN committed.
 * The code release record is immutable review evidence, never self-issued.
 */
async function withFinalReleaseFence(input:Input, sha:string,send:()=>Promise<Receipt>,db:DB):
 Promise<{attempted:boolean;receipt:Receipt}>{
 let c:DBClient|null=null,committed=false,attempted=false,receipt:Receipt=null;
 try{
  c=await db.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL lock_timeout='750ms'");
  await c.query("SET LOCAL statement_timeout='12000ms'");
  const yesMicros=Number((input.order.price as string).slice(2))*100;
  const proceeds=input.order.side==="ask"?yesMicros:1_000_000-yesMicros;
  const units=(BigInt(String(input.order.count).split(".")[0]!)*100n+
    BigInt(String(input.order.count).split(".")[1]!)).toString();
  const side=input.order.side==="ask"?"YES":"NO";
  const fingerprint=dedicatedSignerFingerprint(input.material.keyId,input.material.privateKey);
  const digest=createHash("sha256").update(JSON.stringify(input.order)).digest("hex");
  if(!fingerprint||!/^[a-f0-9]{64}$/.test(fingerprint))return {attempted:false,receipt:null};
  const sql=`SELECT r.reservation_id FROM private.strata_emergency_exit_reservations r
 JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
 JOIN public.live_execution_config g ON g.id='singleton'
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 JOIN public.v13_production_position pos ON pos.account_id=a.id AND pos.market=r.market_ticker AND pos.side=r.reducing_side
 JOIN private.strata_protective_exit_release v ON v.release_commit_sha=$1 AND v.state='approved'
 WHERE r.reservation_id=$2::uuid AND r.owner_user_id=$3::uuid
 AND r.execution_account_id=$4 AND r.client_order_id=$5 AND r.market_ticker=$6
 AND r.reducing_side=$7 AND r.quantity_hundredths=$8::bigint
 AND r.worker_holder_id=$9 AND r.worker_fencing_token=$10::bigint
 AND r.state='UNKNOWN' AND r.trading_authorized=false
 AND r.order_digest=$12::text
 AND r.updated_at > now()-interval '8 seconds'
 AND a.commissioned=true AND a.execution_enabled=true AND a.kill_switch=false
 AND a.key_fingerprint=$13::text
 AND a.subaccount=1 AND a.exchange_index=2
 AND a.minimum_exit_micros IS NOT NULL AND a.minimum_exit_micros <= $11::bigint
 AND g.live_execution_enabled=true AND g.manual_kill_switch=false
 AND w.holder_id=$9 AND w.fencing_token=$10::bigint AND w.state='owned'
 AND w.credential_fingerprint=$13::text
 AND w.account_kill=false AND w.heartbeat_at > now()-interval '5 seconds'
 AND pos.quantity_hundredths >= $8::bigint
 AND v.expires_at > now() AND v.revoked_at IS NULL
 AND v.independent_reviewer_id <> a.owner_user_id
 AND EXISTS (SELECT 1 FROM public.v13_production_observation o
   WHERE o.account_id=a.id AND o.kind='OWNER_ACTIVATION_REQUEST')
 AND NOT EXISTS (SELECT 1 FROM public.v13_production_intent i
   WHERE i.account_id=a.id AND i.state IN ('DISPATCHED','UNKNOWN'))
 FOR SHARE OF r,a,g,w,pos,v`;
  const rows=await c.query(sql,[sha,input.reservationId,input.ownerId,
    input.accountId,input.order.client_order_id,input.order.ticker,side,units,
    input.lease.holderId,input.lease.fencingToken,proceeds,digest,fingerprint]);
  if(rows.rows.length!==1||rows.rows[0]?.reservation_id!==input.reservationId)
   return {attempted:false,receipt:null};
  // One-shot in DB already: PREPARED cannot be re-entered from UNKNOWN.
  attempted=true;
  try{receipt=await send();}catch{receipt=null;}
  await c.query("COMMIT");committed=true;
  return {attempted,receipt};
 }catch{
  // COMMIT may be ambiguous after network transmission. Never retry.
  return {attempted,receipt:null};
 }finally{
  if(c){if(!committed){try{await c.query("ROLLBACK");}catch{}}
   c.release();}
 }
}
export async function dispatchReviewedProtectiveExitOnce(input:Input,ports:Ports={}):Promise<Result>{
 // Test seams must NEVER be reachable from a Railway process, even if
 // NODE_ENV is accidentally or maliciously set to "test" in deployment.
 const hosted=Boolean(process.env.RAILWAY_ENVIRONMENT_ID||
   process.env.RAILWAY_SERVICE_ID||process.env.RAILWAY_PROJECT_ID);
 const testMode=process.env.NODE_ENV==="test"&&!hosted;
 if(!testMode&&(process.env.NODE_ENV!=="production"||
    process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=="true"))
  return fail("protective_exit_release_disabled");
 if(!testMode&&(ports.db||ports.mark||ports.verifyFee||ports.post||ports.readAuthenticatedOutcome||ports.persistReconciled))
  return fail("protective_exit_injection_forbidden");
 const sha=process.env.RAILWAY_GIT_COMMIT_SHA;
 if(!testMode&&(!sha||!SHA.test(sha)))return fail("protective_exit_release_version_unknown");
 const releaseSha=testMode?"a".repeat(40):sha!;
 const {ownerId,accountId,reservationId,lease,material}=input;
 // Immutable scalar snapshot, never use a mutable caller object after awaits.
 const order=Object.freeze({...input.order});
 input={...input,order};
 if(!UUID.test(ownerId)||!UUID.test(reservationId)||!/^[A-Za-z0-9._:-]{1,128}$/.test(accountId)||
    !validOrder(order)||!lease||!/^[A-Za-z0-9._:-]{1,128}$/.test(lease.holderId)||
    !Number.isSafeInteger(lease.fencingToken)||lease.fencingToken<1)
  return fail("protective_exit_identity_invalid");
 // Production recovery is a trusted server-only implementation; tests may inject a reader.
 const fee=await (ports.verifyFee??verifyMonetaryFeeContract)("ORDER_ENTRY",String(order.ticker));
 if(!fee.ok||!fee.monetaryFeeAuthorized||fee.marketTicker!==order.ticker)
  return fail("protective_exit_monetary_fees_unverified");
 let marker:Awaited<ReturnType<typeof markOwnedEmergencyExitUnknownForReview>>;
 try{marker=await (ports.mark??markOwnedEmergencyExitUnknownForReview)(
  ownerId,accountId,reservationId,material,order as EmergencyExitOrder,lease);}
 catch{return fail("protective_exit_unknown_marker_unverified");}
 if(marker.unknownRecorded!==true||marker.clientOrderId!==order.client_order_id||
    marker.mayRetry!==false||marker.transportAuthorized!==false)
  return fail("protective_exit_unknown_marker_unverified");
 // Before final fence refresh provider fees again; never transmit with stale terms.
 const current=await (ports.verifyFee??verifyMonetaryFeeContract)("ORDER_ENTRY",String(order.ticker));
 if(!current.ok||!current.monetaryFeeAuthorized||current.marketTicker!==order.ticker)
  return fail("protective_exit_monetary_fees_changed","UNKNOWN");
 const outcome=await withFinalReleaseFence(input,releaseSha,
  ()=> (ports.post??signedPost)(material,order),ports.db??(pool as unknown as DB));
 if(!outcome.attempted)return fail("protective_exit_final_fence_closed","UNKNOWN");
 if(!outcome.receipt)return fail("protective_exit_exchange_response_uncertain","UNKNOWN",true);

 let observed:IocRecoveryObservation;
 try{observed=await (ports.readAuthenticatedOutcome??readAuthenticatedProtectiveExitOutcome)(input,outcome.receipt);}
 catch{return fail("protective_exit_exchange_reconciliation_unavailable","UNKNOWN",true);}
 if(observed.clientOrderId!==order.client_order_id||observed.marketTicker!==order.ticker||
    observed.requestedCountFp!==order.count||
    observed.reducingBookSide!==order.side||
    observed.response?.order_id!==outcome.receipt.order_id)
  return fail("protective_exit_exchange_reconciliation_identity_mismatch","UNKNOWN",true);
 const result=reconcileIocEmergencyExit(observed);
 if(result.state!=="RECONCILED")
  return fail(result.reason,"UNKNOWN",true);
 // The original reservation is UNKNOWN until an audited transaction commits
 // a one-shot immutable reconciliation row and terminal state. A failed or
 // ambiguous commit never permits any retry or treats a fill as cleared.
 const persisted=await (ports.persistReconciled??persistAuthenticatedExitReconciliation)(input,observed);
 if(persisted.committed!==true||persisted.mayRetry!==false)
  return fail("protective_exit_terminal_audit_unverified","UNKNOWN",true);
 // This response reports durable recovery, not permission for another POST.
 return {state:"RECONCILED",reason:"protective_exit_reconciled_read_only",
  clientOrderId:order.client_order_id,filledHundredths:result.filledHundredths,
  mayRetry:false,tradingAuthorized:false,postAttempted:true};
}
