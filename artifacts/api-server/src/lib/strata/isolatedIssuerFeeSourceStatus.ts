/**
 * #165: Non-authorizing, non-fetching issuer fee capture status.
 * This is NOT an owner grant, signed exchange read, cash reconciliation,
 * protective exit review or START. It never calls Kalshi, retries a 429,
 * or acquires a shared provider lease.
 *
 * The DB retry deadline is an infrastructure SHARED LEASE, NOT evidence
 * that Kalshi itself returned HTTP 429 on this invocation.
 */
import {pool} from "@workspace/db";
import {CANONICAL_FEE_SCHEDULE_URL} from "../microLiveFeeArtifact";

type Row=Record<string,unknown>;
type Db={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
const timestamp=(v:unknown)=>v instanceof Date?v.getTime():Date.parse(String(v??""));
const iso=(v:number)=>new Date(v).toISOString();
export type IssuerSourceStatus={
 ok:boolean;reason:string;readOnly:true;issuerRequestAttempted:false;
 grantRecorded:false;tradingAuthorized:false;ordersSubmitted:false;
 source:"kalshi_official_fee_pdf";
 captureState:"fresh_capture"|"expired_capture"|"never_captured"|"unavailable";
 retryState:"shared_lease_active"|"shared_lease_expired"|"unknown";
 rateLimitOrigin:"unknown";currentForV4:boolean;
 lastCaptureAt:string|null;nextAllowedAt:string|null;
};
export const ISOLATED_ISSUER_SQL=[
 "SELECT",
 "(SELECT captured_at FROM public.strata_official_fee_captures",
 " WHERE canonical_url=$1 ORDER BY captured_at DESC,id DESC LIMIT 1) last_capture_at,",
 "(SELECT expires_at FROM public.strata_official_fee_captures",
 " WHERE canonical_url=$1 ORDER BY captured_at DESC,id DESC LIMIT 1) capture_expiry,",
 "(SELECT next_allowed_at FROM public.strata_official_fee_capture_throttle",
 " WHERE id=true) next_allowed_at"
].join(" ");
const denied=(reason:string):IssuerSourceStatus=>({
 ok:false,reason,readOnly:true,issuerRequestAttempted:false,
 grantRecorded:false,tradingAuthorized:false,ordersSubmitted:false,
 source:"kalshi_official_fee_pdf",captureState:"unavailable",retryState:"unknown",
 rateLimitOrigin:"unknown",currentForV4:false,
 lastCaptureAt:null,nextAllowedAt:null,
});
export async function inspectIsolatedIssuerFeeSourceStatus(
 deps:{db?:Db;now?:()=>number}={},
):Promise<IssuerSourceStatus>{
 const now=(deps.now??Date.now)();
 if(!Number.isSafeInteger(now)||now<=0)return denied("issuer_fee_clock_invalid");
 let rows:Row[];
 try{
  const result=await (deps.db??pool).query(ISOLATED_ISSUER_SQL,[CANONICAL_FEE_SCHEDULE_URL]);
  rows=result.rows;
 }catch{return denied("issuer_fee_capture_status_database_unavailable");}
 if(rows.length!==1)return denied("issuer_fee_capture_status_ambiguous");
 const r=rows[0]!;
 const captured=timestamp(r.last_capture_at);
 const expires=timestamp(r.capture_expiry);
 const next=timestamp(r.next_allowed_at);
 const lastCaptureAt=Number.isFinite(captured)?iso(captured):null;
 const nextAllowedAt=Number.isFinite(next)?iso(next):null;
 const identityValid=lastCaptureAt!==null&&Number.isFinite(expires)&&
  captured<=now&&expires>captured&&expires-captured<=60*60_000;
 const currentForV4=identityValid&&now-captured<60_000&&now<expires;
 const captureState:IssuerSourceStatus["captureState"]=
  currentForV4?"fresh_capture":lastCaptureAt===null?"never_captured":"expired_capture";
 return {
  ok:true,reason:"issuer_source_status_isolated_read_only",readOnly:true,
  issuerRequestAttempted:false,grantRecorded:false,tradingAuthorized:false,
  ordersSubmitted:false,source:"kalshi_official_fee_pdf",
  captureState,retryState:nextAllowedAt===null?"unknown":
   next>now?"shared_lease_active":"shared_lease_expired",
  rateLimitOrigin:"unknown",currentForV4,
  lastCaptureAt,nextAllowedAt,
 };
}
