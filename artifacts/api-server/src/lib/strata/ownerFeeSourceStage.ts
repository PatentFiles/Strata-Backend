import { REVIEWED_FEE_DIGEST } from "./operatorAttestedFeeEligibility";
import { inspectOwnerFeeSourceReadiness } from "./operatorFeeAuthorizationReadiness";
import { OPERATOR_FEE_SOURCE_POLICY, type FeeAuthorizationStage } from "./operatorFeeSourceAuthorization";
import { STANDARD_QUADRATIC_FEE_FORMULA_VERSION } from "../microLiveFeeArtifact";
const UUID="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE_RE=new RegExp("^strata-operator-attested://kxbtc15m/("+UUID+")/("+UUID+")$","i");
export type OwnerFeeSourceIdentity={
  sourceKind:"operator_attested_not_provider";
  grantId:string; releaseId:string; digest:string;
  policyVersion:typeof OPERATOR_FEE_SOURCE_POLICY;
  sourceUrl:string; formulaVersion:typeof STANDARD_QUADRATIC_FEE_FORMULA_VERSION;
  marketTicker:string; metadataFingerprint:string; verifiedAtMs:number;
};
type Result={ok:true;identity:OwnerFeeSourceIdentity}|{ok:false;reason:string};
export function encodeOwnerFeeSource(grantId:string,releaseId:string):string|null {
  if(!new RegExp("^"+UUID+"$","i").test(grantId)||
     !new RegExp("^"+UUID+"$","i").test(releaseId))return null;
  return `strata-operator-attested://kxbtc15m/${grantId.toLowerCase()}/${releaseId.toLowerCase()}`;
}
export function parseOwnerFeeSource(sourceUrl:string):{grantId:string;releaseId:string}|null {
  const m=SOURCE_RE.exec(sourceUrl);
  return m?{grantId:m[1]!.toLowerCase(),releaseId:m[2]!.toLowerCase()}:null;
}
/**
 * Fresh common authorization for STEP_6 / STEP_9 / STEP_11 / ORDER_ENTRY.
 * A successful result is never a permission to trade on its own.
 * For ORDER_ENTRY the market ticker MUST match the exact pre-POST market.
 */
export async function verifyOwnerFeeSourceStage(
  ownerUserId:string,stage:FeeAuthorizationStage,
  expectedSourceUrl?:string,exactOrderMarket?:string,
):Promise<Result>{
  if(!["STEP_6","STEP_9","STEP_11","ORDER_ENTRY"].includes(stage))
    return {ok:false,reason:"stage_not_supported"};
  if(stage==="ORDER_ENTRY"&&
    (!exactOrderMarket||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(exactOrderMarket)))
    return {ok:false,reason:"exact_market_required"};
  const state=await inspectOwnerFeeSourceReadiness(ownerUserId);
  if(!state.diagnosticEligible||!state.stageChecks[stage]||
     !state.grantId||!state.releaseId||!state.marketTicker||
     !state.metadataFingerprint||!state.metadataVerifiedAt)
    return {ok:false,reason:state.reason};
  const source=encodeOwnerFeeSource(state.grantId,state.releaseId);
  if(!source||expectedSourceUrl&&source!==expectedSourceUrl)
    return {ok:false,reason:"fee_source_policy_identity_mismatch"};
  if(exactOrderMarket&&state.marketTicker!==exactOrderMarket)
    return {ok:false,reason:"exact_kalshi_market_fee_scope_changed"};
  const verifiedAtMs=Date.parse(state.metadataVerifiedAt);
  if(!Number.isSafeInteger(verifiedAtMs)||verifiedAtMs<=0||
     verifiedAtMs>Date.now()||Date.now()-verifiedAtMs>10_000)
    return {ok:false,reason:"market_fee_metadata_stale"};
  return {ok:true,identity:{
    sourceKind:"operator_attested_not_provider",grantId:state.grantId,
    releaseId:state.releaseId,digest:REVIEWED_FEE_DIGEST,
    policyVersion:OPERATOR_FEE_SOURCE_POLICY,sourceUrl:source,
    formulaVersion:STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    marketTicker:state.marketTicker,
    metadataFingerprint:state.metadataFingerprint,verifiedAtMs,
  }};
}
