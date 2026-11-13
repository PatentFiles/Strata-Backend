import { createHash } from "node:crypto";

/** Exact immutable human-review decision text. Changes invalidate signatures. */
export const PDF_FREE_API_RATE_REVIEW_DECISION_TEXT = `STRATA_API_FEE_RATE_REVIEW_V1
This is a proposed KXBTC15M Exchange Index 2 conservative reference calculation.
Issuer evidence: https://external-api.kalshi.com/trade-api/v2 current series/event/market and fee_changes.
Reference: conservative whole-cent ceiling of 0.07 * C * P * (1 - P), multiplier exactly 1.
This reference is NOT official execution-receipt proof of Kalshi's live charged fees.
A reviewer must separately confirm current effective fee/rounding rules and allowed exceptions.
Entry and protective-exit orders require their own fresh fee-inclusive verification.
Approved owner-specific source policy, account commissioning, live execution and orders
require separate signed decisions; this model-review text confers NONE of them.
` as const;
export const PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 =
  createHash("sha256").update(PDF_FREE_API_RATE_REVIEW_DECISION_TEXT).digest("hex");

/**
 * Fee calculation reference vectors for INDEPENDENT review of a PDF-free
 * KXBTC15M rate-policy. This is a conservative whole-cent risk upper bound,
 * NOT a claim that Kalshi charged these amounts on any particular execution.
 * KXBTC15M exact exchange fees must be independently attested against current
 * official rate documentation and observed fee receipts before policy signing.
 *
 * Formula used solely for this offline review: ceil(0.07*C*P*(1-P), 0.01 USD).
 * Prices are 6dp dollar micros. All arithmetic is bigint to prevent rounding
 * or floating point errors. Not imported into production execution guards.
 */
export const PDF_FREE_RATE_REVIEW_VECTOR_VERSION =
  "kalshi_quadratic_007_whole_cent_conservative_reference_v1" as const;

const PRICE_PRECISION = 1_000_000n;
const CENT_DENOMINATOR = PRICE_PRECISION * PRICE_PRECISION;

/**
 * Exact WHOLE-CENT rounded-up reference for a proposed general taker model.
 * This deliberately does NOT authorize a trade or replace the live exchange
 * fee model. Returns null for invalid price/quantity.
 */
export function conservativeWholeCentTakerReference(
  priceMicros: bigint, contracts: bigint, multiplier: bigint = 1n,
): bigint | null {
  if (priceMicros<=0n || priceMicros>=PRICE_PRECISION ||
      contracts<=0n || contracts>1_000_000n ||
      multiplier!==1n) return null;
  // 100 cents/dollar * 0.07 = 7. Denom is 10^12.
  const centNumerator=7n*contracts*priceMicros*
    (PRICE_PRECISION-priceMicros)*multiplier;
  return (centNumerator+CENT_DENOMINATOR-1n)/CENT_DENOMINATOR;
}

export const TAKER_FEE_REVIEW_VECTORS = Object.freeze([
  {priceMicros:10_000n, contracts:1n, maximumCents:1n},
  {priceMicros:50_000n, contracts:100n, maximumCents:34n},
  {priceMicros:100_000n, contracts:100n, maximumCents:63n},
  {priceMicros:250_000n, contracts:100n, maximumCents:132n},
  {priceMicros:500_000n, contracts:1n, maximumCents:2n},
  {priceMicros:500_000n, contracts:100n, maximumCents:175n},
  {priceMicros:900_000n, contracts:100n, maximumCents:63n},
  {priceMicros:990_000n, contracts:100n, maximumCents:7n},
]);

export function validateConservativeFeeVectors(): boolean {
 return TAKER_FEE_REVIEW_VECTORS.every(v=>
    conservativeWholeCentTakerReference(v.priceMicros,v.contracts)===
      v.maximumCents);
}


/**
 * Pure fixed-point pre-trade UPPER BOUNDS for the documented general quadratic
 * taker model; one dollar is 1,000,000 integer micros. Kalshi separately
 * documents (a) 6-decimal trade fee rounding, (b) alignment of account balance
 * changes to 100 micros for direct members or 10,000 micros otherwise,
 * and (c) per-order rebates across partial fills.
 *
 * We IGNORE future rebates, allow up to one model-rounding micro per fill
 * and a full balance-grid loss per fill. This intentionally overestimates
 * execution debits, even if an order splits into many partial fills.
 *
 * This is NOT provider proof that 0.07/multiplier=1 applies to the market.
 * Consumers MUST independently validate the official current effective
 * coefficient, overrides and changes before invoking this as an execution
 * authorization. It is NOT wired to order-entry or commissioning.
 */
export type KalshiAccountBalanceGridMicros = 100n | 10_000n;

function conservativeFixedPointBound(
  modelFeeNumerator: bigint, contracts: bigint,
  balanceGridMicros: KalshiAccountBalanceGridMicros, maxFills: bigint,
): bigint | null {
  if (contracts < 1n || contracts > 1_000_000n ||
      maxFills < 1n || maxFills > contracts ||
      (balanceGridMicros !== 100n && balanceGridMicros !== 10_000n)) return null;
  // Multiplier=1: model fee in micros
  // = (7/100) * contracts * priceMicros * (1e6-priceMicros) / 1e6.
  const modelMicrosCeil=(modelFeeNumerator+100_000_000n-1n)/100_000_000n;
  // Ceil per fill can exceed ceil of aggregate by at most fills-1 micros.
  const perFillTradeRounding=maxFills-1n;
  // Ignore all rebates; each fill's alignment costs strictly below one grid.
  const perFillBalanceRounding=maxFills*(balanceGridMicros-1n);
  return modelMicrosCeil+perFillTradeRounding+perFillBalanceRounding;
}

/** Bound at a FIXED, known exact executed price, not a limit-order price. */
export function conservativeExactFillFeeAndRoundingBoundMicros(
  priceMicros: bigint, contracts: bigint,
  balanceGridMicros: KalshiAccountBalanceGridMicros,maxFills: bigint,
): bigint | null {
 if (priceMicros<=0n || priceMicros>=PRICE_PRECISION) return null;
 const numerator=7n*contracts*priceMicros*(PRICE_PRECISION-priceMicros);
 return conservativeFixedPointBound(numerator,contracts,balanceGridMicros,maxFills);
}

/**
 * Bound for UNKNOWN fill prices in a standard KXBTC15M quadratic taker order:
 * p*(1-p) <= 1/4, so maximum model fee is 17,500 micros/contract.
 * It remains an OFFLINE reference until source applicability and order
 * execution gates have been independently validated.
 */
export function conservativeUnknownPriceFeeAndRoundingBoundMicros(
  contracts: bigint,balanceGridMicros: KalshiAccountBalanceGridMicros,
  maxFills: bigint,
): bigint | null {
 const numerator=7n*contracts*500_000n*500_000n;
 return conservativeFixedPointBound(numerator,contracts,balanceGridMicros,maxFills);
}
