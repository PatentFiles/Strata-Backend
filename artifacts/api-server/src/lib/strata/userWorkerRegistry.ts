export interface AccountWorkerHandle {
  accountId: string;
  ownerUserId: string;
  running: boolean;
}

/** One in-process worker per execution account. This registry does not start a worker by itself. */
export class UserWorkerRegistry {
  readonly #workers = new Map<string, AccountWorkerHandle>();

  get(accountId: string): AccountWorkerHandle | null {
    return this.#workers.get(accountId) ?? null;
  }

  start(accountId: string, ownerUserId: string): { ok: true } | { ok: false; reason: string } {
    const existing = this.#workers.get(accountId);
    if (existing?.running) return { ok: false, reason: "worker_already_running" };
    if (existing && existing.ownerUserId !== ownerUserId) return { ok: false, reason: "foreign_execution_account" };
    this.#workers.set(accountId, { accountId, ownerUserId, running: true });
    return { ok: true };
  }

  stop(accountId: string, ownerUserId: string): { ok: true } | { ok: false; reason: string } {
    const existing = this.#workers.get(accountId);
    if (!existing || existing.ownerUserId !== ownerUserId) return { ok: false, reason: "foreign_execution_account" };
    this.#workers.set(accountId, { ...existing, running: false });
    return { ok: true };
  }

  runningCount(): number {
    let count = 0;
    for (const worker of this.#workers.values()) if (worker.running) count += 1;
    return count;
  }
}
