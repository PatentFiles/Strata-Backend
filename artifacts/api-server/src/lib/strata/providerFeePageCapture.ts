/**
 * Strict fixed-origin, read-only PDF-free official fee page capture.
 *
 * This is a provider-origin CONTENT candidate, NOT an approved fee schedule.
 * The HTML may be an empty SPA shell or omit the effective formula. This
 * function deliberately never converts an HTML capture into policy authority.
 * It does not mint consents, grants, authenticated signatures or orders.
 */
import {createHash} from "node:crypto";

export const OFFICIAL_PREDICTION_FEE_PAGE = "https://kalshi.com/fee-schedule" as const;
const MAX_BYTES=2_000_000;
const TIMEOUT_MS=12_000;
export type FeePageCandidate =
 | {ok:true;reason:"official_prediction_fee_page_bytes_captured_for_review";
    canonicalUrl:typeof OFFICIAL_PREDICTION_FEE_PAGE;capturedAt:string;
    sha256:string;byteLength:number;providerContentReceived:true;
    currentFeeFormulaVerified:false;sourcePolicyApproved:false;
    exchangeExecutionAuthorized:false}
 | {ok:false;reason:string;providerContentReceived:false;
    currentFeeFormulaVerified:false;sourcePolicyApproved:false;
    exchangeExecutionAuthorized:false};

const fail=(reason:string):FeePageCandidate=>({
 ok:false,reason,providerContentReceived:false,currentFeeFormulaVerified:false,
 sourcePolicyApproved:false,exchangeExecutionAuthorized:false,
});

/**
 * Fixed GET only; no owner-input source URL, redirect, credentials or cache.
 * The caller must separately verify effective fee terms, market overrides,
 * scheduled changes, rounding and versioned approval. Never accept arbitrary
 * user-uploaded bytes or a positive candidate as provider fee AUTHORIZATION.
 */
export async function captureOfficialPredictionFeePage(
 transport:typeof fetch=globalThis.fetch,clock:()=>number=Date.now,
):Promise<FeePageCandidate>{
 const started=clock();
 if(!Number.isSafeInteger(started)||started<=0)
   return fail("capture_clock_invalid");
 try{
  const response=await transport(OFFICIAL_PREDICTION_FEE_PAGE,{
    method:"GET",redirect:"error",cache:"no-store",
    headers:{Accept:"text/html"},
    signal:AbortSignal.timeout(TIMEOUT_MS),
  });
  if(response.status!==200)return fail("official_page_http_"+response.status);
  if(response.redirected || response.url!==OFFICIAL_PREDICTION_FEE_PAGE)
    return fail("official_page_origin_or_redirect_invalid");
  if(response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="text/html")
    return fail("official_page_content_type_invalid");
  const declared=response.headers.get("content-length");
  if(declared!==null && (!/^\d+$/.test(declared)||
      !Number.isSafeInteger(Number(declared))||Number(declared)>MAX_BYTES))
    return fail("official_page_size_invalid");
  if(!response.body)return fail("official_page_body_missing");
  const reader=response.body.getReader();
  const parts:Uint8Array[]=[];
  let size=0;
  try{
   for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>MAX_BYTES){await reader.cancel();return fail("official_page_size_invalid");}
    parts.push(value);
   }
  }finally{reader.releaseLock();}
  if(size<100)return fail("official_page_incomplete");
  const bytes=Buffer.concat(parts,size);
  const preview=bytes.toString("utf8");
  if(!/^\s*<!doctype html/i.test(preview)||
    !/<\/html>\s*$/i.test(preview))
    return fail("official_page_html_invalid");
  const captured=clock();
  if(!Number.isSafeInteger(captured)||captured<started ||
     captured-started>TIMEOUT_MS+3_000)
    return fail("official_page_capture_stale");
  return {ok:true,reason:"official_prediction_fee_page_bytes_captured_for_review",
   canonicalUrl:OFFICIAL_PREDICTION_FEE_PAGE,
   capturedAt:new Date(captured).toISOString(),
   sha256:createHash("sha256").update(bytes).digest("hex"),
   byteLength:bytes.length,providerContentReceived:true,
   currentFeeFormulaVerified:false,sourcePolicyApproved:false,
   exchangeExecutionAuthorized:false};
 }catch{return fail("official_page_network_unavailable");}
}
