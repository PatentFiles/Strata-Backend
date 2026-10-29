import type { Pool } from "pg";

/** pg removes a failed idle client before emitting this event. Observe it without
 * crashing the API, retrying queries, or logging Error/client objects (secrets).
 * Checked-out connection and query failures still reject their original callers.
 * https://node-postgres.com/apis/pool#error
 */
export function observeIdlePoolErrors(
  pool: Pick<Pool, "on" | "totalCount" | "idleCount" | "waitingCount">,
  report: (event: Record<string, string | number>) => void = event => {
    console.error(JSON.stringify(event));
  },
): void {
  pool.on("error", (error: Error & { code?: string }) => {
    const knownCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "08006"]);
    report({
      level: "error",
      event: "database_idle_client_error",
      code: knownCodes.has(error.code ?? "") ? error.code! : "UNKNOWN",
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    });
  });
}
