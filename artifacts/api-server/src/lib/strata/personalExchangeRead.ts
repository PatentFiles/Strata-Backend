import { getScopedKalshiJson } from "../kalshiAccountClient";
import { maximumEntryFeePerContractMicros, maximumExitFeePerContractMicros } from "../microLiveEntryFees";
import { planV13IocEntry } from "../v13ExecutionPlanner";
import { digest, requireProof, type Identity, type MarketEvidence, type Snapshot } from "../v13-production/types";
import { marketEvidenceFromBook, parseKalshiOrderBook, readSubaccountSpendableCash } from "./personalMarketAdapter";

export const PERSONAL_KALSHI_HOST = "https://external-api.kalshi.com";
export const PERSONAL_MARKET_METADATA_HOST = "https://api.elections.kalshi.com/trade-api/v2";

const BALANCE_PATH = "/trade-api/v2/portfolio/balance";
const ORDER_PATH = "/trade-api/v2/portfolio/orders";
const FILL_PATH = "/trade-api/v2/portfolio/fills";
const POSITION_PATH = "/trade-api/v2/portfolio/positions";
const SETTLEMENT_PATH = "/trade-api/v2/portfolio/settlements";

export interface OwnedKalshiRead {
  ok: true;
  observedAtMs: number;
  cashMicros: string;
  orders: unknown[];
  fills: unknown[];
  positions: unknown[];
  settlements: unknown[];
}

/** Authenticated subaccount reads. A missing or paged feed is a blocker, not an empty account. */
export async function readOwnedKalshiFeeds(
  creds: { keyId: string; privateKey: string },
  nowMs: number,
  get: typeof getScopedKalshiJson = getScopedKalshiJson,
): Promise<OwnedKalshiRead | { ok: false; reason: string }> {
  const query = "?limit=200&subaccount=1";
  let balance: unknown;
  let orders: unknown;
  let fills: unknown;
  let positions: unknown;
  let settlements: unknown;
  try {
    [balance, orders, fills, positions, settlements] = await Promise.all([
      get(creds, BALANCE_PATH, "?subaccount=1"),
      get(creds, ORDER_PATH, query),
      get(creds, FILL_PATH, query),
      get(creds, POSITION_PATH, query),
      get(creds, SETTLEMENT_PATH, query),
    ]);
  } catch {
    return { ok: false, reason: "kalshi_read_failed" };
  }
  const cash = readSubaccountSpendableCash({
    subaccount: 1,
    exchangeIndex: 2,
    observedAtMs: nowMs,
    nowMs,
    maxAgeMs: 15_000,
    subaccountBalance: balance,
    primaryBalance: {},
  });
  if (!cash.ok) return cash;
  const lists = {
    orders: list(orders, ["orders"]),
    fills: list(fills, ["fills"]),
    positions: list(positions, ["market_positions", "positions"]),
    settlements: list(settlements, ["settlements"]),
  };
  if (!lists.orders || !lists.fills || !lists.positions || !lists.settlements) {
    return { ok: false, reason: "personal_exchange_history_unreconciled" };
  }
  return {
    ok: true,
    observedAtMs: nowMs,
    cashMicros: cash.cashMicros,
    orders: lists.orders,
    fills: lists.fills,
    positions: lists.positions,
    settlements: lists.settlements,
  };
}

export function emptySnapshot(identity: Identity, read: OwnedKalshiRead): Snapshot | { ok: false; reason: string } {
  if (read.orders.length || read.fills.length || read.settlements.length || openPositions(read.positions)) {
    return { ok: false, reason: "personal_exchange_history_unreconciled" };
  }
  return {
    identity,
    observedAtMs: read.observedAtMs,
    complete: true,
    authenticated: true,
    historyFromMs: 0,
    cashMicros: read.cashMicros,
    cashExact: true,
    orders: [],
    fills: [],
    settlements: [],
    positions: [],
    unexplainedCashActivity: false,
  };
}

function list(payload: unknown, keys: string[]): unknown[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.cursor === "string" && body.cursor.trim()) return null;
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  return null;
}

/** Binds the verified fee artifact to the live book. A failed metadata read is a blocker. */
export function ownedMarketEvidence(input: {
  market: string;
  side: "YES" | "NO";
  bookPayload: unknown;
  seriesPayload: unknown;
  marketPayload: unknown;
  observedAtMs: number;
  nowMs: number;
  configuredStakeCents: number;
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
  artifactDigest: string;
  policyHash: string;
  verifiedAtMs: number;
}): MarketEvidence {
  const seriesBody = object(input.seriesPayload);
  const marketBody = object(input.marketPayload);
  const series = object(seriesBody.series);
  const metadata = object(marketBody.market);
  const structure = metadata.price_level_structure;
  requireProof(series.ticker === "KXBTC15M" && series.fee_type === "quadratic" &&
    String(series.fee_multiplier) === "1" && metadata.ticker === input.market &&
    metadata.exchange_index === 2 && metadata.status === "active" &&
    (structure === "deci_cent" || structure === "tapered_deci_cent"), "production_fee_or_market_grid_unproven");
  const ticks = structure === "deci_cent" && metadata.price_ranges === undefined
    ? undefined
    : ticksFromRanges(metadata.price_ranges);
  requireProof(ticks === undefined || (ticks !== null && ticks.length > 0), "production_fee_or_market_grid_unproven");
  const book = parseKalshiOrderBook(input.bookPayload);
  const asks = asksFor(input.side, book);
  const bestAsk = asks[0]?.priceDollars ?? null;
  const plan = planV13IocEntry({
    signal: Number(bestAsk) <= 0.52 ? "SCOUT" : "CONFIRM",
    direction: input.side === "YES" ? "UP" : "DOWN",
    referenceOffer: Number(bestAsk),
    maxStakeCents: input.configuredStakeCents,
    bestAskDollars: bestAsk,
    askLevels: asks,
  });
  const count = plan.ok ? plan.plan.contracts : 1;
  const limit = plan.ok ? plan.plan.limitPrice : Number(bestAsk);
  const side = input.side.toLowerCase() as "yes" | "no";
  const entry = maximumEntryFeePerContractMicros(1, limit.toFixed(4), ticks ?? undefined, side);
  const exit = maximumExitFeePerContractMicros(1, ticks ?? undefined, side);
  requireProof(entry !== null && exit !== null && Number.isSafeInteger(input.verifiedAtMs), "fee_evidence_missing");
  const bound = digest({ policyHash: input.policyHash, artifact: input.artifactDigest });
  const fingerprint = digest({
    bound, series, grid: metadata.price_level_structure, count, limit, entry, exit,
  });
  return marketEvidenceFromBook({
    market: input.market,
    side: input.side,
    book,
    observedAtMs: input.observedAtMs,
    nowMs: input.nowMs,
    maxAgeMs: 15_000,
    fee: {
      policyVersion: input.policyVersion,
      sourceUrl: input.sourceUrl,
      formulaVersion: input.formulaVersion,
      fingerprint,
      verifiedAtMs: input.verifiedAtMs,
      contracts: count,
      limitPrice: limit,
      reservedEntryFeeCents: Math.ceil(entry * count / 10_000),
      reservedExitFeeCents: Math.ceil(exit * count / 10_000),
    },
  });
}

function ticksFromRanges(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const ticks = new Set<number>();
  let previousEnd = -1;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const band = item as Record<string, unknown>;
    const start = fourDecimalTick(band.start);
    const end = fourDecimalTick(band.end);
    const step = fourDecimalTick(band.step);
    if (start === null || end === null || step === null || step === 0 ||
        start > end || start < previousEnd || (end - start) % step !== 0) return null;
    for (let tick = start; tick <= end; tick += step) ticks.add(tick);
    previousEnd = end;
  }
  const orderable = [...ticks].filter((tick) => tick > 0 && tick < 10_000).sort((a, b) => a - b);
  return orderable.length > 0 ? orderable : null;
}

function fourDecimalTick(value: unknown): number | null {
  if (typeof value !== "string" || !/^(\d)\.(\d{4})$/.test(value)) return null;
  const tick = Number(value[0]) * 10_000 + Number(value.slice(2));
  return Number.isSafeInteger(tick) && tick >= 0 && tick <= 10_000 ? tick : null;
}

function asksFor(side: "YES" | "NO", book: ReturnType<typeof parseKalshiOrderBook>) {
  const opposite = side === "YES" ? book.noBids : book.yesBids;
  return opposite.map((level) => {
    const complementary = (10_000 - Math.round(Number(level.priceDollars) * 10_000)) / 10_000;
    return { priceDollars: complementary.toFixed(4), availableContracts: level.availableContracts };
  }).sort((a, b) => Number(a.priceDollars) - Number(b.priceDollars));
}

function object(value: unknown): Record<string, unknown> {
  requireProof(value && typeof value === "object" && !Array.isArray(value), "production_market_metadata_invalid");
  return value as Record<string, unknown>;
}

function openPositions(rows: unknown[]): boolean {
  return rows.some((row) => {
    if (!row || typeof row !== "object") return true;
    const position = (row as Record<string, unknown>).position_fp ?? (row as Record<string, unknown>).position;
    return position !== undefined && position !== 0 && position !== "0" && position !== "0.00";
  });
}
