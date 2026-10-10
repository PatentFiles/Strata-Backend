import type { ProductionWorker } from "./worker";

/** Proven process state. Never inferred from account configuration alone. */
export type RuntimeStatus = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "BLOCKED" | "ERROR";

export interface WorkerHandle {
  start(): Promise<void>;
  stop(): void;
  isScheduled(): boolean;
}

export interface StopBlockers {
  openPositionCount: number;
  unresolvedIntentCount: number;
  unknownIntentCount: number;
  dispatchedIntentCount: number;
}

export interface ControlView {
  runtimeStatus: RuntimeStatus;
  workerRunning: boolean;
  blockedReason: string | null;
  lastProductionError: string | null;
  refused: boolean;
}

export interface SupervisorDeps {
  /** Called at most once for the process-wide worker. Must not run at import time. */
  createWorker: () => Promise<WorkerHandle>;
  readStopBlockers: () => Promise<StopBlockers>;
}

const BLOCKED_REASON = /production_|simulation_|disabled|uncommissioned|kill_switch|missing|stale|frozen|authority/;

function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : "production_start_failed";
  const line = raw.split("\n")[0] ?? "production_start_failed";
  return line.slice(0, 300);
}

function classify(error: unknown): { status: RuntimeStatus; reason: string } {
  const reason = reasonOf(error);
  return { status: BLOCKED_REASON.test(reason) ? "BLOCKED" : "ERROR", reason };
}

/**
 * Owns at most one normal ProductionWorker. It never clears kill switches,
 * execution flags, commissioning, policy, or credentials. start() only calls
 * the existing worker start, which keeps every production gate.
 */
export class ProductionSupervisor {
  private worker: WorkerHandle | null = null;
  private inflight: Promise<ControlView> | null = null;
  private runtime: RuntimeStatus = "STOPPED";
  private blockedReason: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: SupervisorDeps) {}

  view(): ControlView {
    const workerRunning = this.worker?.isScheduled() ?? false;
    let runtimeStatus = this.runtime;
    if (workerRunning) {
      runtimeStatus = this.runtime === "STOPPING" ? "STOPPING" : "RUNNING";
    } else if (runtimeStatus === "RUNNING" || runtimeStatus === "STOPPING") {
      runtimeStatus = "STOPPED";
    }
    return {
      runtimeStatus,
      workerRunning,
      blockedReason: this.blockedReason,
      lastProductionError: this.lastError,
      refused: false,
    };
  }

  async start(): Promise<ControlView> {
    if (this.worker?.isScheduled()) return this.view();
    if (!this.inflight) {
      this.runtime = "STARTING";
      this.blockedReason = null;
      this.inflight = this.executeStart().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async executeStart(): Promise<ControlView> {
    try {
      if (!this.worker) this.worker = await this.deps.createWorker();
      if (this.worker.isScheduled()) {
        this.runtime = "RUNNING";
        this.blockedReason = null;
        return this.view();
      }
      await this.worker.start();
      if (!this.worker.isScheduled()) {
        this.runtime = "ERROR";
        this.blockedReason = "production_worker_did_not_start";
        this.lastError = this.blockedReason;
        return this.view();
      }
      this.runtime = "RUNNING";
      this.blockedReason = null;
      this.lastError = null;
      return this.view();
    } catch (error) {
      const classified = classify(error);
      this.runtime = classified.status;
      this.blockedReason = classified.reason;
      this.lastError = classified.reason;
      return this.view();
    }
  }

  /**
   * Normal stop. Refuses while an owned position or unresolved production
   * mutation exists, and does not call emergency stop or flatten exposure.
   */
  async stop(): Promise<ControlView> {
    if (!this.worker?.isScheduled()) {
      if (this.runtime !== "BLOCKED" && this.runtime !== "ERROR" && this.runtime !== "STARTING") {
        this.runtime = "STOPPED";
      }
      return this.view();
    }
    let blockers: StopBlockers;
    try {
      blockers = await this.deps.readStopBlockers();
    } catch (error) {
      this.blockedReason = classify(error).reason;
      this.lastError = this.blockedReason;
      return { ...this.view(), refused: true };
    }
    if (
      blockers.openPositionCount > 0 ||
      blockers.unresolvedIntentCount > 0 ||
      blockers.unknownIntentCount > 0 ||
      blockers.dispatchedIntentCount > 0
    ) {
      const parts: string[] = [];
      if (blockers.openPositionCount > 0) parts.push(`open_position:${blockers.openPositionCount}`);
      if (blockers.dispatchedIntentCount > 0) parts.push(`dispatched_intent:${blockers.dispatchedIntentCount}`);
      if (blockers.unknownIntentCount > 0) parts.push(`unknown_intent:${blockers.unknownIntentCount}`);
      if (blockers.unresolvedIntentCount > 0) parts.push(`unresolved_intent:${blockers.unresolvedIntentCount}`);
      this.blockedReason = parts.join(",");
      return { ...this.view(), refused: true };
    }
    this.runtime = "STOPPING";
    this.worker.stop();
    if (this.worker.isScheduled()) {
      this.runtime = "ERROR";
      this.blockedReason = "production_worker_stop_failed";
      this.lastError = this.blockedReason;
      return { ...this.view(), refused: true };
    }
    this.runtime = "STOPPED";
    this.blockedReason = null;
    return this.view();
  }
}

export type { ProductionWorker };
