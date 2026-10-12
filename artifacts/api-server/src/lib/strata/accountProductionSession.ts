import type { Pool } from "@workspace/db";
import { ProductionExecutor } from "../v13-production/executor";
import { ProductionLedger } from "../v13-production/ledger";
import type { Exchange, Identity, MarketEvidence, Request, Snapshot } from "../v13-production/types";
import { ProductionWorker } from "../v13-production/worker";
import { executionBoundaryAllowsDispatch } from "./accountScopedExecution";

export const PHASE5_EXECUTABLE = false;

export interface AccountDispatchState {
  leaseState: string;
  armRequested: boolean;
  accountKill: boolean;
  globalKill: boolean;
  fencingToken: number;
  presentedToken: number;
  workerActuallyScheduled: boolean;
  authenticatedUserId: string;
  ownerUserId: string;
  credentialFingerprint: string;
  presentedFingerprint: string;
  uncertainOrderCount: number;
  duplicateClientOrder: boolean;
}

/** Final order boundary. A fresh fence is required, and live dispatch stays closed. */
export function accountDispatchDecision(input: AccountDispatchState): { allowed: false; reason: string } {
  if (input.authenticatedUserId !== input.ownerUserId) {
    return { allowed: false, reason: "foreign_execution_account" };
  }
  if (input.presentedFingerprint !== input.credentialFingerprint) {
    return { allowed: false, reason: "credential_fingerprint_mismatch" };
  }
  const boundary = executionBoundaryAllowsDispatch(input);
  if (boundary.reason !== "operation_not_enabled") return boundary;
  if (input.uncertainOrderCount > 0) {
    return { allowed: false, reason: "production_uncertain_order_blocks_mutation" };
  }
  if (input.duplicateClientOrder) return { allowed: false, reason: "duplicate_client_order" };
  return { allowed: false, reason: "operation_not_enabled" };
}

export function scheduleAccountEntries(): {
  ok: false;
  reason: "operation_not_enabled";
  workerStarted: false;
  executionActive: false;
} {
  return { ok: false, reason: "operation_not_enabled", workerStarted: false, executionActive: false };
}

export class AccountScopedExchange implements Exchange {
  readonly mode = "SIMULATION" as const;
  submitAttempts = 0;
  constructor(readonly state: AccountDispatchState) {}
  async market(): Promise<MarketEvidence> {
    throw new Error("operation_not_enabled");
  }
  async snapshot(_identity: Identity, _historyFromMs: number): Promise<Snapshot> {
    throw new Error("operation_not_enabled");
  }
  async submit(_request: Request, _finalCheck: () => Promise<void>): Promise<{ orderId?: string }> {
    this.submitAttempts += 1;
    throw new Error(accountDispatchDecision(this.state).reason);
  }
  async cancel(_orderId: string, _finalCheck: () => Promise<void>): Promise<void> {
    this.submitAttempts += 1;
    throw new Error(accountDispatchDecision(this.state).reason);
  }
}

export function bindAccountProductionWorker(input: {
  pool: Pool;
  ownerUserId: string;
  executionAccountId: string;
  credentialFingerprint: string;
  state: AccountDispatchState;
}): {
  executor: ProductionExecutor;
  worker: ProductionWorker;
  exchange: AccountScopedExchange;
  workerStarted: false;
  executionActive: false;
} {
  const exchange = new AccountScopedExchange(input.state);
  const ledger = new ProductionLedger(input.pool, input.executionAccountId);
  const executor = new ProductionExecutor(ledger, exchange);
  const worker = new ProductionWorker(executor);
  return { executor, worker, exchange, workerStarted: false, executionActive: PHASE5_EXECUTABLE };
}
