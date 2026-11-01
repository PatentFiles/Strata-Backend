import type { Intent } from './ledger';

/** Snapshot only columns written by the reconciliation persistence loop.
 * Capture while its existing FOR UPDATE locks are held, before mutation.
 * This is not a cache: every tick still reads and verifies complete history.
 */
export type ReconciledIntentState = Readonly<Pick<Intent,
  'state' | 'exchange_order_id' | 'filled_hundredths' | 'reserved_micros' | 'terminal'>>;

export function reconciledIntentState(intent: Intent): ReconciledIntentState {
  return Object.freeze({ state: intent.state, exchange_order_id: intent.exchange_order_id,
    filled_hundredths: intent.filled_hundredths, reserved_micros: intent.reserved_micros,
    terminal: intent.terminal });
}

export function reconciliationIntentChanged(before: ReconciledIntentState, after: Intent): boolean {
  return before.state !== after.state || before.exchange_order_id !== after.exchange_order_id ||
    before.filled_hundredths !== after.filled_hundredths || before.reserved_micros !== after.reserved_micros ||
    before.terminal !== after.terminal;
}
