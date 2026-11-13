/** Stable advisory-lock key for the one production worker process. */
export const PRODUCTION_WORKER_LOCK_KEY = 813520533;

export interface LockClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<{ locked?: boolean }> }>;
}

/**
 * Session-mode Postgres only. Transaction poolers (port 6543) drop advisory locks
 * between statements, so two hosts could both believe they own the worker.
 */
export function assertDirectSessionDatabase(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("production_database_url_invalid");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("production_database_url_invalid");
  }
  if (url.port === "6543" || url.searchParams.get("pgbouncer") === "true") {
    throw new Error("production_database_pooler_refused");
  }
}

export async function tryAcquireProductionWorkerLock(client: LockClient): Promise<boolean> {
  const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [PRODUCTION_WORKER_LOCK_KEY]);
  return result.rows[0]?.locked === true;
}

export async function releaseProductionWorkerLock(client: LockClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1) AS locked", [PRODUCTION_WORKER_LOCK_KEY]);
}
