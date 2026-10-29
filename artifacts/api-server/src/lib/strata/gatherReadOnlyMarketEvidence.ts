/**
 * Overlap independent, read-only evidence fetches for a qualifying market.
 *
 * Fee verification is still mandatory; all four promises must fulfill
 * before the caller can construct a market/evidence object. In particular,
 * this must never perform an order POST, update authority or bypass the
 * executor's transactional and final HTTP wire-clock checks.
 *
 * Calls are started together, but final market admission remains fail-closed.
 */
export async function gatherReadOnlyMarketEvidence<B,S,M>(sources:{
 verifyFee:()=>Promise<void>;
 readBook:()=>Promise<B>;
 readSeries:()=>Promise<S>;
 readMarket:()=>Promise<M>;
}):Promise<{bookPayload:B;seriesPayload:S;marketPayload:M}>{
 const [,bookPayload,seriesPayload,marketPayload]=await Promise.all([
  sources.verifyFee(),sources.readBook(),sources.readSeries(),sources.readMarket(),
 ]);
 return {bookPayload,seriesPayload,marketPayload};
}
