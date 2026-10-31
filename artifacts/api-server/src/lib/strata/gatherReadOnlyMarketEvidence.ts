import { createMarketEvidenceReadTiming, attachMarketEvidenceReadTiming } from "./marketEvidenceReadTiming";
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

/** Each invocation owns fresh reads, including the executor's final POST fence.
 * Independent reads start immediately; only exact market identity unlocks event
 * reads. Every branch is mandatory. No retries, caching, orders, or authority.
 */
export async function gatherCompleteReadOnlyMarketEvidence<B>(sources: {
 market: string;
 verifyFee: () => Promise<void>;
 readBook: () => Promise<B>;
 readPublic: (path: string) => Promise<unknown>;
}) {
 // Defer invocation one microtask so even synchronous adapter failures are
 // observed by Promise.all, rather than leaving an earlier promise orphaned.
 let failed=false,firstError:unknown;
 const reject=(error:unknown):never=>{if(!failed){failed=true;firstError=error;}throw error;};
 const start = <T>(read: () => Promise<T>) => Promise.resolve().then(read).catch(reject);
 const timing = createMarketEvidenceReadTiming();
 const fee = start(() => timing.read("fee", sources.verifyFee));
 const book = start(() => timing.read("book", sources.readBook));
 const series = start(() => timing.read("series", () => sources.readPublic("/series/KXBTC15M")));
 const market = start(() => timing.read("market", () => sources.readPublic(`/markets/${encodeURIComponent(sources.market)}`)));
 const seriesChanges = start(() => timing.read("seriesChanges", () => sources.readPublic(
  "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false")));
 const events = market.then(async payload => {
  if(failed)throw firstError;
  const row = payload !== null && typeof payload === "object" && !Array.isArray(payload)
   ? (payload as {market?: unknown}).market : undefined;
  const record = row !== null && typeof row === "object" && !Array.isArray(row)
   ? row as Record<string, unknown> : undefined;
  const event = record?.event_ticker;
  if (!/^KXBTC15M-[A-Za-z0-9-]+$/.test(sources.market) ||
      record?.ticker !== sources.market || record.exchange_index !== 2 ||
      typeof event !== "string" || !/^KXBTC15M-[A-Za-z0-9-]+$/.test(event))
   throw new Error("production_event_fee_evidence_unverified");
  const eventReads=[
   start(() => timing.read("event", () => sources.readPublic(`/events/${encodeURIComponent(event)}`))),
   start(() => timing.read("eventChanges", () => sources.readPublic(`/events/fee_changes?event_ticker=${encodeURIComponent(event)}&limit=100`))),
  ] as const;
  return Promise.all(eventReads).catch(async error=>{await Promise.allSettled(eventReads);throw error;});
 }).catch(reject);
 const pending=[fee,book,series,market,seriesChanges,events] as const;
 // Never leave newly launching reads behind after a rejected invocation. Existing
 // adapters own bounded deadlines; drain them before the worker's next attempt.
 const results=await Promise.all(pending).catch(async()=>{
  await Promise.allSettled(pending);throw firstError;
 });
 const [,bookPayload,seriesPayload,marketPayload,seriesChangesPayload,[eventPayload,eventChangesPayload]] = results;
 return attachMarketEvidenceReadTiming({bookPayload,seriesPayload,marketPayload,seriesChangesPayload,eventPayload,eventChangesPayload}, timing.snapshot());
}
