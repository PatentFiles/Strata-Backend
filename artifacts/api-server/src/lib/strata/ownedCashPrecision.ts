import { dollarsToMicros } from "../microLiveMoney";
import { cents } from "../v13-production/types";

const MAX_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const own = (row: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(row, key);

/** Execution cash is authoritative in exact micros, never reconstructed from cents.
 * A present fixed-point field wins, including when malformed. Legacy cents are
 * accepted only when that field is absent. This does not change transfer parsers.
 */
export function ownedBalanceMicros(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const row = payload as Record<string, unknown>;
  if (own(row, "balance_dollars")) {
    const field = Object.getOwnPropertyDescriptor(row, "balance_dollars");
    if (!field || !("value" in field) || typeof field.value !== "string") return null;
    const micros = dollarsToMicros(field.value);
    return micros === null ? null : String(micros);
  }
  if (!own(row, "balance")) return null;
  const field = Object.getOwnPropertyDescriptor(row, "balance");
  if (!field || !("value" in field)) return null;
  const value = field.value;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (!/^\d+$/.test(String(value))) return null;
  const micros = BigInt(value) * 10_000n;
  return micros <= MAX_MICROS ? String(micros) : null;
}

function nonnegativeMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const micros = BigInt(value);
  return micros <= MAX_MICROS ? micros : null;
}

/** Read-model projections only: never hide a positive hold or overstate capital.
 * Available cents are calculated from the EXACT difference before flooring.
 * These numbers must never be converted back into authoritative ledger cash.
 */
export function ownedCashProjection(cashValue: unknown, reservedValue: unknown): {
  cashCents: number | null; reservedCents: number | null; capitalRemainingCents: number | null;
} {
  const cash = nonnegativeMicros(cashValue);
  const reserved = nonnegativeMicros(reservedValue);
  return {
    cashCents: cash === null ? null : cents(cash),
    reservedCents: reserved === null ? null : Number((reserved + 9_999n) / 10_000n),
    capitalRemainingCents: cash === null || reserved === null || reserved > cash ? null : cents(cash - reserved),
  };
}
