import { normalizeKalshiMoney, type KalshiMoney } from "./kalshiUserRead";

export type PrimaryDisplayMoney = KalshiMoney & {
  cashDollarsExact: string | null;
  cashMicrosExact: string | null;
  cashDisplayRoundedDown: boolean;
  cashReadReason: "exact_cents" | "display_floor_to_cent" | "missing_cash" | "invalid_cash" | "cash_overflow";
};

/** OWNER WALLET DISPLAY ONLY. Never use this cent projection for funding,
 * reconciliation, transfer sizing or order authority. Shared execution money
 * parsing remains strict; exact fixed-point evidence is preserved separately. */
export function normalizePrimaryDisplayMoney(payload: unknown): PrimaryDisplayMoney {
  const row = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>) } : null;
  const strict = normalizeKalshiMoney(row);
  const result: PrimaryDisplayMoney = { ...strict, cashCents: null, cashDollarsExact: null,
    cashMicrosExact: null, cashDisplayRoundedDown: false, cashReadReason: "missing_cash" };
  if (!row) return result;
  let exact: string;
  if (Object.hasOwn(row, "balance_dollars") && row.balance_dollars !== undefined && row.balance_dollars !== null) {
    // Fixed-point dollar strings. Display supports up to six decimal places
    // as an exact microdollar bound; this does not assert provider precision.
    // Reject malformed present dollars instead of falling back to another field.
    if (typeof row.balance_dollars !== "string" || row.balance_dollars.length > 64 ||
      !/^\d+(?:\.\d{1,6})?$/.test(row.balance_dollars)) return { ...result, cashReadReason: "invalid_cash" };
    exact = row.balance_dollars;
  } else {
    if (!Object.hasOwn(row, "balance") || row.balance === undefined || row.balance === null) return result;
    if (strict.cashCents === null || strict.cashCents < 0 || !Number.isSafeInteger(strict.cashCents))
      return { ...result, cashReadReason: "invalid_cash" };
    const cents = BigInt(strict.cashCents);
    exact = `${cents / 100n}.${String(cents % 100n).padStart(2,"0")}`;
  }
  const [whole, fraction = ""] = exact.split(".");
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6,"0"));
  const cents = micros / 10_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { ...result, cashReadReason: "cash_overflow" };
  const rounded = micros % 10_000n !== 0n;
  return { ...result, cashCents: Number(cents), cashDollarsExact: exact, cashMicrosExact: String(micros),
    cashDisplayRoundedDown: rounded, cashReadReason: rounded ? "display_floor_to_cent" : "exact_cents" };
}

/** Both wallet buckets share display-only projections; no execution caller uses this alias. */
export const normalizeWalletDisplayMoney = normalizePrimaryDisplayMoney;
