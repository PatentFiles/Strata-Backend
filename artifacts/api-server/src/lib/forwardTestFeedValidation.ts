import type {BtcObservation, MarketObservation} from "./forwardTestFeeds";

// Producer-only gate; live source freshness remains independently capped at five seconds.
const FRESHNESS_MS = 15_000;
function validOffer(value:number|null):value is number {
 return value!==null && Number.isFinite(value) && value>0 && value<=1;
}

export function forwardTestFeedError(
  btc: BtcObservation,
  market: MarketObservation,
  now: Date,
  hasOpenPosition: boolean,
  entryBookQuotesPending = false,
) {
  const age = (value: Date) => now.getTime() - value.getTime();
  if (!Number.isFinite(btc.price) || btc.price <= 0 ||
      !Number.isFinite(btc.receivedAt.getTime()) ||
      !Number.isFinite(btc.providerAt.getTime()) ||
      age(btc.providerAt) < -FRESHNESS_MS || age(btc.providerAt) > FRESHNESS_MS ||
      age(btc.receivedAt) < -FRESHNESS_MS || age(btc.receivedAt) > FRESHNESS_MS) {
    return "Coinbase BTC feed is missing, malformed, or stale";
  }
  if (!market.ticker.startsWith("KXBTC15M")) return "Kalshi market ticker is invalid";
  if (!Number.isFinite(market.fetchedAt.getTime()) ||
      age(market.fetchedAt) < -FRESHNESS_MS || age(market.fetchedAt) > FRESHNESS_MS)
    return "Kalshi market snapshot is missing or stale";
  if (market.endsAt === null || !Number.isFinite(market.endsAt.getTime()))
    return "Kalshi market end time is missing or invalid";
  if (market.target === null || !Number.isFinite(market.target) || market.target <= 0)
    return "Kalshi exact market strike is missing or invalid";
  if (!hasOpenPosition && (
    market.startsAt === null || !Number.isFinite(market.startsAt.getTime()) ||
    market.startsAt.getTime() > now.getTime() ||
    market.startsAt.getTime() >= market.endsAt.getTime() ||
    (market.status !== "open" && market.status !== "active") ||
    market.endsAt.getTime() <= now.getTime() ||
    (!entryBookQuotesPending && (!validOffer(market.yesAsk) || !validOffer(market.noAsk)))
  )) return "Kalshi market is closed or a required side offer is missing";
  if (hasOpenPosition && market.result === null &&
      market.endsAt.getTime() > now.getTime() &&
      market.status !== "open" && market.status !== "active") {
    return "Open paper position's Kalshi market is no longer active without settlement";
  }
  if (hasOpenPosition && market.result === null &&
      market.endsAt.getTime() > now.getTime() &&
      (!validOffer(market.yesPrice) || !validOffer(market.noPrice) ||
       !validOffer(market.yesBid) || !validOffer(market.noBid))) {
    return "Open paper position cannot be marked or exited with a missing executable bid";
  }
  // An already-open position can settle only from an explicit Kalshi result.
  // Expiry alone is not settlement evidence, and a missing quote never
  // authorizes a new entry.
  return null;
}
