/** The cap is denominated in micro-dollars so sub-cent fees cannot disappear. */
export const LIVE_TEST_CAP_MICROS = 1_000_000;
export const BOUNDED_RUN_TEST_CAP_MICROS = 5_000_000;
export const SESSION_CAP_MICROS = 25_000_000;

function valid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fully paid binary contracts can lose at most their buy debit plus buy fee
 * when held to settlement. This is NOT an exit proceeds or P&L calculation.
 */
export function withinLiveTestCap(
  committedCashCents: number,
  requestedCashCents: number,
  committedEntryFeesMicros: number,
  requestedEntryFeesMicros: number,
  ceilingMicros = LIVE_TEST_CAP_MICROS,
): boolean {
  const amounts = [
    committedCashCents, requestedCashCents,
    committedEntryFeesMicros, requestedEntryFeesMicros,
  ];
  if (amounts.some((amount) => !valid(amount))) return false;
  const total = (BigInt(committedCashCents) + BigInt(requestedCashCents)) * 10_000n +
    BigInt(committedEntryFeesMicros) + BigInt(requestedEntryFeesMicros);
  return valid(ceilingMicros) && total <= BigInt(ceilingMicros);
}

/** Maximum cash and loss: fee-inclusive entry debit plus additional negative net exit cash. */
export function withinAllInLiveTestCap(
  nominalStakeCents: number,
  additionalDebitAndCommittedLossMicros: number,
  additionalExitCashDebitMicros: number,
  ceilingMicros = LIVE_TEST_CAP_MICROS,
): boolean {
  if (![nominalStakeCents, additionalDebitAndCommittedLossMicros,
    additionalExitCashDebitMicros].every(valid) ||
      !valid(ceilingMicros)) return false;
  return BigInt(nominalStakeCents) * 10_000n +
    BigInt(additionalDebitAndCommittedLossMicros) +
    BigInt(additionalExitCashDebitMicros) <= BigInt(ceilingMicros);
}

export function addFeeBounds(...bounds: number[]): number | null {
  if (bounds.some((amount) => !valid(amount))) return null;
  const total = bounds.reduce((sum, amount) => sum + BigInt(amount), 0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}