/** Kalshi fee_cost and fixed-point fill prices are dollar amounts, not cents. */
export function dollarsToMicros(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(micros);
}

export function fillTradeMicros(contracts: number, priceDollars: string | null): number | null {
  const price = dollarsToMicros(priceDollars);
  if (!Number.isSafeInteger(contracts) || contracts <= 0 || price === null ||
      price <= 0 || price > 1_000_000) return null;
  const total = BigInt(contracts) * BigInt(price);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

/** Round once at the presentation boundary; stored fills remain exact. */
export function microsToRoundedCents(micros: number): number {
  return Math.round(micros / 10_000);
}