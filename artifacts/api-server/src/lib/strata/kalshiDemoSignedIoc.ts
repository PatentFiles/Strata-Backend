/**
 * Kalshi DEMO-only, explicitly operator-controlled, ONE-SHOT protective IOC.
 * This is an isolated test adapter, not a production order route.
 *
 * The durable reservation has to be transactionally persisted as UNKNOWN
 * BEFORE this module can submit a single signed POST. An ambiguous response
 * never enables a retry or changes any production financial state.
 *
 * Kalshi V2: POST /trade-api/v2/portfolio/events/orders; bid/ask is YES book
 * side, price/count are fixed-point strings, reduce_only requires IOC.
 */
import {createHash,createPrivateKey,createPublicKey,sign,constants} from "node:crypto";
import {KALSHI_DEMO_ORIGIN} from "./kalshiDemoSignedReadOnly";
import {reconcileIocEmergencyExit,type IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";

export const DEMO_IOC_PATH="/trade-api/v2/portfolio/events/orders" as const;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CID=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const COUNT=/^(0|[1-9]\d{0,8})\.\d{2}$/;
const PRICE=/^0\.(?!0000)\d{4}$/;
const MARKET=/^KXBTC15M-[a-zA-Z0-9-]+$/;
const DENIAL="demo_ioc_identity_or_approval_unverified";
function hundredths(x:string):bigint {
  const [whole,frac]=x.split(".");
  return BigInt(whole!)*100n+BigInt(frac!);
}
export function demoSignerFingerprint(keyId:string,privateKeyPem:string):string|null{
  try{
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(keyId))return null;
    const key=createPrivateKey(privateKeyPem);
    if(key.asymmetricKeyType!=="rsa" && key.asymmetricKeyType!=="ed25519")return null;
    const der=createPublicKey(key).export({type:"spki",format:"der"});
    return createHash("sha256").update(keyId).update(der).digest("hex");
  }catch{return null;}
}
export type DemoExitApproval = {
  environment:"KALSHI_DEMO";
  authenticatedOwnerId:string;
  accountOwnerId:string;
  signerFingerprint:string;
  demoAccountVerified:true;
  subaccount:1;
  exchangeIndex:2;
  authorizedByIndependentOperator:true;
  operatorApprovalId:string;
  approvalExpiresAtMs:number;
  marketTicker:string;
  marketOpen:true;
  priceGridVerified:true;
  permittedLimitPrice:string;
  positionMarketTicker:string;
  positionsComplete:true;
  signedPositionFp:string;
  positionObservedAtMs:number;
  restingOrderCount:0;
  unresolvedOrderCount:0;
  feeFingerprint:string;
  feeObservedAtMs:number;
  feesCurrentAndApplicable:true;
  workerFencingToken:number;
};
export type DurableDemoUnknown={
  persisted:true; state:"UNKNOWN"; clientOrderId:string;
  fencingToken:number; mayRetry:false; oneShot:true;
};
export type DemoIocResult={
  environment:"KALSHI_DEMO";
  state:"BLOCKED"|"UNKNOWN"|"RECONCILED";
  reason:string; httpStatus:number|null;
  submitted:boolean; mayRetry:false;
  productionOrderSubmitted:false; tradingAuthorized:false;
  clientOrderId?:string;
  filledHundredths?:string;
};
const result=(state:DemoIocResult["state"],reason:string,httpStatus:number|null=null,
 submitted=false,clientOrderId?:string):DemoIocResult=>({
   environment:"KALSHI_DEMO",state,reason,httpStatus,submitted,
   mayRetry:false,productionOrderSubmitted:false,tradingAuthorized:false,
   ...(clientOrderId?{clientOrderId}:{}),
 });
type Receipt = IocRecoveryObservation["response"];
type VerifiedRead = (clientOrderId:string,receipt:Receipt)=>Promise<IocRecoveryObservation>;
export interface DemoIocDependencies {
  /** Durable serializable DB transition; must reject duplicate client order IDs. */
  commitUnknownBeforePost:(order:Readonly<EmergencyExitOrder>,fingerprint:string)=>Promise<DurableDemoUnknown>;
  /** Independently authenticated exchange GET history, not an HTTP 201 echo. */
  readVerifiedExchangeHistory:VerifiedRead;
  /** Test transport injection; defaults to real DEMO fetch, NEVER production. */
  fetchImpl?:typeof fetch;
  nowMs?:()=>number;
}
export async function executeOneSignedDemoProtectiveIoc(input:{
  keyId:string;
  privateKeyPem:string;
  order:Readonly<EmergencyExitOrder>;
  approval:Readonly<DemoExitApproval>;
  deps:DemoIocDependencies;
}):Promise<DemoIocResult>{
  const {order,approval,deps}=input;
  const now=(deps.nowMs??Date.now)();
  const fingerprint=demoSignerFingerprint(input.keyId,input.privateKeyPem);
  if(!Number.isSafeInteger(now)||now<=0||!fingerprint||
     !order||!approval||approval.environment!=="KALSHI_DEMO"||
     !UUID.test(approval.authenticatedOwnerId)||
     approval.authenticatedOwnerId!==approval.accountOwnerId||
     approval.demoAccountVerified!==true||
     approval.subaccount!==1||approval.exchangeIndex!==2||
     approval.authorizedByIndependentOperator!==true||
     !UUID.test(approval.operatorApprovalId)||
     !Number.isSafeInteger(approval.approvalExpiresAtMs)||
     approval.approvalExpiresAtMs<=now||
     approval.approvalExpiresAtMs>now+60_000||
     approval.signerFingerprint!==fingerprint||
     !MARKET.test(approval.marketTicker)||
     approval.marketTicker!==order.ticker||
     approval.marketOpen!==true||approval.priceGridVerified!==true||
     approval.permittedLimitPrice!==order.price||
     approval.positionMarketTicker!==order.ticker||
     approval.positionsComplete!==true||
     approval.restingOrderCount!==0||approval.unresolvedOrderCount!==0||
     approval.feesCurrentAndApplicable!==true||
     !SHA.test(approval.feeFingerprint)||
     !Number.isSafeInteger(approval.feeObservedAtMs)||
     now-approval.feeObservedAtMs>3_000||approval.feeObservedAtMs>now||
     !Number.isSafeInteger(approval.positionObservedAtMs)||
     now-approval.positionObservedAtMs>3_000||approval.positionObservedAtMs>now||
     !Number.isSafeInteger(approval.workerFencingToken)||
     approval.workerFencingToken<1||
     typeof order.client_order_id!=="string"||!CID.test(order.client_order_id)||
     typeof order.ticker!=="string"||!MARKET.test(order.ticker)||
     typeof order.count!=="string"||!COUNT.test(order.count)||
     typeof order.price!=="string"||!PRICE.test(order.price)||
     !["bid","ask"].includes(String(order.side))||
     order.time_in_force!=="immediate_or_cancel"||
     order.self_trade_prevention_type!=="taker_at_cross"||
     order.post_only!==false||order.reduce_only!==true||
     order.subaccount!==1||order.exchange_index!==2||
     order.expiration_time!==undefined)
    return result("BLOCKED",DENIAL);
  const requested=hundredths(order.count);
  if(requested<=0n||requested>100_000n)
    return result("BLOCKED","demo_ioc_count_invalid");
  const pos=approval.signedPositionFp;
  if(typeof pos!=="string"||!/^-?(0|[1-9]\d{0,8})\.\d{2}$/.test(pos))
    return result("BLOCKED","demo_ioc_position_invalid");
  const neg=pos.startsWith("-");
  const actual=hundredths(neg?pos.slice(1):pos);
  if(actual<=0n||requested>actual||
     (neg&&order.side!=="bid")||(!neg&&order.side!=="ask"))
    return result("BLOCKED","demo_ioc_not_verified_reducing");
  // This is a strict allowlist of wire fields; never spread untrusted caller
  // JSON into an order or accept expiration/post-only/other order flags.
  const body={
    ticker:order.ticker,client_order_id:order.client_order_id,
    side:order.side,count:order.count,price:order.price,
    time_in_force:"immediate_or_cancel",
    self_trade_prevention_type:"taker_at_cross",
    post_only:false,reduce_only:true,
    subaccount:1,exchange_index:2,
  };
  const unknown=(reason:string,status:number|null=null)=>result(
    "UNKNOWN",reason,status,true,order.client_order_id as string,
  );
  let mark:DurableDemoUnknown;
  try{
    mark=await deps.commitUnknownBeforePost(Object.freeze({...order}),fingerprint);
  }catch{
    return result("BLOCKED","demo_ioc_durable_marker_unverified");
  }
  if(mark?.persisted!==true||mark.state!=="UNKNOWN"||mark.oneShot!==true||
     mark.mayRetry!==false||mark.clientOrderId!==order.client_order_id||
     mark.fencingToken!==approval.workerFencingToken)
    return result("BLOCKED","demo_ioc_unknown_commit_unverified");
  // The reservation is UNKNOWN and cannot be replayed even if this process
  // crashes before sending, during the POST or after the response.
  const key=createPrivateKey(input.privateKeyPem);
  const t=(deps.nowMs??Date.now)();
  if(!Number.isSafeInteger(t)||t<now||t-now>3_000)return unknown("demo_ioc_clock_changed");
  const message=Buffer.from(String(t)+"POST"+DEMO_IOC_PATH);
  const signature=key.asymmetricKeyType==="rsa"?
    sign("sha256",message,{key,padding:constants.RSA_PKCS1_PSS_PADDING,
      saltLength:constants.RSA_PSS_SALTLEN_DIGEST}):
    sign(null,message,key);
  let status:number|null=null,receipt:Receipt=null;
  try{
    const response=await (deps.fetchImpl??fetch)(KALSHI_DEMO_ORIGIN+DEMO_IOC_PATH,{
      method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10_000),
      headers:{
        "KALSHI-ACCESS-KEY":input.keyId,
        "KALSHI-ACCESS-TIMESTAMP":String(t),
        "KALSHI-ACCESS-SIGNATURE":signature.toString("base64"),
        "Content-Type":"application/json","Accept":"application/json",
      },
      body:JSON.stringify(body),
    });
    status=response.status;
    if(status!==201)return unknown("demo_ioc_non_201_outcome_requires_reconciliation",status);
    if(response.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return unknown("demo_ioc_receipt_not_json",status);
    if(Number(response.headers.get("content-length")??"0")>32_768)
      return unknown("demo_ioc_receipt_too_large",status);
    const raw:unknown=await response.json();
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      return unknown("demo_ioc_receipt_malformed",status);
    const obj=raw as Record<string,unknown>;
    receipt={
      httpStatus:201,
      order_id:obj.order_id,
      client_order_id:obj.client_order_id,
      fill_count:obj.fill_count,
      remaining_count:obj.remaining_count,
      ts_ms:obj.ts_ms,
    };
  }catch{
    return unknown("demo_ioc_post_outcome_ambiguous",status);
  }
  let observation:IocRecoveryObservation;
  try{
    observation=await deps.readVerifiedExchangeHistory(order.client_order_id as string,receipt);
  }catch{return unknown("demo_ioc_exchange_reconciliation_unavailable",status);}
  if(!observation||!receipt||!observation.response||
     observation.clientOrderId!==order.client_order_id||
     observation.marketTicker!==order.ticker||
     observation.positionMarketTicker!==order.ticker||
     observation.requestedCountFp!==order.count||
     observation.reducingBookSide!==order.side||
     JSON.stringify(observation.response)!==JSON.stringify(receipt))
    return unknown("demo_ioc_history_identity_mismatch",status);
  const reconciled=reconcileIocEmergencyExit(observation);
  if(reconciled.state!=="RECONCILED")
    return unknown(reconciled.reason,status);
  return {...result("RECONCILED","demo_ioc_completed_with_authenticated_history",status,
     true,order.client_order_id as string),
    filledHundredths:reconciled.filledHundredths};
}
