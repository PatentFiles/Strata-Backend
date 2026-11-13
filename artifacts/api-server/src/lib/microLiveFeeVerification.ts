import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, microLiveFeeVerificationTable } from "@workspace/db";

export type FeeVerificationIdentity = {
  approvalId: string;
  approvalDigest: string;
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
};

export type FeeVerificationTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

export type FeeVerificationStatus = "pending" | "verified" | "unavailable" | "invalid";

export type FeeVerificationState = {
  status: FeeVerificationStatus;
  attemptId: string | null;
  reason: string | null;
  checkedAt: Date | null;
  feeEvidenceFingerprint: string | null;
} | null;

const identityWhere = (identity: FeeVerificationIdentity) => and(
  eq(microLiveFeeVerificationTable.approvalId, identity.approvalId),
  eq(microLiveFeeVerificationTable.approvalDigest, identity.approvalDigest),
  eq(microLiveFeeVerificationTable.policyVersion, identity.policyVersion),
  eq(microLiveFeeVerificationTable.sourceUrl, identity.sourceUrl),
  eq(microLiveFeeVerificationTable.formulaVersion, identity.formulaVersion),
);

function wellFormedIdentity(identity: FeeVerificationIdentity): boolean {
  return typeof identity.approvalId === "string" && identity.approvalId.length > 0 &&
    /^[a-f0-9]{64}$/.test(identity.approvalDigest) &&
    typeof identity.policyVersion === "string" && identity.policyVersion.length > 0 &&
    typeof identity.sourceUrl === "string" && identity.sourceUrl.length > 0 &&
    typeof identity.formulaVersion === "string" && identity.formulaVersion.length > 0;
}

/**
 * Commits a closed verification fence before any source GET begins. A pending
 * attempt left by process death is intentionally not recoverable by a timer
 * or by a later successful source read; a new admin approval has a new ID.
 */
export async function beginFeeVerification(
  identity: FeeVerificationIdentity,
): Promise<string | null> {
  if (!wellFormedIdentity(identity)) return null;
  const attemptId = randomUUID();
  try {
    return await db.transaction(async (tx) => {
      let [row] = await tx.select().from(microLiveFeeVerificationTable)
        .where(eq(microLiveFeeVerificationTable.approvalId, identity.approvalId))
        .for("update").limit(1);
      if (!row) {
        const [inserted] = await tx.insert(microLiveFeeVerificationTable).values({
          ...identity, status: "pending", attemptId, reason: null, checkedAt: null,
          feeEvidenceFingerprint: null,
        }).onConflictDoNothing().returning({ approvalId: microLiveFeeVerificationTable.approvalId });
        if (!inserted) {
          [row] = await tx.select().from(microLiveFeeVerificationTable)
            .where(eq(microLiveFeeVerificationTable.approvalId, identity.approvalId))
            .for("update").limit(1);
        } else {
          return attemptId;
        }
      }
      if (!row || !matchesIdentity(row, identity) ||
          row.status === "pending" || row.status === "invalid") return null;
      const [updated] = await tx.update(microLiveFeeVerificationTable).set({
        status: "pending", attemptId, reason: null, checkedAt: null,
        feeEvidenceFingerprint: null, updatedAt: new Date(),
      }).where(and(
        identityWhere(identity),
        inArray(microLiveFeeVerificationTable.status, ["verified", "unavailable"]),
      )).returning({ approvalId: microLiveFeeVerificationTable.approvalId });
      return updated ? attemptId : null;
    });
  } catch {
    return null;
  }
}

export async function finishFeeVerification(
  identity: FeeVerificationIdentity,
  attemptId: string,
  status: Exclude<FeeVerificationStatus, "pending">,
  reason: string | null,
  feeEvidenceFingerprint: string | null = null,
  checkedAt: Date | null = new Date(),
): Promise<boolean> {
  if (!wellFormedIdentity(identity) || !attemptId ||
      !["verified", "unavailable", "invalid"].includes(status) ||
      reason !== null && (typeof reason !== "string" || reason.length > 512) ||
      status === "verified" && (typeof feeEvidenceFingerprint !== "string" ||
        feeEvidenceFingerprint.trim().length === 0 ||
        !(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) ||
      status !== "verified" && feeEvidenceFingerprint !== null ||
      checkedAt !== null && (!(checkedAt instanceof Date) ||
        !Number.isFinite(checkedAt.getTime()))) return false;
  try {
    const where = [
      identityWhere(identity),
      eq(microLiveFeeVerificationTable.status, "pending"),
      eq(microLiveFeeVerificationTable.attemptId, attemptId),
    ];
    // A definitive invalidation is sticky. A stale success/unavailable writer
    // may only finish its own pending attempt and can never clear "invalid".
    const [updated] = await db.update(microLiveFeeVerificationTable).set({
      status, attemptId: null, reason, checkedAt, feeEvidenceFingerprint,
      updatedAt: new Date(),
    }).where(and(...where)).returning({ approvalId: microLiveFeeVerificationTable.approvalId });
    return updated !== undefined;
  } catch {
    return false;
  }
}

export async function getFeeVerificationState(
  identity: FeeVerificationIdentity,
): Promise<FeeVerificationState> {
  if (!wellFormedIdentity(identity)) return null;
  try {
    const [row] = await db.select().from(microLiveFeeVerificationTable)
      .where(identityWhere(identity)).limit(1);
    if (!row) return null;
    return {
      status: row.status as FeeVerificationStatus,
      attemptId: row.attemptId,
      reason: row.reason,
      checkedAt: row.checkedAt,
      feeEvidenceFingerprint: row.feeEvidenceFingerprint,
    };
  } catch {
    // An unreadable gate is not an open gate.
    return { status: "pending", attemptId: null, reason: "fee_verification_gate_unavailable",
      checkedAt: null, feeEvidenceFingerprint: null };
  }
}

export async function feeVerificationAttemptIsPending(
  identity: FeeVerificationIdentity,
  attemptId: string,
): Promise<boolean> {
  const state = await getFeeVerificationState(identity);
  return state?.status === "pending" && state.attemptId === attemptId;
}

/**
 * Final POST interlock. Use the caller's transaction so the row lock is held
 * through the exchange request and commit. A verifier which starts afterward
 * waits; an already-persisted pending/invalid state blocks this caller.
 */
export async function lockFeeVerificationForPost(
  tx: FeeVerificationTransaction,
  identity: FeeVerificationIdentity,
  expectedFingerprint: string,
  expectedVerifiedAt: number | Date,
  now = Date.now(),
): Promise<boolean> {
  const expectedAt = expectedVerifiedAt instanceof Date
    ? expectedVerifiedAt.getTime() : expectedVerifiedAt;
  if (!wellFormedIdentity(identity) ||
      typeof expectedFingerprint !== "string" || !expectedFingerprint.trim() ||
      !Number.isFinite(expectedAt) || !Number.isFinite(now)) return false;
  try {
    const [row] = await tx.select().from(microLiveFeeVerificationTable)
      .where(identityWhere(identity)).for("update").limit(1);
    const checkedAt = row?.checkedAt?.getTime() ?? NaN;
    const ageMs = now - checkedAt;
    return row?.status === "verified" &&
      row.feeEvidenceFingerprint === expectedFingerprint &&
      Number.isFinite(checkedAt) && checkedAt === expectedAt &&
      ageMs >= 0 && ageMs <= 15_000;
  } catch {
    return false;
  }
}

export function feeVerificationIdentityMatches(
  row: Pick<typeof microLiveFeeVerificationTable.$inferSelect,
    "approvalId" | "approvalDigest" | "policyVersion" |
    "sourceUrl" | "formulaVersion">,
  identity: FeeVerificationIdentity,
): boolean {
  return matchesIdentity(row, identity);
}

function matchesIdentity(
  row: Pick<typeof microLiveFeeVerificationTable.$inferSelect,
    "approvalId" | "approvalDigest" | "policyVersion" |
    "sourceUrl" | "formulaVersion">,
  identity: FeeVerificationIdentity,
): boolean {
  return row.approvalId === identity.approvalId &&
    row.approvalDigest === identity.approvalDigest &&
    row.policyVersion === identity.policyVersion &&
    row.sourceUrl === identity.sourceUrl &&
    row.formulaVersion === identity.formulaVersion;
}