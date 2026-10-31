import {hasStandingReviewHistory,checkStandingExitReview} from './standingExecutionReview';
import {constants,createPrivateKey,createSign,createHash} from "node:crypto";
import {dedicatedSignerFingerprint} from "./commissioning";
import {pool} from "@workspace/db";
import {verifyMonetaryFeeContract} from "./monetaryFeeContract";
import {verifyReviewedProtectiveExitFee} from "./reviewedProtectiveExitFee";
import {markOwnedEmergencyExitUnknownForReview} from "./ownerFeeEmergencyExitUnknownCommit";
import {reconcileIocEmergencyExit,type IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
import {readAuthenticatedProtectiveExitOutcome} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import {persistAuthenticatedExitReconciliation} from "./ownerFeeEmergencyExitReconciliationCommit";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {ExitWorkerLease} from "./ownerFeeEmergencyExitReserve";

/**
 * P0 protective-exit signed transport candidate. Never wired to a public route;
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
 db?:DB;now?:()=>number;monotonicNow?:()=>number;
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
async function signedPost(material:Material,order:Readonly<EmergencyExitOrder>,beforeSend:()=>void):Promise<Receipt>{
 const key=createPrivateKey(material.privateKey.trim().replaceAll("\\n","\n"));
 if(!["rsa","rsa-pss"].includes(key.asymmetricKeyType??""))throw Error("exit_signer_type_invalid");
 const timestamp=String(Date.now()),signer=createSign("sha256");
 signer.update(timestamp+"POST"+PATH);signer.end();
 const signature=signer.sign({key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString("base64");
 const init:RequestInit={
  method:"POST",redirect:"error",credentials:"omit",
  headers:{"Content-Type":"application/json","Accept":"application/json",
   "KALSHI-ACCESS-KEY":material.keyId,
   "KALSHI-ACCESS-TIMESTAMP":timestamp,"KALSHI-ACCESS-SIGNATURE":signature},
  body:JSON.stringify({ticker:order.ticker,client_order_id:order.client_order_id,
    side:order.side,count:order.count,price:order.price,
    time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",
    post_only:false,cancel_order_on_pause:true,reduce_only:true,subaccount:1,exchange_index:2}),
  signal:AbortSignal.timeout(8000),
 };
 // No serialization, signing or asynchronous work after the final clock proof.
 beforeSend();
 const response=await fetch(HOST+PATH,init);
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
const durableLocalNoSend=new WeakMap<object,Readonly<{ownerId:string;accountId:string;reservationId:string}>>();
/** Read-only provenance check. This never clears a gate or supplies entry authority. */
export function isDurableProtectiveExitNoSend(value:unknown,scope:{ownerId:string;accountId:string;reservationId:string}):boolean{
 const proof=value!==null&&typeof value==="object"?durableLocalNoSend.get(value):undefined;
 return !!proof&&proof.ownerId===scope.ownerId&&proof.accountId===scope.accountId&&proof.reservationId===scope.reservationId;
}
type NeverSentProof=Readonly<{input:Input;reason:"final_evidence_expired"|"final_fee_rejected"|"final_fee_unavailable"}>;
const neverSentProofs=new WeakMap<object,NeverSentProof>();
/** Only explicit control-flow branches before raw POST mint this one-use proof.
 * Nothing from a caller/provider response, error string or database row can mint it. */
function mintNeverSent(input:Input,reason:NeverSentProof["reason"]):object {
 const token=Object.freeze({});neverSentProofs.set(token,{input,reason});return token;
}
async function finalizeNeverSent(token:object,db:DB):Promise<boolean>{
 const proof=neverSentProofs.get(token);neverSentProofs.delete(token);
 if(!proof)return false;
 const {input,reason}=proof,{ownerId,accountId,reservationId,order,lease}=input;
 const fingerprint=dedicatedSignerFingerprint(input.material.keyId,input.material.privateKey);
 const orderDigest=createHash("sha256").update(JSON.stringify(order)).digest("hex");
 const quantity=BigInt(String(order.count).split(".")[0]!)*100n+BigInt(String(order.count).split(".")[1]!);
 const side=order.side==="ask"?"YES":"NO",yesMicros=Number(String(order.price).slice(2))*100;
 const limitMicros=order.side==="ask"?yesMicros:1_000_000-yesMicros;
 const auditDigest=createHash("sha256").update(JSON.stringify({version:1,ownerId,accountId,reservationId,
  clientOrderId:order.client_order_id,orderDigest,market:order.ticker,side,quantity:String(quantity),limitMicros,signerFingerprint:fingerprint,holderId:lease.holderId,fencingToken:lease.fencingToken,reason})).digest("hex");
 let c:DBClient|null=null,committed=false;
 try{
  c=await db.connect();await c.query("BEGIN");
  await c.query("SET LOCAL lock_timeout='750ms'");await c.query("SET LOCAL statement_timeout='5000ms'");
  // Same account-first ordering as the financial ledger. Expired heartbeat is
  // permitted for cleanup ONLY: exact current lease/token ownership is locked.
  const account=await c.query("SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid AND subaccount=1 AND exchange_index=2 AND key_fingerprint=$3 FOR UPDATE",[accountId,ownerId,fingerprint]);
  if(account.rows.length!==1)return false;
  const held=await c.query("SELECT execution_account_id FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND holder_id=$3 AND fencing_token=$4::bigint AND state='owned' AND credential_fingerprint=$5 FOR UPDATE",[accountId,ownerId,lease.holderId,lease.fencingToken,fingerprint]);
  if(held.rows.length!==1)return false;
  const exact=await c.query(`SELECT r.reservation_id,i.id AS intent_id
   FROM private.strata_emergency_exit_reservations r JOIN public.v13_production_intent i
    ON i.account_id=r.execution_account_id AND i.client_order_id=r.client_order_id
   JOIN public.v13_production_position pos ON pos.id=i.parent_id AND pos.account_id=i.account_id
   JOIN public.v13_production_intent parent ON parent.id=i.parent_id AND parent.account_id=i.account_id
   WHERE r.reservation_id=$1::uuid AND r.owner_user_id=$2::uuid AND r.execution_account_id=$3
    AND r.client_order_id=$4 AND r.market_ticker=$5 AND r.order_digest=$6
    AND r.worker_holder_id=$7 AND r.worker_fencing_token=$8::bigint
    AND r.state='UNKNOWN' AND r.trading_authorized=false
    AND i.kind='EXIT' AND i.market=r.market_ticker AND i.state='DISPATCHED' AND i.terminal=false
    AND i.exchange_order_id IS NULL AND i.filled_hundredths=0 AND i.reserved_micros=0
    AND i.request->>'clientOrderId'=r.client_order_id AND i.request->>'reduceOnly'='true'
    AND i.request->>'action'='SELL' AND i.request->>'timeInForce'='IOC'
    AND i.request->>'market'=r.market_ticker AND i.side=r.reducing_side AND i.request->>'side'=r.reducing_side
    AND r.reducing_side=$9 AND r.quantity_hundredths=$10::bigint
    AND private.strata_exit_request_quantity_hundredths(i.request)=r.quantity_hundredths
    AND i.request->>'limitMicros'=$11::text
    AND pos.market=r.market_ticker AND pos.side=r.reducing_side AND pos.quantity_hundredths>=r.quantity_hundredths
    AND parent.kind='ENTRY' AND parent.terminal=true
   FOR UPDATE OF r,i,pos,parent`,[reservationId,ownerId,accountId,order.client_order_id,order.ticker,orderDigest,lease.holderId,lease.fencingToken,side,String(quantity),String(limitMicros)]);
  if(exact.rows.length!==1||exact.rows[0]?.reservation_id!==reservationId)return false;
  const intentId=exact.rows[0]!.intent_id;
  const inserted=await c.query(`INSERT INTO private.strata_protective_exit_local_no_send
   (reservation_id,owner_user_id,execution_account_id,client_order_id,order_digest,worker_holder_id,worker_fencing_token,reason,evidence_sha256,signer_fingerprint,market_ticker,reducing_side,quantity_hundredths,limit_micros)
   VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13::bigint,$14::bigint) ON CONFLICT DO NOTHING RETURNING reservation_id`,
   [reservationId,ownerId,accountId,order.client_order_id,orderDigest,lease.holderId,lease.fencingToken,reason,auditDigest,fingerprint,order.ticker,side,String(quantity),String(limitMicros)]);
  if(inserted.rows.length!==1)return false;
  const blocked=await c.query("UPDATE public.v13_production_intent SET state='BLOCKED',terminal=true WHERE id=$1 AND account_id=$2 AND client_order_id=$3 AND kind='EXIT' AND state='DISPATCHED' AND terminal=false AND exchange_order_id IS NULL AND filled_hundredths=0 AND reserved_micros=0 RETURNING id",[intentId,accountId,order.client_order_id]);
  if(blocked.rows.length!==1)return false;
  const released=await c.query("UPDATE private.strata_emergency_exit_reservations SET state='VOID',updated_at=now() WHERE reservation_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3 AND client_order_id=$4 AND state='UNKNOWN' RETURNING reservation_id",[reservationId,ownerId,accountId,order.client_order_id]);
  if(released.rows.length!==1)return false;
  await c.query("COMMIT");committed=true;return true;
 }catch{return false;}
 finally{if(c){if(!committed){try{await c.query("ROLLBACK");}catch{}}c.release();}}
}
async function refuseNeverSent(input:Input,reason:NeverSentProof["reason"],db:DB):Promise<Result>{
 const terminal=await finalizeNeverSent(mintNeverSent(input,reason),db);
 const result=Object.freeze(fail(terminal?"protective_exit_proven_not_posted_refresh_required":"protective_exit_local_abort_persistence_unverified",terminal?"BLOCKED":"UNKNOWN"));
 if(terminal)durableLocalNoSend.set(result,Object.freeze({ownerId:input.ownerId,accountId:input.accountId,reservationId:input.reservationId}));
 return result;
}

/** Final independent release/account checks commit and release locks before POST.
 * The one-use UNKNOWN marker remains durable; DB-relative evidence lifetimes
 * are rechecked synchronously after signing, without borrowing entry authority.
 */
async function withFinalReleaseFence(input:Input, sha:string,send:(beforeSend:()=>void)=>Promise<Receipt>,db:DB,monotonicNow:()=>number):
 Promise<{attempted:boolean;receipt:Receipt;expiredBeforeSend?:true}>{
 let c:DBClient|null=null,committed=false,eligible=false;
 let evidenceStart=NaN,remainingMs=NaN;
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
  const standingMode=await hasStandingReviewHistory(c,input.ownerId,input.accountId,sha);
  const standingAllowed=standingMode&&await checkStandingExitReview(c,input.ownerId,input.accountId,sha);
  if(standingMode&&!standingAllowed)return {attempted:false,receipt:null};
  const sql=`SELECT r.reservation_id,
 EXTRACT(EPOCH FROM (clock_timestamp()-r.updated_at))*1000::double precision AS reservation_age_ms,
 EXTRACT(EPOCH FROM (clock_timestamp()-w.heartbeat_at))*1000::double precision AS heartbeat_age_ms
 FROM private.strata_emergency_exit_reservations r
 JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
 JOIN public.live_execution_config g ON g.id='singleton'
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 JOIN public.v13_production_position pos ON pos.account_id=a.id AND pos.market=r.market_ticker AND pos.side=r.reducing_side
 -- Account owner AAL2 approval is required at account activation, but NEVER
 -- constitutes independent review of the executable emergency exit.
 -- Every signed protective IOC must have a genuinely independent exact-SHA
 -- technical release, including after a durable owner-SHA authorization.
 JOIN LATERAL (
   SELECT 1 AS code_authorized
   WHERE $14::boolean OR EXISTS (
     SELECT 1 FROM private.strata_protective_exit_release v
     WHERE v.release_commit_sha=$1 AND v.state='approved'
       AND v.created_at<=now() AND v.expires_at>now()
       AND v.revoked_at IS NULL
       AND v.independent_reviewer_id<>a.owner_user_id
       AND v.operator_approver_id<>v.independent_reviewer_id
     FOR SHARE OF v
   )
 ) code_release ON TRUE
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

 AND EXISTS (SELECT 1 FROM public.v13_production_observation o
   WHERE o.account_id=a.id AND o.kind='OWNER_ACTIVATION_REQUEST')
 AND EXISTS (SELECT 1 FROM public.v13_production_intent i
   WHERE i.account_id=a.id AND i.client_order_id=r.client_order_id
   AND i.market=r.market_ticker AND i.kind='EXIT'
   AND i.state='DISPATCHED' AND i.terminal=false
   AND i.exchange_order_id IS NULL AND i.filled_hundredths=0
   AND i.side=$7 AND i.request->>'market'=r.market_ticker
   AND i.request->>'side'=$7 AND i.request->>'clientOrderId'=r.client_order_id
   AND private.strata_exit_request_quantity_hundredths(i.request)=$8::bigint
   AND i.request->>'limitMicros'=$11::text
   FOR SHARE OF i)
 AND NOT EXISTS (SELECT 1 FROM public.v13_production_intent i
   WHERE i.account_id=a.id AND i.state IN ('DISPATCHED','UNKNOWN')
   AND i.client_order_id<>r.client_order_id)
 FOR SHARE OF r,a,g,w,pos`;
  // Anchor local elapsed BEFORE the DB read. DB-computed ages avoid comparing
  // host/DB wall clocks; subtracting the full round trip is conservative.
  evidenceStart=monotonicNow();
  if(!Number.isFinite(evidenceStart)||evidenceStart<0)return {attempted:false,receipt:null};
  const rows=await c.query(sql,[sha,input.reservationId,input.ownerId,
    input.accountId,input.order.client_order_id,input.order.ticker,side,units,
    input.lease.holderId,input.lease.fencingToken,proceeds,digest,fingerprint,standingAllowed]);
  if(rows.rows.length!==1||rows.rows[0]?.reservation_id!==input.reservationId)
   return {attempted:false,receipt:null};
  const row=rows.rows[0]!;
  const reservationAge=row.reservation_age_ms,heartbeatAge=row.heartbeat_age_ms;
  if(typeof reservationAge!=="number"||!Number.isFinite(reservationAge)||reservationAge<0||reservationAge>=8000||
     typeof heartbeatAge!=="number"||!Number.isFinite(heartbeatAge)||heartbeatAge<0||heartbeatAge>=5000)
   return {attempted:false,receipt:null};
  remainingMs=Math.min(8000-reservationAge,5000-heartbeatAge);
  // The PREPARED -> UNKNOWN marker is already committed. This final
  // authorization fence must COMMIT before any network request is attempted.
  // No row lock may be held across the external transport.
  await c.query("COMMIT");committed=true;eligible=true;
 }catch{
  // Ambiguous COMMIT: keep durable UNKNOWN, never transmit and never retry.
  return {attempted:false,receipt:null};
 }finally{
  if(c){if(!committed){try{await c.query("ROLLBACK");}catch{}}
   c.release();}
 }
 if(!eligible)return {attempted:false,receipt:null};
 // At this point a kill can update immediately. An in-flight POST cannot be
 // unsent; the one-use marker ensures recovery-only behavior after a crash.
 let attempted=false,expired=false;
 try{
  const receipt=await send(()=>{
   const current=monotonicNow();
   if(!Number.isFinite(current)||current<evidenceStart||current-evidenceStart>=remainingMs){
    expired=true;throw Error("protective_exit_final_evidence_expired");
   }
   attempted=true;
  });
  return {attempted,receipt};
 }catch{
  return {attempted,receipt:null,...(!attempted&&expired?{expiredBeforeSend:true as const}:{})};
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
 if(!testMode&&(ports.db||ports.mark||ports.verifyFee||ports.post||ports.readAuthenticatedOutcome||ports.persistReconciled||ports.monotonicNow))
  return fail("protective_exit_injection_forbidden");
 const sha=process.env.RAILWAY_GIT_COMMIT_SHA;
 if(!testMode&&(!sha||!SHA.test(sha)))return fail("protective_exit_release_version_unknown");
 const releaseSha=testMode?"a".repeat(40):sha!;
 const {ownerId,accountId,reservationId}=input;
 // Snapshot every mutable scalar-bearing input before the first await.
 const order=Object.freeze({...input.order});
 const lease=Object.freeze({...input.lease}),material=Object.freeze({...input.material});
 input={...input,order,lease,material};
 if(!UUID.test(ownerId)||!UUID.test(reservationId)||!/^[A-Za-z0-9._:-]{1,128}$/.test(accountId)||
    !validOrder(order)||!lease||!/^[A-Za-z0-9._:-]{1,128}$/.test(lease.holderId)||
    !Number.isSafeInteger(lease.fencingToken)||lease.fencingToken<1)
  return fail("protective_exit_identity_invalid");
 // Production recovery is a trusted server-only implementation; tests may inject a reader.
 // The reviewed owner-pinned API fee model remains usable for narrowly
 // scoped protective exits when an entry/fee-source grant expires. It still
 // requires a fresh official exact-market fee/override read, and the exact
 // independently approved code SHA at the signed POST fence.
 const checkFee=ports.verifyFee??((_stage:"ORDER_ENTRY",market:string)=>
   verifyReviewedProtectiveExitFee(ownerId,accountId,market));
 const fee=await checkFee("ORDER_ENTRY",String(order.ticker));
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
 let current:Awaited<ReturnType<typeof checkFee>>;
 try{current=await checkFee("ORDER_ENTRY",String(order.ticker));}
 catch{
  // Production checkFee is exclusively the read-only reviewed-fee verifier;
  // hosted processes reject injected ports before any marker. This catch is
  // confined to that read, never the final fence/signing/order transport.
  return refuseNeverSent(input,"final_fee_unavailable",ports.db??(pool as unknown as DB));
 }
 if(!current.ok||!current.monetaryFeeAuthorized||current.marketTicker!==order.ticker)
  return refuseNeverSent(input,"final_fee_rejected",ports.db??(pool as unknown as DB));
 const outcome=await withFinalReleaseFence(input,releaseSha,
  beforeSend=>{
   if(ports.post){beforeSend();return ports.post(material,order);}
   return signedPost(material,order,beforeSend);
  },ports.db??(pool as unknown as DB),ports.monotonicNow??(()=>performance.now()));
 if(outcome.expiredBeforeSend)return refuseNeverSent(input,"final_evidence_expired",ports.db??(pool as unknown as DB));
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
