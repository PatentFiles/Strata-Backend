export type KalshiMarket = {
  ticker: string;
  title: string;
  target: number | null;
  closeTime: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  yesPrice: number | null;
  noPrice: number | null;
  result: 'yes' | 'no' | null;
  status: string;
  fetchedAt: number;
};

export type BtcTick = {
  price: number;
  time: number;
  productId: string;
};

const KALSHI_MARKETS_URL =
  '/api/kalshi/markets/open';
const KALSHI_BASE_URL =
  '/api/kalshi/markets';

const cacheBustedUrl = (url: string) =>
  `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const firstNumber = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = asNumber(source[key]);
    if (value !== null) return value;
  }
  return null;
};

const firstString = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
};

const parseTarget = (market: Record<string, unknown>) => {
  const direct = firstNumber(market, [
    'floor_strike',
    'floorStrike',
    'strike',
    'target',
    'threshold',
  ]);
  if (direct !== null) return direct;

  const text = [market.title, market.subtitle, market.yes_sub_title]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const match = text.replaceAll(',', '').match(/\$?(\d{4,6}(?:\.\d+)?)/);
  return match ? asNumber(match[1]) : null;
};

const normalizeCents = (value: number | null) => {
  if (value === null) return null;
  return value > 1 ? value / 100 : value;
};

const normalizeMarket = (value: unknown): KalshiMarket | null => {
  if (!value || typeof value !== 'object') return null;
  const market = value as Record<string, unknown>;
  const ticker = firstString(market, ['ticker', 'market_ticker']);
  if (!ticker) return null;

  const yesBid = normalizeCents(
    firstNumber(market, [
      'yes_bid',
      'yes_bid_dollars',
      'yesBid',
      'best_yes_bid',
    ]),
  );
  const yesAsk = normalizeCents(
    firstNumber(market, [
      'yes_ask',
      'yes_ask_dollars',
      'yesAsk',
      'best_yes_ask',
    ]),
  );
  const noBid = normalizeCents(
    firstNumber(market, [
      'no_bid',
      'no_bid_dollars',
      'noBid',
      'best_no_bid',
    ]),
  );
  const noAsk = normalizeCents(
    firstNumber(market, [
      'no_ask',
      'no_ask_dollars',
      'noAsk',
      'best_no_ask',
    ]),
  );
  const lastPrice = normalizeCents(
    firstNumber(market, [
      'last_price',
      'last_price_dollars',
      'lastPrice',
      'yes_price',
    ]),
  );

  const yesPrice =
    yesBid !== null && yesAsk !== null
      ? (yesBid + yesAsk) / 2
      : yesAsk ?? yesBid ?? lastPrice;
  const noPrice =
    noBid !== null && noAsk !== null
      ? (noBid + noAsk) / 2
      : noAsk ?? noBid ?? (yesPrice === null ? null : 1 - yesPrice);

  const resultValue = firstString(market, ['result', 'settlement_result']);
  const result =
    resultValue === 'yes' || resultValue === 'no' ? resultValue : null;

  return {
    ticker,
    title:
      firstString(market, ['title', 'subtitle']) ??
      'KXBTC15M market',
    target: parseTarget(market),
    closeTime: firstString(market, [
      'close_time',
      'closeTime',
      'expiration_time',
      'expirationTime',
    ]),
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesPrice,
    noPrice,
    result,
    status: firstString(market, ['status']) ?? 'open',
    fetchedAt: Date.now(),
  };
};

async function parseMarketsResponse(
  response: Response,
): Promise<KalshiMarket[]> {
  if (!response.ok) {
    throw new Error(`Kalshi market data returned ${response.status}`);
  }

  const payload: unknown = await response.json();
  const rawMarkets =
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { markets?: unknown }).markets)
      ? (payload as { markets: unknown[] }).markets
      : [];

  return rawMarkets
    .map(normalizeMarket)
    .filter((market): market is KalshiMarket => market !== null);
}

export async function fetchKxbtc15mMarketByTicker(
  ticker: string,
  signal?: AbortSignal,
): Promise<KalshiMarket> {
  const response = await fetch(
    cacheBustedUrl(`${KALSHI_BASE_URL}/${encodeURIComponent(ticker)}`),
    {
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    },
  );
  const markets = await parseMarketsResponse(response);
  if (!markets[0]) throw new Error('Kalshi returned no market for this ticker');
  return markets[0];
}

export async function fetchOpenKxbtc15mMarket(
  signal?: AbortSignal,
): Promise<KalshiMarket> {
  const response = await fetch(cacheBustedUrl(KALSHI_MARKETS_URL), {
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const markets = (await parseMarketsResponse(response))
    .filter((market) => market.status === 'open' || market.status === 'active');

  if (markets.length === 0) {
    throw new Error('No open KXBTC15M market is currently available');
  }

  const now = Date.now();
  const futureMarkets = markets.filter((market) => {
    const closeTime = market.closeTime ? Date.parse(market.closeTime) : NaN;
    return Number.isFinite(closeTime) && closeTime > now;
  });

  return [...(futureMarkets.length > 0 ? futureMarkets : markets)].sort(
    (a, b) => {
      const aClose = a.closeTime ? Date.parse(a.closeTime) : Number.MAX_VALUE;
      const bClose = b.closeTime ? Date.parse(b.closeTime) : Number.MAX_VALUE;
      return aClose - bClose;
    },
  )[0];
}

export function createCoinbaseSocket(
  onTick: (tick: BtcTick) => void,
  onStatus: (status: 'connecting' | 'open' | 'closed' | 'error') => void,
) {
  const socket = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  onStatus('connecting');

  socket.addEventListener('open', () => {
    onStatus('open');
    socket.send(
      JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['ticker'],
      }),
    );
  });

  socket.addEventListener('message', (event) => {
    try {
      const message: unknown = JSON.parse(String(event.data));
      if (!message || typeof message !== 'object') return;
      const data = message as Record<string, unknown>;
      if (data.type !== 'ticker' || data.product_id !== 'BTC-USD') return;
      const price = asNumber(data.price);
      if (price === null) return;
      onTick({
        price,
        time: Date.now(),
        productId: 'BTC-USD',
      });
    } catch {
      // Ignore malformed provider frames; the socket status remains visible.
    }
  });

  socket.addEventListener('close', () => onStatus('closed'));
  socket.addEventListener('error', () => onStatus('error'));

  return () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'unsubscribe',
          product_ids: ['BTC-USD'],
          channels: ['ticker'],
        }),
      );
    }
    socket.close();
  };
}
