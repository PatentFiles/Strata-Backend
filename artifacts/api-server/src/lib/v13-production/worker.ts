import { ProductionExecutor } from "./executor";
import { consumeOwnedPosition, type ProtectiveExitDispatch } from "./consumer";

/** Explicit lifecycle only. API startup neither constructs nor starts this worker. */
/** Target start-to-start cadence, never overlapping prior signed exchange IO.
 * A long Kalshi request cannot create a busy retry loop.
 */
export function sequentialPollDelayMs(intervalMs:number,elapsedMs:number):number {
 return Math.max(250,Math.ceil(intervalMs-Math.max(0,elapsedMs)));
}
export class ProductionWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private recoveryOnly = false;
  private entryHoldReported = false;
  constructor(readonly executor: ProductionExecutor, readonly intervalMs = 2_500,
    readonly report: (error: unknown) => void = () => {},
    readonly entriesOpen: () => boolean = () => true,
    /** Trusted, never-submitting UNKNOWN protective-exit recovery pass. */
    readonly recoverProtectiveExits: () => Promise<void> = async () => {},
    /** Trusted owner-scoped IOC exit, never obtained from user requests. */
    readonly dispatchProtectiveExit?: ProtectiveExitDispatch) {}
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Resolve or retain UNKNOWN protective exits BEFORE ordinary reconciliation
      // and before any chance of a new entry. Failures stop this tick; never POST.
      await this.recoverProtectiveExits();
      await this.executor.reconcile(); // restart first; never replay dispatched POSTs
      if (this.recoveryOnly) return;
      await consumeOwnedPosition(this.executor, this.dispatchProtectiveExit);
      if (!this.entriesOpen()) {
        // A healthy reconciliation heartbeat does not prove entries are open.
        // Report this once per suspended interval without attempting an order.
        if (!this.entryHoldReported) {
          this.entryHoldReported = true;
          this.report(new Error("production_entries_not_authorized"));
        }
        return;
      }
      this.entryHoldReported = false;
      const observedAt = new Date(this.executor.now());
      // The owner account's approved quote-age window, not an arbitrary
      // 15-second replay window, determines which paper signals remain
      // executable. Newest first: do not spend a slow Kalshi/fee fetch on an
      // older crossing while a newer qualifying entry expires.
      const query = this.executor.accountOwnerUserId
        ? `SELECT e.id FROM forward_test_evaluations e
          JOIN v13_production_account a ON a.id=$1
          JOIN v13_live_money_policy p ON p.id=a.policy_id
            AND p.execution_account_id=a.id AND p.state='APPROVED'
          WHERE e.evaluation_source='paper' AND e.qualifying_trigger=true
            AND e.fresh_cross=true AND e.signal IN ('SCOUT','CONFIRM')
            AND e.evaluated_at BETWEEN $2::timestamptz -
              (p.max_quote_age_ms * interval '1 millisecond') AND $2::timestamptz
          ORDER BY e.evaluated_at DESC,e.id DESC LIMIT 100`
        : `SELECT id FROM forward_test_evaluations
          WHERE evaluation_source='paper' AND qualifying_trigger=true
            AND fresh_cross=true AND signal IN ('SCOUT','CONFIRM')
            AND evaluated_at >= $1
          ORDER BY evaluated_at DESC,id DESC LIMIT 100`;
      const args = this.executor.accountOwnerUserId
        ? [this.executor.ledger.accountId, observedAt]
        : [new Date(observedAt.getTime() - 15_000)];
      const ids = (await this.executor.ledger.pool.query(query, args)).rows;
      for (const { id } of ids) {
        if (!this.entriesOpen()) break;
        try { const intent = await this.executor.prepareEntry(id); await this.executor.dispatch(intent); }
        catch (error) { this.report({error, evaluationId: id}); }
      }
    } finally { this.running = false; }
  }
  async start(): Promise<void> {
    if (this.timer) return;
    await this.recoverProtectiveExits();
    await this.executor.reconcile();
    await this.executor.ledger.transaction((tx, a) => this.executor.gate(tx, a, false, null, true));
    this.recoveryOnly = false;
    this.schedule();
  }
  async startRecovery(): Promise<void> {
    if (this.timer) return;
    await this.executor.ledger.readAccount();
    this.recoveryOnly = true;
    try { await this.recoverProtectiveExits(); await this.executor.reconcile(); }
    catch (error) { this.report(error); }
    this.schedule();
  }
  private schedule(): void {
    const loop = async () => {
      const startedAt=Date.now();
      try { await this.tick(); } catch (error) {
        this.report(error);
        if (error instanceof Error && (error.message === "personal_exchange_history_unreconciled" ||
          error.message === "stale_worker_fence" || error.message === "account_kill_switch")) this.stop();
      }
      if (this.timer) this.timer=setTimeout(loop,
        sequentialPollDelayMs(this.intervalMs,Date.now()-startedAt));
    };
    this.timer = setTimeout(loop, 0);
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** True only after start() has scheduled the loop. Database flags are not a substitute. */
  isScheduled(): boolean { return this.timer !== null; }
}
