import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db, liveExecutionConfigTable, microLiveConfigTable,
  microLivePairBoundaryTable, microLivePairKeyProvisioningAttemptTable as attempts,
  microLiveSubaccountCreationAttemptTable as creations,
} from "@workspace/db";

export const PAIR_KEY_NAME = "MICRO_LIVE_INDEX2_SUBACCOUNT_1";
export const PAIR_SUBACCOUNT = 1;
export const PAIR_EXCHANGE_INDEX = 2;
export const PAIR_SCOPES = ["read", "write::trade"] as const;

export type PairKeyAttemptState =
  | "prepared"
  | "attempted"
  | "response_received"
  | "metadata_verified"
  | "handoff_confirmed"
  | "uncertain";

export type PairKeyAttempt = Readonly<{
  attemptId: string;
  state: PairKeyAttemptState;
  keyId: string | null;
  creationAttemptId: string;
  cleanBoundaryEvidenceDigest: string;
  metadataVerifiedAt: Date | null;
  confirmedAt: Date | null;
}>;

export interface PairKeyAttemptStore {
  get(): Promise<PairKeyAttempt | null>;
  prepare(): Promise<string | null>;
  markAttempted(id: string): Promise<boolean>;
  markResponse(id: string, keyId: string): Promise<boolean>;
  markMetadataVerified(id: string): Promise<boolean>;
  markConfirmed(id: string): Promise<boolean>;
  markUncertain(id: string): Promise<boolean>;
  bindingEligible(
    subaccount: number,
    keyId: string,
    boundary: { creationAttemptId: string; cleanBoundaryEvidenceDigest: string },
  ): Promise<boolean>;
}

const generationAuthorized = () =>
  process.env.NODE_ENV === "development" &&
  process.env.REPLIT_DEPLOYMENT !== "1" &&
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED === "true" &&
  process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED === "true";

function validKeyId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function attemptView(row: typeof attempts.$inferSelect): PairKeyAttempt {
  return {
    attemptId: row.attemptId,
    state: row.state as PairKeyAttemptState,
    keyId: row.keyId,
    creationAttemptId: row.creationAttemptId,
    cleanBoundaryEvidenceDigest: row.cleanBoundaryEvidenceDigest,
    metadataVerifiedAt: row.metadataVerifiedAt,
    confirmedAt: row.confirmedAt,
  };
}

/**
 * Lock and validate the frozen config, (1,2) boundary, and its verified
 * creation provenance in the same transaction used by prepare/markAttempted.
 */
async function lockEligiblePair(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const [microConfig] = await tx.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
  const [liveConfig] = await tx.select().from(liveExecutionConfigTable)
    .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
  const [boundary] = await tx.select().from(microLivePairBoundaryTable)
    .where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR_SUBACCOUNT))
    .for("update").limit(1);
  const [creation] = await tx.select().from(creations)
    .where(and(
      eq(creations.targetExchangeIndex, PAIR_EXCHANGE_INDEX),
      eq(creations.subaccountNumber, PAIR_SUBACCOUNT),
    )).for("update").limit(1);

  if (!microConfig || microConfig.microLiveProductionEnabled ||
      microConfig.liveExecutionEnabled || !microConfig.manualKillSwitch ||
      microConfig.microLiveRunPhase !== "FROZEN" ||
      !liveConfig || liveConfig.liveExecutionEnabled ||
      !liveConfig.manualKillSwitch ||
      !boundary || boundary.state !== "CREATED_CLEAN" ||
      boundary.subaccountNumber !== PAIR_SUBACCOUNT ||
      boundary.exchangeIndex !== PAIR_EXCHANGE_INDEX ||
      boundary.restrictedApiKeyId !== null ||
      boundary.restrictedKeyFingerprint !== null ||
      boundary.keyBoundAt !== null ||
      boundary.fundingTransferId !== null ||
      boundary.cleanBalanceMicros !== "0" ||
      !/^[0-9a-f]{64}$/.test(boundary.cleanBoundaryEvidenceDigest) ||
      !boundary.creationAttemptId || !boundary.creationInventoryDigest ||
      !creation || creation.state !== "verified" ||
      creation.subaccountNumber !== PAIR_SUBACCOUNT ||
      creation.targetExchangeIndex !== PAIR_EXCHANGE_INDEX ||
      creation.attemptId !== boundary.creationAttemptId ||
      creation.prePostInventoryDigest !== boundary.creationInventoryDigest ||
      !creation.verifiedAt) {
    return null;
  }
  return { boundary, creation };
}

export const databasePairKeyAttemptStore: PairKeyAttemptStore = {
  async get() {
    const [row] = await db.select().from(attempts)
      .where(and(
        eq(attempts.subaccount, PAIR_SUBACCOUNT),
        eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
      )).limit(1);
    return row ? attemptView(row) : null;
  },

  async prepare() {
    if (!generationAuthorized()) return null;
    return db.transaction(async (tx) => {
      const eligible = await lockEligiblePair(tx);
      if (!eligible) return null;
      const attemptId = randomUUID();
      const [inserted] = await tx.insert(attempts).values({
        attemptId,
        keyName: PAIR_KEY_NAME,
        subaccount: PAIR_SUBACCOUNT,
        exchangeIndex: PAIR_EXCHANGE_INDEX,
        scopes: [...PAIR_SCOPES],
        creationAttemptId: eligible.creation.attemptId,
        cleanBoundaryEvidenceDigest: eligible.boundary.cleanBoundaryEvidenceDigest,
        state: "prepared",
        createdAt: new Date(),
      }).onConflictDoNothing().returning({ attemptId: attempts.attemptId });
      return inserted?.attemptId ?? null;
    });
  },

  async markAttempted(id) {
    if (!generationAuthorized()) return false;
    return db.transaction(async (tx) => {
      const eligible = await lockEligiblePair(tx);
      if (!eligible) return false;
      const [updated] = await tx.update(attempts).set({
        state: "attempted",
        attemptedAt: new Date(),
      }).where(and(
        eq(attempts.attemptId, id),
        eq(attempts.subaccount, PAIR_SUBACCOUNT),
        eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
        eq(attempts.creationAttemptId, eligible.creation.attemptId),
        eq(attempts.cleanBoundaryEvidenceDigest,
          eligible.boundary.cleanBoundaryEvidenceDigest),
        eq(attempts.state, "prepared"),
      )).returning({ attemptId: attempts.attemptId });
      return Boolean(updated);
    });
  },

  async markResponse(id, keyId) {
    if (!validKeyId(keyId)) return false;
    const [updated] = await db.update(attempts).set({
      state: "response_received",
      keyId,
      responseReceivedAt: new Date(),
    }).where(and(
      eq(attempts.attemptId, id),
      eq(attempts.subaccount, PAIR_SUBACCOUNT),
      eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
      eq(attempts.state, "attempted"),
    )).returning({ attemptId: attempts.attemptId });
    return Boolean(updated);
  },

  async markMetadataVerified(id) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(attempts)
        .where(and(
          eq(attempts.attemptId, id),
          eq(attempts.subaccount, PAIR_SUBACCOUNT),
          eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
        )).for("update").limit(1);
      if (!row || !row.keyId || !row.responseReceivedAt || row.metadataVerifiedAt ||
          (row.state !== "response_received" && row.state !== "handoff_confirmed")) {
        return false;
      }
      const [updated] = await tx.update(attempts).set({
        state: row.state === "handoff_confirmed" ? "handoff_confirmed" : "metadata_verified",
        metadataVerifiedAt: new Date(),
      }).where(and(
        eq(attempts.attemptId, id),
        eq(attempts.state, row.state),
      )).returning({ attemptId: attempts.attemptId });
      return Boolean(updated);
    });
  },

  async markConfirmed(id) {
    const [updated] = await db.update(attempts).set({
      state: "handoff_confirmed",
      confirmedAt: new Date(),
    }).where(and(
      eq(attempts.attemptId, id),
      eq(attempts.subaccount, PAIR_SUBACCOUNT),
      eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
      eq(attempts.state, "response_received"),
    )).returning({ attemptId: attempts.attemptId });
    if (updated) return true;

    const [verified] = await db.update(attempts).set({
      state: "handoff_confirmed",
      confirmedAt: new Date(),
    }).where(and(
      eq(attempts.attemptId, id),
      eq(attempts.subaccount, PAIR_SUBACCOUNT),
      eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
      eq(attempts.state, "metadata_verified"),
    )).returning({ attemptId: attempts.attemptId });
    return Boolean(verified);
  },

  async markUncertain(id) {
    const [updated] = await db.update(attempts).set({ state: "uncertain" })
      .where(and(
        eq(attempts.attemptId, id),
        eq(attempts.subaccount, PAIR_SUBACCOUNT),
        eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
        eq(attempts.state, "attempted"),
      )).returning({ attemptId: attempts.attemptId });
    return Boolean(updated);
  },

  async bindingEligible(subaccount, keyId, provenance) {
    if (subaccount !== PAIR_SUBACCOUNT || !validKeyId(keyId) ||
        !provenance.creationAttemptId ||
        !/^[0-9a-f]{64}$/.test(provenance.cleanBoundaryEvidenceDigest)) return false;
    const [row] = await db.select().from(attempts)
      .where(and(
        eq(attempts.subaccount, PAIR_SUBACCOUNT),
        eq(attempts.exchangeIndex, PAIR_EXCHANGE_INDEX),
        eq(attempts.keyId, keyId),
      )).limit(1);
    return Boolean(row &&
      row.keyName === PAIR_KEY_NAME &&
      row.scopes.length === PAIR_SCOPES.length &&
      row.scopes.every((scope, index) => scope === PAIR_SCOPES[index]) &&
      row.state === "handoff_confirmed" &&
      row.metadataVerifiedAt !== null &&
      row.confirmedAt !== null &&
      row.creationAttemptId === provenance.creationAttemptId &&
      row.cleanBoundaryEvidenceDigest === provenance.cleanBoundaryEvidenceDigest);
  },
};