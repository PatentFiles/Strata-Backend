/** Research storage only. Never feeds a strategy decision or execution gate.
 * Memory is bounded; eviction/restart emits an extra receipt, never suppresses it.
 * This records observed classification changes, not a complete tick census.
 */
export type ShadowCaptureFrame = {
  model: string; market: string; atMs: number;
  baselineSignal: string; baselineDirection: string; baselineQualifying: boolean;
  positionWasOpen: boolean; freshCross: boolean;
  signal: string; direction: string; qualifying: boolean; wouldEnter: boolean;
};
type State = { market: string; atMs: number; fingerprint: string; skipped: number };
export class ShadowEventCapture {
  private readonly states = new Map<string, State>();
  constructor(private readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error('invalid capture capacity');
  }
  plan(frame: ShadowCaptureFrame): { retain: boolean; reason: string; commit: () => void } {
    const old = this.states.get(frame.model);
    const fingerprint = JSON.stringify([frame.baselineSignal, frame.baselineDirection,
      frame.baselineQualifying, frame.positionWasOpen, frame.signal, frame.direction,
      frame.qualifying, frame.wouldEnter]);
    const quiet = (s: string) => s === 'PASS' || s === 'WATCH';
    const retain = !old || old.market !== frame.market ||
      !Number.isFinite(frame.atMs) || frame.atMs <= old.atMs ||
      frame.freshCross || frame.baselineQualifying || frame.qualifying || frame.wouldEnter ||
      !quiet(frame.baselineSignal) || !quiet(frame.signal) || old.fingerprint !== fingerprint;
    // Count observed quiet skips since this model's last receipt, across rollover.
    const skipped = old?.skipped ?? 0;
    const commit = () => {
      this.states.delete(frame.model);
      this.states.set(frame.model, { market: frame.market, atMs: frame.atMs,
        fingerprint, skipped: retain ? 0 : skipped + 1 });
      while (this.states.size > this.capacity) this.states.delete(this.states.keys().next().value!);
    };
    return { retain, reason: `capture=EVENT_V1|observed_quiet_skipped=${skipped}|coverage=OPTIONAL_LANE_NOT_TICK_COMPLETE`, commit };
  }
}
