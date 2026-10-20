import { verifyMonetaryFeeContract } from "./monetaryFeeContract";
import { probeCurrentKalshiFeeApi, REVIEWED_REFERENCE_PDF_SHA256 } from "./twoSourceFeeEvidence";
import { preparePdfFreeApiFeePolicyReview } from "./apiFeePolicyReviewCandidate";
import { INDEPENDENT_OFFICIAL_FEE_SNAPSHOT, officialFeeSnapshotLeaseValid } from "./verifiedOfficialFeeSnapshotLease";

/** Preflight does not grant permission to trade. A current official PDF fetch
 * remains primary. The reviewed, 24-hour provider-origin capture is used only
 * when the PDF transport is unavailable, and MUST be corroborated by fresh
 * independent live official Kalshi series/event/market fee metadata.
 *
 * Do not use this preflight result to bypass final order-entry fee checks.
 */
export type ProtectiveFeePreflight =
 | {ok:true;reason:string;sourceDigest:string;verifiedAt:string;sourceKind:"direct_official_pdf"|"unexpired_reviewed_official_pdf_lease";tradingAuthorized:false}
 | {ok:false;reason:string;tradingAuthorized:false};

type Direct=typeof verifyMonetaryFeeContract;
type Probe=typeof probeCurrentKalshiFeeApi;
type Dependencies={direct?:Direct;probe?:Probe;now?:()=>number};
const allowedFallbackReasons=new Set([
  "official_monetary_fee_source_unavailable",
  "official_fee_schedule_unavailable",
  "official_fee_schedule_http_429",
]);

export async function verifyProtectiveReleaseFeePreflight(deps:Dependencies={}):Promise<ProtectiveFeePreflight>{
 const direct=deps.direct??verifyMonetaryFeeContract;
 let status:Awaited<ReturnType<Direct>>;
 try{status=await direct("STEP_11");}
 catch{return {ok:false,reason:"current_official_fee_evidence_unavailable",tradingAuthorized:false};}
 if(status.ok && status.monetaryFeeAuthorized && status.sourceDigest&&status.verifiedAt)
  return {ok:true,reason:"current_official_pdf_and_market_metadata_verified",
   sourceDigest:status.sourceDigest,verifiedAt:status.verifiedAt,
   sourceKind:"direct_official_pdf",tradingAuthorized:false};
 if(!allowedFallbackReasons.has(status.reason))
  return {ok:false,reason:status.reason,tradingAuthorized:false};
 const now=(deps.now??Date.now)();
 if(!officialFeeSnapshotLeaseValid(now))
  return {ok:false,reason:"independent_official_fee_snapshot_expired",tradingAuthorized:false};
 const snapshot=INDEPENDENT_OFFICIAL_FEE_SNAPSHOT;
 if(snapshot.sha256!==REVIEWED_REFERENCE_PDF_SHA256||
    snapshot.url!=="https://kalshi.com/docs/kalshi-fee-schedule.pdf"||
    snapshot.byteLength!==281129)
   return {ok:false,reason:"independent_official_fee_snapshot_identity_invalid",tradingAuthorized:false};
 try{
  const observation=await (deps.probe??probeCurrentKalshiFeeApi)(globalThis.fetch,()=>now);
  const reviewed=preparePdfFreeApiFeePolicyReview(observation,now);
  if(!reviewed.ok)
    return {ok:false,reason:"current_official_market_fee_not_verified",tradingAuthorized:false};
  const verifiedAt=reviewed.verifiedAt;
  if(!Number.isFinite(Date.parse(verifiedAt))||now-Date.parse(verifiedAt)>10_000)
    return {ok:false,reason:"current_official_fee_metadata_expired",tradingAuthorized:false};
  return {ok:true,reason:"reviewed_current_official_pdf_snapshot_and_live_fee_metadata_verified",
    sourceDigest:snapshot.sha256,verifiedAt,
    sourceKind:"unexpired_reviewed_official_pdf_lease",tradingAuthorized:false};
 }catch{
  return {ok:false,reason:"current_official_market_fee_unavailable",tradingAuthorized:false};
 }
}
