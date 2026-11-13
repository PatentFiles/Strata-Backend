import { randomUUID } from "node:crypto";
import { db, kalshiKeyProvisioningAttemptTable as attempts } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export const KEY_NAME = "MICRO_LIVE_SUBACCOUNT_1";
export const SUBACCOUNT = 1;
export const SCOPES = ["read", "write::trade"] as const;
export const RECOVERY_REASON =
  "Original in-memory handoff lost after API restart; saved restricted credential independently verified with Kalshi GET-only reads.";
export type AttemptState =
  "prepared" | "attempted" | "response_received" | "handoff_confirmed" |
  "handoff_recovered_verified" | "uncertain";

export interface AttemptStore {
  state(): Promise<AttemptState | null>;
  prepare(): Promise<string | null>;
  markAttempted(id: string): Promise<boolean>;
  markOutcome(id: string, state: "response_received" | "handoff_confirmed" | "uncertain"): Promise<void>;
  recoveryEligible(): Promise<boolean>;
  markRecovered(): Promise<boolean>;
}

export const databaseAttemptStore: AttemptStore = {
  async state() {
    const [row] = await db.select({ state: attempts.state })
      .from(attempts).where(eq(attempts.keyName, KEY_NAME)).limit(1);
    return (row?.state as AttemptState | undefined) ?? null;
  },
  async prepare() {
    const id = randomUUID();
    const [inserted] = await db.insert(attempts).values({
      attemptId: id, keyName: KEY_NAME, subaccount: SUBACCOUNT,
      scopes: [...SCOPES], createdAt: new Date(), state: "prepared",
    }).onConflictDoNothing({ target: attempts.keyName })
      .returning({ attemptId: attempts.attemptId });
    // A prior prepared/attempted record cannot be reset or superseded.
    return inserted?.attemptId ?? null;
  },
  async markAttempted(id) {
    // The database commits this conditional transition before any POST is sent.
    const [updated] = await db.update(attempts).set({ state: "attempted" })
      .where(and(eq(attempts.attemptId, id), eq(attempts.state, "prepared")))
      .returning({ attemptId: attempts.attemptId });
    return !!updated;
  },
  async markOutcome(id, state) {
    const allowedPrevious = state === "handoff_confirmed" ? "response_received" : "attempted";
    await db.update(attempts).set({ state })
      .where(and(eq(attempts.attemptId, id), eq(attempts.state, allowedPrevious)));
  },
  async recoveryEligible() {
    const rows = await db.select().from(attempts).limit(2);
    return rows.length === 1 && rows[0].keyName === KEY_NAME &&
      rows[0].state === "response_received" && rows[0].subaccount === SUBACCOUNT &&
      rows[0].scopes.length === 2 && rows[0].scopes[0] === SCOPES[0] &&
      rows[0].scopes[1] === SCOPES[1];
  },
  async markRecovered() {
    return db.transaction(async (tx) => {
      // Prevent inserts while the count and conditional state update are checked.
      await tx.execute(sql`LOCK TABLE kalshi_key_provisioning_attempts IN SHARE ROW EXCLUSIVE MODE`);
      const rows = await tx.select().from(attempts).limit(2);
      if (rows.length !== 1 || rows[0].keyName !== KEY_NAME ||
          rows[0].state !== "response_received" || rows[0].subaccount !== SUBACCOUNT ||
          rows[0].scopes.length !== 2 || rows[0].scopes[0] !== SCOPES[0] ||
          rows[0].scopes[1] !== SCOPES[1]) return false;
      const [updated] = await tx.update(attempts).set({
        state: "handoff_recovered_verified",
        recoveryConfirmedAt: new Date(),
        recoveryReason: RECOVERY_REASON,
      }).where(and(eq(attempts.attemptId, rows[0].attemptId),
        eq(attempts.state, "response_received")))
        .returning({ attemptId: attempts.attemptId });
      return !!updated;
    });
  },
};