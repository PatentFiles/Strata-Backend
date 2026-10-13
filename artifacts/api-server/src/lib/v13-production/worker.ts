import { ProductionExecutor } from "./executor";
import { consumeOwnedPosition } from "./consumer";

/** Explicit lifecycle only. API startup neither constructs nor starts this worker. */
export class ProductionWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private recoveryOnly = false;
  constructor(readonly executor: ProductionExecutor, readonly intervalMs = 2_500,
    readonly report: (error: unknown) => void = () => {},
    readonly entriesOpen: () => boolean = () => true) {}
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.executor.reconcile(); // restart first; never replay dispatched POSTs
      if (this.recoveryOnly) return;
      await consumeOwnedPosition(this.executor);
      if (!this.entriesOpen()) return;
      const ids = (await this.executor.ledger.pool.query(`SELECT id FROM forward_test_evaluations
        WHERE evaluation_source='paper' AND qualifying_trigger=true AND fresh_cross=true
        AND signal IN ('SCOUT','CONFIRM') AND evaluated_at >= $1 ORDER BY evaluated_at,id LIMIT 100`,
      [new Date(this.executor.now() - 15_000)])).rows;
      for (const { id } of ids) {
        if (!this.entriesOpen()) break;
        try { const intent = await this.executor.prepareEntry(id); await this.executor.dispatch(intent); }
        catch (error) { this.report(error); }
      }
    } finally { this.running = false; }
  }
  async start(): Promise<void> {
    if (this.timer) return;
    await this.executor.reconcile();
    await this.executor.ledger.transaction((tx, a) => this.executor.gate(tx, a, false, null, true));
    this.recoveryOnly = false;
    this.schedule();
  }
  async startRecovery(): Promise<void> {
    if (this.timer) return;
    await this.executor.ledger.readAccount();
    this.recoveryOnly = true;
    try { await this.executor.reconcile(); } catch (error) { this.report(error); }
    this.schedule();
  }
  private schedule(): void {
    const loop = async () => {
      try { await this.tick(); } catch (error) {
        this.report(error);
        if (error instanceof Error && (error.message === "personal_exchange_history_unreconciled" ||
          error.message === "stale_worker_fence" || error.message === "account_kill_switch")) this.stop();
      }
      if (this.timer) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** True only after start() has scheduled the loop. Database flags are not a substitute. */
  isScheduled(): boolean { return this.timer !== null; }
}
