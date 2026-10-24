/**
 * Prospective V1.3 SHADOW-only entry overlay: >=30 seconds to expiry and
 * max 20 whole contracts, within an illustrative fee-inclusive $5 budget.
 *
 * This candidate has NO live or paper champion execution authority and never
 * changes exits, fee approval, cash, risk settings or venue orders. The 7%
 * coefficient is an UNVERIFIED stress proxy, not an effective Kalshi fee grant.
 */
import { illustrativeQuadraticFeeCents } from "./v13ResearchExecutionStress";

export const NEAR_EXPIRY_CAP_RESEARCH_ID="v13-research-min30-cap20" as const;
export const NEAR_EXPIRY_CAP_RESEARCH_VERSION=1_300_006 as const;
export const MIN_RESEARCH_SECONDS_REMAINING=30;
export const MAX_RESEARCH_CONTRACTS=20;
const BUDGET_MICROS=5_000_000n; // $5 fee inclusive (research assumption)
const MICRO_PER_TICK=100n;
const MICRO_PER_CENT=10_000n;

export type NearExpiryCapDecision={
  mode:"RESEARCH_SHADOW_ONLY";
  executionAuthority:false;
  providerFeeVerified:false;
  wouldEnter:boolean;
  modeledContracts:number;
  illustrativeEntryFeeCents:number;
  reason:"INSUFFICIENT_TIME"|"INVALID_ENTRY_QUOTE"|"INSUFFICIENT_FEE_INCLUSIVE_CASH"|"RESEARCH_CANDIDATE";
};

/** `secondsRemaining` must be observed at the SAME prospective evaluation. */
export function assessNearExpiryCapShadow(
  secondsRemaining:number|null,
  entryOffer:number|null,
):NearExpiryCapDecision{
  const result=(reason:NearExpiryCapDecision["reason"],qty=0,fee=0):NearExpiryCapDecision=>({
    mode:"RESEARCH_SHADOW_ONLY",executionAuthority:false,providerFeeVerified:false,
    wouldEnter:reason==="RESEARCH_CANDIDATE",modeledContracts:qty,
    illustrativeEntryFeeCents:fee,reason,
  });
  if(secondsRemaining===null||!Number.isFinite(secondsRemaining)||
     secondsRemaining<MIN_RESEARCH_SECONDS_REMAINING)return result("INSUFFICIENT_TIME");
  if(entryOffer===null||!Number.isFinite(entryOffer)||entryOffer<=0||entryOffer>=1)
    return result("INVALID_ENTRY_QUOTE");
  const priceTicks=Math.round(entryOffer*10_000);
  if(Math.abs(priceTicks-entryOffer*10_000)>0.000001||priceTicks<1||priceTicks>=10000)
    return result("INVALID_ENTRY_QUOTE");
  for(let qty=MAX_RESEARCH_CONTRACTS;qty>=1;qty--){
    const feeCents=illustrativeQuadraticFeeCents(qty,priceTicks,700);
    const priceMicros=BigInt(qty)*BigInt(priceTicks)*MICRO_PER_TICK;
    if(priceMicros+feeCents*MICRO_PER_CENT<=BUDGET_MICROS)
      return result("RESEARCH_CANDIDATE",qty,Number(feeCents));
  }
  return result("INSUFFICIENT_FEE_INCLUSIVE_CASH");
}
