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
