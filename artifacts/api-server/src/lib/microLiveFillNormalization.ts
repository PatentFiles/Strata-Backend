import { dollarsToMicros } from "./microLiveMoney";

type Direction = {
  outcomeSide?: string | null;
  bookSide?: string | null;
};
type Order = Direction & {
  id: string; ticker: string; side: string; action: string;
};
type Fill = Direction & {
  orderId: string | null; ticker: string; side: string; action: string;
  priceDollars: string | null;
  yesPriceDollars?: string | null;
  noPriceDollars?: string | null;
};

export function compatibleOptionalPrice(
  a: string | null | undefined, b: string | null | undefined,
): boolean {
  const left = a == null ? null : dollarsToMicros(a);
  const right = b == null ? null : dollarsToMicros(b);
  return (a == null || left !== null) && (b == null || right !== null) &&
    (left === null || right === null || left === right);
}

export function compatibleOptionalDirection(a: Direction, b: Direction): boolean {
  const outcome = a.outcomeSide ?? b.outcomeSide;
  const book = a.bookSide ?? b.bookSide;
  return (a.outcomeSide == null || a.outcomeSide === "yes" || a.outcomeSide === "no") &&
    (b.outcomeSide == null || b.outcomeSide === "yes" || b.outcomeSide === "no") &&
    (a.bookSide == null || a.bookSide === "bid" || a.bookSide === "ask") &&
    (b.bookSide == null || b.bookSide === "bid" || b.bookSide === "ask") &&
    (a.outcomeSide == null || b.outcomeSide == null || a.outcomeSide === b.outcomeSide) &&
    (a.bookSide == null || b.bookSide == null || a.bookSide === b.bookSide) &&
    (outcome == null || book == null ||
      book === (outcome === "yes" ? "bid" : "ask"));
}

export function mergeDirectionAndPrices<T extends Direction & {
  yesPriceDollars?: string | null; noPriceDollars?: string | null;
}>(a: T, b: T): T {
  return {
    ...a,
    outcomeSide: a.outcomeSide ?? b.outcomeSide,
    bookSide: a.bookSide ?? b.bookSide,
    yesPriceDollars: a.yesPriceDollars ?? b.yesPriceDollars,
    noPriceDollars: a.noPriceDollars ?? b.noPriceDollars,
  };
}

function directionMatches(value: Direction, expected: "yes" | "no", required: boolean): boolean {
  if (value.outcomeSide == null && value.bookSide == null) return !required;
  return value.outcomeSide === expected &&
    value.bookSide === (expected === "yes" ? "bid" : "ask");
}

/**
 * Return the fill price for the actual order leg, not the legacy fill side.
 * Only a linked NO-sell / YES-sell pair with matching canonical direction
 * and both complementary prices may use the alternate representation.
 */
export function microLiveOrderLegFillPrice(fill: Fill, order: Order): string | null {
  if (!order.id || fill.orderId !== order.id || fill.ticker !== order.ticker ||
      fill.action !== order.action || !["yes", "no"].includes(order.side) ||
      !["buy", "sell"].includes(order.action) ||
      !["yes", "no"].includes(fill.side)) return null;
  const yes = fill.yesPriceDollars == null ? null : dollarsToMicros(fill.yesPriceDollars);
  const no = fill.noPriceDollars == null ? null : dollarsToMicros(fill.noPriceDollars);
  const raw = dollarsToMicros(fill.priceDollars);
  if (raw === null || raw <= 0 || raw > 1_000_000 ||
      (fill.yesPriceDollars != null && (yes === null || yes <= 0 || yes >= 1_000_000)) ||
      (fill.noPriceDollars != null && (no === null || no <= 0 || no >= 1_000_000)) ||
      (yes !== null && no !== null && yes + no !== 1_000_000) ||
      (fill.side === "yes" && yes !== null && raw !== yes) ||
      (fill.side === "no" && no !== null && raw !== no) ||
      (fill.side === "yes" && no !== null && raw + no !== 1_000_000) ||
      (fill.side === "no" && yes !== null && raw + yes !== 1_000_000)) return null;
  const expected = order.side === "yes"
    ? (order.action === "buy" ? "yes" : "no")
    : (order.action === "buy" ? "no" : "yes");
  if (fill.side === order.side) {
    if (!directionMatches(fill, expected, false) ||
        !directionMatches(order, expected, false)) return null;
    return fill.priceDollars;
  }
  if (order.side !== "no" || order.action !== "sell" || fill.side !== "yes" ||
      !directionMatches(order, "yes", true) ||
      !directionMatches(fill, "yes", true)) return null;
  if (yes === null || no === null || yes <= 0 || no <= 0 ||
      yes + no !== 1_000_000 || raw !== yes) return null;
  return fill.noPriceDollars ?? null;
}