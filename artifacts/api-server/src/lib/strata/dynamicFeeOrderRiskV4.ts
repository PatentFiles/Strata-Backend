/**
 * #165 V4 provider-model-aware fee pretrade risk kernel.
 *
 * No network, secrets, SQL writes, authorizations or order submission here.
 * Inputs MUST originate from (a) the authenticated, locked account/policy,
 * (b) a separately owner-approved exact model digest and deployed SHA, and
 * (c) a fresh issuer + exact-market observation. A success from this kernel
 * alone must NEVER enable a trade; the signed POST must retain all legacy
 * account, worker, kill, liquidity, exposure, and protective-exit fences.
 */
import {estimateDynamicFeeMicros,type DynamicFeeModel} from "./dynamicOfficialFeeSchedule";

const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const MICROS_PER_CENT=10_000n;
const MAX_AGE_MS=10_000;
export const DYNAMIC_FEE_POLICY_VERSION_V4="strata_owner_provider_dynamic_fee_v4" as const;

export type VersionedFeeAuthorityV4={
  policyVersion:typeof DYNAMIC_FEE_POLICY_VERSION_V4;
  ownerId:string;executionAccountId:string;marketTicker:string;
  modelDigest:string;officialPublicationDigest:string;
  deployedSha:string;approvedAtMs:number;expiresAtMs:number;
  revokedAtMs:null|number;
  authorizedStages:readonly string[];
  maxGrossEntryCents:number;maxAllInEntryCents:number;
};
export type ExactOrderRiskV4={
  ownerId:string;executionAccountId:string;deployedSha:string;
  marketTicker:string;side:"YES"|"NO";action:"BUY"|"SELL";
  reduceOnly:boolean;timeInForce:"IOC";postOnly:false;
  limitPriceTicks:number;contractsHundredths:number;
  availableCashCents:number;capitalRemainingCents:number;
  approvedPolicyGrossCents:number;approvedPolicyAllInCents:number;
  reservedExitFeeCents:number;nowMs:number;
};
export type DynamicFeeRiskResult=
 | {ok:true;grossMicros:bigint;maximumEntryFeeMicros:bigint;
    allInCents:number;modelDigest:string;tradingAuthorized:false}
 | {ok:false;reason:string;tradingAuthorized:false};
const deny=(reason:string):DynamicFeeRiskResult=>({ok:false,reason,tradingAuthorized:false});
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const integer=(x:number)=>Number.isSafeInteger(x)&&x>=0;

/**
 * Accept only a fresh EXACT model matching the one approved for the
 * OWNER/ACCOUNT/DEPLOYMENT/MARKET, including publication and version.
 * A dynamic observation is not itself executable consent.
 */
export function boundDynamicFeeEntryV4(
 approval:VersionedFeeAuthorityV4,observed:DynamicFeeModel,
 order:ExactOrderRiskV4,
):DynamicFeeRiskResult {
 if(!approval||!observed||!order)
   return deny("v4_fee_inputs_missing");
 if(approval.policyVersion!==DYNAMIC_FEE_POLICY_VERSION_V4||
    !DIGEST.test(approval.modelDigest)||!DIGEST.test(approval.officialPublicationDigest)||
    !SHA.test(approval.deployedSha)||!SHA.test(order.deployedSha)||
    approval.deployedSha!==order.deployedSha||
    approval.ownerId!==order.ownerId||
    approval.executionAccountId!==order.executionAccountId||
    approval.marketTicker!==order.marketTicker||
    !MARKET.test(order.marketTicker))
   return deny("v4_fee_owner_account_sha_or_market_mismatch");
 if(!Array.isArray(approval.authorizedStages)||
    !approval.authorizedStages.includes("ORDER_ENTRY")||
    approval.revokedAtMs!==null||
    !integer(approval.approvedAtMs)||!integer(approval.expiresAtMs)||
    !integer(order.nowMs)||approval.approvedAtMs>order.nowMs||
    approval.expiresAtMs-order.nowMs<=30_000||
    approval.expiresAtMs-approval.approvedAtMs>15*60_000)
   return deny("v4_fee_owner_consent_revoked_expired_or_out_of_scope");
 const observedAt=Date.parse(observed.observedAt);
 if(!Number.isFinite(observedAt)||observedAt>order.nowMs||
    order.nowMs-observedAt>MAX_AGE_MS||
    observed.modelDigest!==approval.modelDigest||
    observed.publicationDigest!==approval.officialPublicationDigest||
    observed.marketTicker!==order.marketTicker||
    !DIGEST.test(observed.metadataDigest)||!DIGEST.test(observed.modelDigest)||
    observed.tradingAuthorized!==false||
    observed.requiresVersionedReview!==true)
   return deny("v4_provider_fee_model_changed_stale_or_unverified");
 if(order.action!=="BUY"||order.reduceOnly!==false||
    order.timeInForce!=="IOC"||order.postOnly!==false||
    !["YES","NO"].includes(order.side))
   return deny("v4_entry_order_type_invalid");
 const nums=[approval.maxGrossEntryCents,approval.maxAllInEntryCents,
    order.limitPriceTicks,order.contractsHundredths,
    order.availableCashCents,order.capitalRemainingCents,
    order.approvedPolicyGrossCents,order.approvedPolicyAllInCents,
    order.reservedExitFeeCents];
 if(nums.some(x=>!integer(x))||
    order.limitPriceTicks<1||order.limitPriceTicks>9999||
    order.contractsHundredths<1||order.contractsHundredths>100_000_000||
    approval.maxGrossEntryCents<500||
    approval.maxAllInEntryCents<approval.maxGrossEntryCents||
    order.approvedPolicyGrossCents<500||
    order.approvedPolicyAllInCents<order.approvedPolicyGrossCents)
   return deny("v4_entry_price_quantity_or_limits_invalid");
 if(observed.defaultTakerMultiplierPpm<0||
    observed.defaultTakerMultiplierPpm>1_000_000||
    !integer(observed.takerRatePpm))
   return deny("v4_fee_formula_or_multiplier_invalid");
 // Every hundredth of a contract may fill separately and incur its own
 // rounding. For IOC, buyer gross cost is worst at the order's exact limit.
 // Fee exposure is maximal where P(1-P) peaks. If limit exceeds 50c,
 // quote a 50c fill as well even though gross uses the higher limit price.
 const feePriceTicks=Math.min(order.limitPriceTicks,5000);
 const feePerHundredth=estimateDynamicFeeMicros(
    observed.takerRatePpm,observed.defaultTakerMultiplierPpm,
    1,feePriceTicks);
 if(feePerHundredth===null)return deny("v4_dynamic_fee_bound_unavailable");
 const units=BigInt(order.contractsHundredths);
 const grossMicros=units*BigInt(order.limitPriceTicks);
 // Sum independently ceiled fee amounts. No maker discount or rebate
 // credit is allowed on IOC entry, even if the book reports maker liquidity.
 const maximumEntryFeeMicros=feePerHundredth*units;
 const allInMicros=grossMicros+maximumEntryFeeMicros+
    BigInt(order.reservedExitFeeCents)*MICROS_PER_CENT;
 const grossCents=ceil(grossMicros,MICROS_PER_CENT);
 const allInCentsBig=ceil(allInMicros,MICROS_PER_CENT);
 if(allInCentsBig>BigInt(Number.MAX_SAFE_INTEGER))
    return deny("v4_all_in_precision_overflow");
 const allInCents=Number(allInCentsBig);
 if(grossCents<500n||grossCents>BigInt(approval.maxGrossEntryCents)||
    grossCents>BigInt(order.approvedPolicyGrossCents)||
    allInCents>approval.maxAllInEntryCents||
    allInCents>order.approvedPolicyAllInCents||
    allInCents>order.availableCashCents||
    allInCents>order.capitalRemainingCents)
   return deny("v4_fee_inclusive_risk_limit_exceeded");
 return {ok:true,grossMicros,maximumEntryFeeMicros,
   allInCents,modelDigest:observed.modelDigest,tradingAuthorized:false};
}
