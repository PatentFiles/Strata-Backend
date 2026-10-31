import {validEntryCashRisk} from "../v13EntryCashRisk";
import { ownedBalanceMicros } from "./ownedCashPrecision";
import { cents } from "../v13-production/types";
import { normalizeKalshiMoney } from "./kalshiUserRead";
import type { V13DepthLevel } from "../v13ExecutionPlanner";
import type { V13VerifiedFeeEvidence } from "../v13LiveMoneyEntryPreflight";
import { requireProof, type MarketEvidence } from "../v13-production/types";

const TICKER = /^KXBTC15M[A-Za-z0-9._-]+$/;
const PRICE = /^\d+\.\d{4}$/;

export interface ParsedOrderBook {
  yesBids: V13DepthLevel[];
  noBids: V13DepthLevel[];
}

/** Kalshi bids are one side. The ask is the complementary bid. No fees are invented here. */
export function parseKalshiOrderBook(payload: unknown): ParsedOrderBook {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("market_book_malformed");
  }
  const body = payload as Record<string, unknown>;
  const fixed = body.orderbook_fp !== undefined;
  const book = (fixed ? body.orderbook_fp : body.orderbook);
  if (!book || typeof book !== "object" || Array.isArray(book)) throw new Error("market_book_malformed");
  const row = book as Record<string, unknown>;
  return {
    yesBids: levels(fixed ? row.yes_dollars : row.yes, fixed),
    noBids: levels(fixed ? row.no_dollars : row.no, fixed),
  };
}

export function marketEvidenceFromBook(input: {
  market: string;
  side: "YES" | "NO";
  book: ParsedOrderBook;
  observedAtMs: number;
  nowMs: number;
  maxAgeMs: number;
  fee: V13VerifiedFeeEvidence | null;
}): MarketEvidence {
  requireProof(TICKER.test(input.market), "production_market_invalid");
  requireProof(input.side === "YES" || input.side === "NO", "production_market_side_invalid");
  requireProof(Number.isSafeInteger(input.observedAtMs) && Number.isSafeInteger(input.nowMs), "market_clock_invalid");
  const age = input.nowMs - input.observedAtMs;
  requireProof(age >= 0 && age <= input.maxAgeMs, "market_evidence_stale");
  const bids = input.side === "YES" ? input.book.yesBids : input.book.noBids;
  const asks = asksFromOpposite(input.side === "YES" ? input.book.noBids : input.book.yesBids);
  requireProof(asks.length > 0 && bids.length > 0, "market_depth_missing");
  requireProof(input.fee !== null, "fee_evidence_missing");
  const evidence: MarketEvidence = {
    observedAtMs: input.observedAtMs,
    bestAskDollars: asks[0]!.priceDollars,
    asks,
    bestBidDollars: bids[0]!.priceDollars,
    bids,
    fee: input.fee,
  };
  validateMarketEvidence(evidence);
  return evidence;
}

export function validateMarketEvidence(evidence: MarketEvidence): void {
  requireProof(Number.isSafeInteger(evidence.observedAtMs), "market_clock_invalid");
  requireProof(PRICE.test(evidence.bestAskDollars) && PRICE.test(evidence.bestBidDollars), "market_price_invalid");
  requireProof(evidence.asks.length > 0 && evidence.bids.length > 0, "market_depth_missing");
  for (const level of [...evidence.asks, ...evidence.bids]) {
    requireProof(PRICE.test(level.priceDollars), "market_price_invalid");
    requireProof(/^\d+(?:\.\d+)?$/.test(level.availableContracts) && Number(level.availableContracts) > 0, "market_depth_missing");
  }
  const fee = evidence.fee;
  requireProof(fee && fee.policyVersion.trim() && fee.sourceUrl.trim() && fee.formulaVersion.trim() &&
    fee.fingerprint.trim().length >= 16 && Number.isSafeInteger(fee.verifiedAtMs) &&
    Number.isSafeInteger(fee.contracts) && fee.contracts > 0 &&
    Number.isFinite(fee.limitPrice) && fee.limitPrice > 0 && fee.limitPrice < 1 &&
    Number.isSafeInteger(fee.reservedEntryFeeCents) && fee.reservedEntryFeeCents >= 0 &&
    Number.isSafeInteger(fee.reservedExitFeeCents) && fee.reservedExitFeeCents >= 0,
  "fee_evidence_missing");
  requireProof(!fee.cashRisk||validEntryCashRisk(fee),"fee_cash_bound_unproven");
}

/**
 * Spendable cash is only the requested subaccount balance.
 * Portfolio value and the primary account balance stay separate and are not spendable.
 */
export function readSubaccountSpendableCash(input: {
  subaccount: number;
  exchangeIndex: number;
  observedAtMs: number;
  nowMs: number;
  maxAgeMs: number;
  subaccountBalance: unknown;
  primaryBalance: unknown;
}): { ok: true; cashCents: number; cashMicros: string; portfolioValueCents: number | null; primaryCashCents: number | null }
  | { ok: false; reason: string } {
  if (input.subaccount !== 1 || input.exchangeIndex !== 2) {
    return { ok: false, reason: "account_target_pair_mismatch" };
  }
  if (!Number.isSafeInteger(input.observedAtMs) || !Number.isSafeInteger(input.nowMs) ||
      input.nowMs - input.observedAtMs < 0 || input.nowMs - input.observedAtMs > input.maxAgeMs) {
    return { ok: false, reason: "cash_evidence_stale" };
  }
  const bot = normalizeKalshiMoney(input.subaccountBalance);
  const primary = normalizeKalshiMoney(input.primaryBalance);
  const cashMicros = ownedBalanceMicros(input.subaccountBalance);
  if (cashMicros === null) {
    return { ok: false, reason: "cash_unproven" };
  }
  return {
    ok: true,
    cashCents: cents(BigInt(cashMicros)),
    cashMicros,
    portfolioValueCents: bot.portfolioValueCents,
    primaryCashCents: primary.cashCents,
  };
}

function levels(value: unknown, pricesAreDollars: boolean): V13DepthLevel[] {
  if (!Array.isArray(value)) throw new Error("market_book_malformed");
  const parsed = value.map((level) => {
    if (!Array.isArray(level) || level.length < 2) throw new Error("market_book_malformed");
    const price = decimalPrice(level[0], pricesAreDollars);
    const count = typeof level[1] === "number" ? String(level[1]) : typeof level[1] === "string" ? level[1] : "";
    if (!price || !/^\d+(?:\.\d+)?$/.test(count) || Number(count) < 0) throw new Error("market_book_malformed");
    return { priceDollars: price, availableContracts: count, price: Number(price) };
  });
  parsed.sort((a, b) => b.price - a.price);
  return parsed.map(({ priceDollars, availableContracts }) => ({ priceDollars, availableContracts }));
}

function asksFromOpposite(oppositeBids: V13DepthLevel[]): V13DepthLevel[] {
  return oppositeBids.map((level) => {
    const complementary = (10_000 - Math.round(Number(level.priceDollars) * 10_000)) / 10_000;
    return {
      priceDollars: complementary.toFixed(4),
      availableContracts: level.availableContracts,
    };
  }).sort((a, b) => Number(a.priceDollars) - Number(b.priceDollars));
}

function decimalPrice(value: unknown, pricesAreDollars: boolean): string | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || (match[2]?.length ?? 0) > 4) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(4, "0"));
  const tenThousandths = pricesAreDollars ? whole * 10_000 + fraction : whole * 100;
  if (!Number.isSafeInteger(tenThousandths) || tenThousandths <= 0 || tenThousandths >= 10_000) return null;
  return `${Math.floor(tenThousandths / 10_000)}.${String(tenThousandths % 10_000).padStart(4, "0")}`;
}
