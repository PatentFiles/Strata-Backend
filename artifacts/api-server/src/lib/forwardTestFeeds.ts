import { fetchKalshiPublicBook, type OrderbookRead } from "./forwardTestOrderbookDepth";
// Public market data only. This module never authenticates with a trading
// account and contains no order endpoint or trading capability.
export type BtcObservation = {
  price: number;
  receivedAt: Date;
  providerAt: Date;
};

export type MarketObservation = {
  ticker: string;
  target: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  yesPrice: number | null;
  noPrice: number | null;
  result: "yes" | "no" | null;
  status: string;
  fetchedAt: Date;
};

export type ForwardTestFeeds = {
  btc: (signal?: AbortSignal) => Promise<BtcObservation>;
  market: (ticker?: string, signal?: AbortSignal) => Promise<MarketObservation>;
  /** Optional research-only, post-decision book read. Injected tests omit it. */
  book?: OrderbookRead;
};

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2/markets";
const COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, fields: string[]) {
  for (const key of fields) {
    const value = numeric(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(source: Record<string, unknown>, fields: string[]) {
  for (const key of fields) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function date(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function offer(value: number | null) {
  return value === null ? null : value > 1 ? value / 100 : value;
}

function targetOf(market: Record<string, unknown>) {
  const direct = firstNumber(market, ["floor_strike", "floorStrike", "strike", "target", "threshold"]);
  if (direct !== null) return direct;
  const title = [market.title, market.subtitle, market.yes_sub_title]
    .filter((part): part is string => typeof part === "string").join(" ");
  const match = title.replaceAll(",", "").match(/\$?(\d{4,6}(?:\.\d+)?)/);
  return match ? numeric(match[1]) : null;
}

function normalizeMarket(value: unknown, fetchedAt: Date): MarketObservation | null {
  if (!value || typeof value !== "object") return null;
  const market = value as Record<string, unknown>;
  const ticker = firstString(market, ["ticker", "market_ticker"]);
  if (!ticker) return null;
  const yesBid = offer(firstNumber(market, ["yes_bid", "yes_bid_dollars", "yesBid", "best_yes_bid"]));
  const yesAsk = offer(firstNumber(market, ["yes_ask", "yes_ask_dollars", "yesAsk", "best_yes_ask"]));
  const noBid = offer(firstNumber(market, ["no_bid", "no_bid_dollars", "noBid", "best_no_bid"]));
  const noAsk = offer(firstNumber(market, ["no_ask", "no_ask_dollars", "noAsk", "best_no_ask"]));
  const last = offer(firstNumber(market, ["last_price", "last_price_dollars", "lastPrice", "yes_price"]));
  const yesPrice = yesBid !== null && yesAsk !== null
    ? (yesBid + yesAsk) / 2 : yesAsk ?? yesBid ?? last;
  const noPrice = noBid !== null && noAsk !== null
    ? (noBid + noAsk) / 2 : noAsk ?? noBid ?? (yesPrice === null ? null : 1 - yesPrice);
  const result = firstString(market, ["result", "settlement_result"]);
  return {
    ticker,
    target: targetOf(market),
    startsAt: date(firstString(market, ["open_time", "openTime"])),
    endsAt: date(firstString(market, ["close_time", "closeTime", "expiration_time", "expirationTime"])),
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesPrice,
    noPrice,
    result: result === "yes" || result === "no" ? result : null,
    status: firstString(market, ["status"]) ?? "open",
    fetchedAt,
  };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Public market feed returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export const publicForwardTestFeeds: ForwardTestFeeds = {
  book: fetchKalshiPublicBook,
  async btc(signal) {
    const raw = await getJson(COINBASE, signal);
    if (!raw || typeof raw !== "object") throw new Error("Coinbase returned malformed BTC data");
    const payload = raw as Record<string, unknown>;
    const price = numeric(payload.price);
    const providerAt = date(payload.time);
    if (price === null || price <= 0 || !providerAt) {
      throw new Error("Coinbase BTC price or timestamp is unavailable");
    }
    return { price, providerAt, receivedAt: new Date() };
  },
  async market(ticker, signal) {
    const url = ticker
      ? `${KALSHI}/${encodeURIComponent(ticker)}`
      : `${KALSHI}?series_ticker=KXBTC15M&status=open&limit=100`;
    const raw = await getJson(url, signal);
    if (!raw || typeof raw !== "object") throw new Error("Kalshi returned malformed market data");
    const payload = raw as { market?: unknown; markets?: unknown[] };
    const fetchedAt = new Date();
    const markets = (payload.market ? [payload.market] : payload.markets ?? [])
      .map((value) => normalizeMarket(value, fetchedAt))
      .filter((value): value is MarketObservation => value !== null);
    const selected = ticker
      ? markets.find((value) => value.ticker === ticker)
      : markets.filter((value) => (value.status === "open" || value.status === "active") &&
        value.endsAt && value.endsAt.getTime() > fetchedAt.getTime())
        .sort((a, b) => a.endsAt!.getTime() - b.endsAt!.getTime())[0];
    if (!selected) throw new Error(`Kalshi returned no current market${ticker ? ` for ${ticker}` : ""}`);
    return selected;
  },
};