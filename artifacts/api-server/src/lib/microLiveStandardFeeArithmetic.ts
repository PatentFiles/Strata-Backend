/** Exact multiplier-one form of ceil(700*t*(10000-t)/100000000).
 * This is the existing six-decimal fee for one 0.01-contract fill, not a new
 * fee model. Every integer intermediate is <=17,599,999,999 (<2^35), and the
 * quotient is <176. Its noninteger distance from an integer is >=1e-8,
 * far above binary64 rounding error at that magnitude (<3e-14).
 * Keep generic/non-unit multipliers on the original BigInt implementation.
 */
export function standardFeePerFillMicros(tick:number):bigint|null {
 if(!Number.isSafeInteger(tick)||tick<=0||tick>=10000)return null;
 return BigInt(Math.floor((700*tick*(10000-tick)+99_999_999)/100_000_000));
}
