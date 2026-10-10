import { desc } from "drizzle-orm";
import { db, forwardTestEvaluationTable } from "@workspace/db";
import { readKalshiAccount, readKalshiOrderbook } from "./kalshiAccountClient";

let verified: Promise<void> | null = null;

/**
 * Read-only production check. No configuration or paper-worker row is changed.
 * Failed checks are retried on the next attempt rather than being cached.
 */
export function verifyProductionShadowReads(): Promise<void> {
  if (process.env.NODE_ENV !== "production" ||
      process.env.KALSHI_API_ENVIRONMENT !== "production") {
    return Promise.reject(new Error("Production Kalshi environment is not configured"));
  }
  if (!verified) {
    verified = (async () => {
      const [evaluation] = await db.select({
        marketTicker: forwardTestEvaluationTable.marketTicker,
        evaluatedAt: forwardTestEvaluationTable.evaluatedAt,
      }).from(forwardTestEvaluationTable)
        .orderBy(desc(forwardTestEvaluationTable.evaluatedAt)).limit(1);
      if (!evaluation?.marketTicker ||
          Date.now() - evaluation.evaluatedAt.getTime() > 120_000) {
        throw new Error("Current paper market is unavailable");
      }
      // All five requests pass through the client's GET-only path allowlist.
      await Promise.all([
        readKalshiAccount(),
        readKalshiOrderbook(evaluation.marketTicker),
      ]);
    })().catch((error: unknown) => {
      verified = null;
      throw error;
    });
  }
  return verified;
}