import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, microLiveConfigTable } from "@workspace/db";
import {
  beginFeeVerification, finishFeeVerification, getFeeVerificationState,
  type FeeVerificationIdentity, type FeeVerificationStatus,
} from "./microLiveFeeVerification";
import {
  CANONICAL_FEE_SCHEDULE_URL, MAX_FEE_SCHEDULE_BYTES,
  STANDARD_QUADRATIC_FEE_FORMULA_VERSION, STANDING_FEE_POLICY_VERSION,
  parseFeeSchedulePdf, parseFeeScheduleText, verifyCurrentFeeArtifact,
  type FeeArtifactVerification,
} from "./microLiveFeeArtifact";

const REVIEW_MS = 10 * 60_000;
const FEE_ARTIFACT_MONITOR_MS = 5 * 60_000;
const MAX_EXPOSURE_MICROS = 5_000_000;
const MIN_RUN_CAP_MICROS = 1_000_000;
export { STANDING_FEE_POLICY_VERSION };

export type FeeApprovalView = {
  status: "none" | "review" | "approved";
  reviewId: string | null;
  digest: string | null;
  effectiveDate: string | null;
  feeRule: string | null;
  evidence: string | null;
  expiresAt: string | null;
  approvedAt: string | null;
  approved: boolean;
  policyVersion: string | null;
  maximumExposureMicros: number | null;
  approvedRunCapMicros: number | null;
  approvedBy: string | null;
  sourceUrl: string | null;
  formulaVersion: string | null;
  artifactStatus: "unverified" | "verified" | "changed" | "unavailable" | "invalid";
  artifactCheckedAt: string | null;
  artifactReason: string | null;
};
type Review = {
  id: string; digest: string; effectiveDate: string; feeRule: string; sourceUrl: string;
  formulaVersion: string;
  evidence: string; expiresAt: number; approvedAt: number | null;
};
let currentReview: Review | null = null;

type FeeApprovalRow = typeof microLiveConfigTable.$inferSelect;
export type ApprovedFeeSession = {
  id: string;
  digest: string;
  approvedAt: number;
  policyVersion: string;
  maximumExposureMicros: number;
  approvedRunCapMicros: number;
  approvedBy: string;
  sourceUrl: string;
  formulaVersion: string;
  legacyArtifactMetadata?: boolean;
};

function completeApproval(row: FeeApprovalRow): ApprovedFeeSession | null {
  const approvedAt = row.microLiveFeeApprovalApprovedAt?.getTime() ?? NaN;
  const currentCap = row.microLiveRunCapMicros;
  const maximumExposureMicros = row.microLiveFeeMaximumExposureMicros;
  const approvedRunCapMicros = row.microLiveFeeApprovedRunCapMicros;
  const approvedBy = row.microLiveFeeApprovedBy;
  if (!row.microLiveFeeApprovalApproved ||
      typeof row.microLiveFeeApprovalId !== "string" || !row.microLiveFeeApprovalId ||
      typeof row.microLiveFeeApprovalDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.microLiveFeeApprovalDigest) ||
      !Number.isFinite(approvedAt) || approvedAt <= 0 ||
      row.microLiveFeePolicyVersion !== STANDING_FEE_POLICY_VERSION ||
      row.microLiveFeeApprovalSourceUrl !== CANONICAL_FEE_SCHEDULE_URL ||
      row.microLiveFeeFormulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION ||
      row.microLiveFeeApprovalInvalidated ||
      !Number.isSafeInteger(maximumExposureMicros) || maximumExposureMicros! < 1 ||
      maximumExposureMicros! > MAX_EXPOSURE_MICROS ||
      !Number.isSafeInteger(approvedRunCapMicros) ||
      approvedRunCapMicros! < MIN_RUN_CAP_MICROS ||
      approvedRunCapMicros! > MAX_EXPOSURE_MICROS ||
      !Number.isSafeInteger(currentCap) || currentCap < MIN_RUN_CAP_MICROS ||
      currentCap > approvedRunCapMicros! || currentCap > maximumExposureMicros! ||
      currentCap > MAX_EXPOSURE_MICROS ||
      typeof approvedBy !== "string" || !approvedBy.trim()) return null;
  return {
    id: row.microLiveFeeApprovalId,
    digest: row.microLiveFeeApprovalDigest,
    approvedAt,
    policyVersion: STANDING_FEE_POLICY_VERSION,
    maximumExposureMicros: maximumExposureMicros!,
    approvedRunCapMicros: approvedRunCapMicros!,
    approvedBy,
    sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  };
}

let lastArtifactVerification: FeeArtifactVerification | null = null;
let artifactMonitorTimer: ReturnType<typeof setInterval> | null = null;
let artifactMonitorInFlight: Promise<void> | null = null;

function artifactStatus(
  row: FeeApprovalRow | null,
  verification: FeeArtifactVerification | null,
): FeeApprovalView["artifactStatus"] {
  if (verification) return verification.status;
  if (row?.microLiveFeeArtifactStatus === "verified" ||
      row?.microLiveFeeArtifactStatus === "changed" ||
      row?.microLiveFeeArtifactStatus === "unavailable" ||
      row?.microLiveFeeArtifactStatus === "invalid") return row.microLiveFeeArtifactStatus;
  return "unverified";
}

function artifactConditions(approval: ApprovedFeeSession) {
  return [
    eq(microLiveConfigTable.id, "singleton"),
    eq(microLiveConfigTable.microLiveFeeApprovalApproved, true),
    eq(microLiveConfigTable.microLiveFeeApprovalId, approval.id),
    eq(microLiveConfigTable.microLiveFeeApprovalDigest, approval.digest),
    eq(microLiveConfigTable.microLiveFeeApprovalApprovedAt, new Date(approval.approvedAt)),
    eq(microLiveConfigTable.microLiveFeePolicyVersion, approval.policyVersion),
    eq(microLiveConfigTable.microLiveFeeApprovalSourceUrl, approval.sourceUrl),
    eq(microLiveConfigTable.microLiveFeeFormulaVersion, approval.formulaVersion),
    eq(microLiveConfigTable.microLiveFeeMaximumExposureMicros, approval.maximumExposureMicros),
    eq(microLiveConfigTable.microLiveFeeApprovedRunCapMicros, approval.approvedRunCapMicros),
    eq(microLiveConfigTable.microLiveFeeApprovedBy, approval.approvedBy),
  ];
}

function verificationIdentity(approval: ApprovedFeeSession): FeeVerificationIdentity {
  return {
    approvalId: approval.id,
    approvalDigest: approval.digest,
    policyVersion: approval.policyVersion,
    sourceUrl: approval.sourceUrl,
    formulaVersion: approval.formulaVersion,
  };
}

async function verifyAndPersistApproval(
  approval: ApprovedFeeSession,
): Promise<boolean> {
  const identity = verificationIdentity(approval);
  const attemptId = await beginFeeVerification(identity);
  if (!attemptId) return false;
  let verification: FeeArtifactVerification;
  try {
    verification = await verifyCurrentFeeArtifact(approval);
  } catch {
    verification = {
      status: "unavailable", valid: false, sourceUrl: approval.sourceUrl,
      digest: approval.digest, formulaVersion: approval.formulaVersion,
      verifiedAt: Date.now(), reason: "fee_artifact_monitor_error",
    };
  }
  lastArtifactVerification = verification;
  // A PDF read can never prove the current live fee model. A matching PDF
  // therefore closes its precommitted fence as unavailable until fresh live
  // series/event/schedule metadata verifies the runtime gate.
  const status: Exclude<FeeVerificationStatus, "pending" | "verified"> =
    verification.valid ? "unavailable" :
      verification.status === "unavailable" ? "unavailable" : "invalid";
  const reason = verification.valid
    ? "live_fee_metadata_verification_required" : verification.reason;
  if (!await finishFeeVerification(identity, attemptId, status, reason, null,
      verification.verifiedAt === null ? new Date() :
        new Date(verification.verifiedAt))) {
    return false;
  }
  const [updated] = await db.update(microLiveConfigTable).set({
    microLiveFeeArtifactStatus: verification.status,
    microLiveFeeArtifactCheckedAt: verification.verifiedAt === null
      ? null : new Date(verification.verifiedAt),
    microLiveFeeArtifactReason: verification.reason,
    ...(status === "invalid" ? {
      microLiveFeeApprovalApproved: false,
      microLiveFeeApprovalInvalidated: true,
    } : {}),
  }).where(and(...artifactConditions(approval)))
    .returning({ id: microLiveConfigTable.id });
  return verification.valid && updated !== undefined;
}

export async function checkApprovedFeeArtifactNow(): Promise<boolean> {
  try {
    const row = await readApprovalRow();
    const approval = row?.microLiveFeeApprovalApproved ? completeApproval(row) : null;
    return approval ? verifyAndPersistApproval(approval) : false;
  } catch {
    return false;
  }
}

async function readApprovalRow(): Promise<FeeApprovalRow | null> {
  const [row] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  return row ?? null;
}

async function verifyApprovalRead(
  row: FeeApprovalRow | null,
): Promise<ApprovedFeeSession | null> {
  const approval = row ? completeApproval(row) : null;
  if (!approval) return null;
  const gate = await getFeeVerificationState(verificationIdentity(approval));
  if (gate && gate.status !== "verified" && gate.status !== "unavailable") {
    if (gate?.status === "invalid") {
      lastArtifactVerification = {
        status: "invalid", valid: false, sourceUrl: approval.sourceUrl,
        digest: approval.digest, formulaVersion: approval.formulaVersion,
        verifiedAt: gate.checkedAt?.getTime() ?? null,
        reason: gate.reason ?? "fee_artifact_invalid",
      };
    }
    return null;
  }
  if (gate?.status === "unavailable") {
    lastArtifactVerification = {
      status: "unavailable", valid: false, sourceUrl: approval.sourceUrl,
      digest: approval.digest, formulaVersion: approval.formulaVersion,
      verifiedAt: gate.checkedAt?.getTime() ?? null,
      reason: gate.reason ?? "official_fee_artifact_unavailable",
    };
  }
  return approval;
}

export async function revokeFeeApproval(): Promise<void> {
  await db.update(microLiveConfigTable).set({
    microLiveFeeApprovalApproved: false,
    microLiveFeeApprovalInvalidated: true,
    microLiveFeeArtifactStatus: "unverified",
    microLiveFeeArtifactCheckedAt: null,
    microLiveFeeArtifactReason: null,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  lastArtifactVerification = null;
}

export async function feeApprovalView(): Promise<FeeApprovalView> {
  const row = await readApprovalRow();
  const approval = await verifyApprovalRead(row);
  const persistedApproval = row ? completeApproval(row) : null;
  const gate = persistedApproval
    ? await getFeeVerificationState(verificationIdentity(persistedApproval)) : null;
  const currentVerification = row &&
    lastArtifactVerification?.digest === row.microLiveFeeApprovalDigest &&
    lastArtifactVerification.formulaVersion === row.microLiveFeeFormulaVersion
    ? lastArtifactVerification : null;
  const displayArtifactStatus = row?.microLiveFeeApprovalApproved && !persistedApproval
    ? "invalid"
    : gate?.status === "invalid" ? "invalid"
      : gate?.status === "unavailable" ? "unavailable"
        : !gate || gate.status === "pending" ? "unverified"
          : artifactStatus(row, currentVerification);
  const review = currentReview && currentReview.expiresAt > Date.now()
    ? currentReview : null;
  const approvedReview = approval && review?.id === approval.id &&
    review.digest === approval.digest ? review : null;
  return {
    status: approval ? "approved" : review ? "review" : "none",
    reviewId: approval?.id ?? review?.id ?? null,
    digest: approval?.digest ?? review?.digest ?? null,
    effectiveDate: approvedReview?.effectiveDate ?? review?.effectiveDate ?? null,
    feeRule: approvedReview?.feeRule ?? review?.feeRule ?? null,
    evidence: approvedReview?.evidence ?? review?.evidence ?? null,
    expiresAt: approval ? null : review ? new Date(review.expiresAt).toISOString() : null,
    approvedAt: approval ? new Date(approval.approvedAt).toISOString() : null,
    approved: approval !== null,
    policyVersion: approval?.policyVersion ?? null,
    maximumExposureMicros: approval?.maximumExposureMicros ?? null,
    approvedRunCapMicros: approval?.approvedRunCapMicros ?? null,
    approvedBy: approval?.approvedBy ?? null,
    sourceUrl: approval?.sourceUrl ?? review?.sourceUrl ??
      row?.microLiveFeeApprovalSourceUrl ?? null,
    formulaVersion: approval?.formulaVersion ?? review?.formulaVersion ??
      row?.microLiveFeeFormulaVersion ?? null,
    artifactStatus: displayArtifactStatus,
    artifactCheckedAt: currentVerification?.verifiedAt
      ? new Date(currentVerification.verifiedAt).toISOString()
      : row?.microLiveFeeArtifactCheckedAt?.toISOString() ?? null,
    artifactReason: currentVerification?.reason ??
      row?.microLiveFeeArtifactReason ?? null,
  };
}

export async function approvedFeeSession(): Promise<ApprovedFeeSession | null> {
  const row = await readApprovalRow();
  return verifyApprovalRead(row);
}

export function parseScheduleText(text: string) {
  return parseFeeScheduleText(text);
}

export async function reviewFeeSchedulePdf(bytes: Buffer): Promise<FeeApprovalView> {
  // Reviewing a new document explicitly invalidates the standing approval.
  // The pending review remains process-local and expires after ten minutes.
  await revokeFeeApproval();
  currentReview = null;
  if (bytes.length < 100 || bytes.length > MAX_FEE_SCHEDULE_BYTES ||
      bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("A PDF under 2 MB is required");
  const parsed = await parseFeeSchedulePdf(bytes);
  if (!parsed) throw new Error("Effective date or standard quadratic fee rule could not be verified from the PDF");
  currentReview = {
    ...parsed, id: randomUUID(), sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    digest: createHash("sha256").update(bytes).digest("hex"),
    expiresAt: Date.now() + REVIEW_MS, approvedAt: null,
  };
  return feeApprovalView();
}

export async function approveFeeSchedule(
  reviewId: string,
  digest: string,
  actorId: string,
): Promise<FeeApprovalView | null> {
  const now = Date.now();
  const review = currentReview;
  const approvingActor = typeof actorId === "string" ? actorId.trim() : "";
  if (!approvingActor || approvingActor.length > 256 ||
      !review || review.approvedAt !== null ||
      review.expiresAt <= now || review.id !== reviewId || review.digest !== digest) return null;
  const identity = {
    approvalId: review.id,
    approvalDigest: review.digest,
    digest: review.digest,
    policyVersion: STANDING_FEE_POLICY_VERSION,
    sourceUrl: review.sourceUrl, formulaVersion: review.formulaVersion,
  };
  const gateIdentity: FeeVerificationIdentity = {
    approvalId: identity.approvalId,
    approvalDigest: identity.approvalDigest,
    policyVersion: identity.policyVersion,
    sourceUrl: identity.sourceUrl,
    formulaVersion: identity.formulaVersion,
  };
  const attemptId = await beginFeeVerification(gateIdentity);
  if (!attemptId) return null;
  let verification: FeeArtifactVerification;
  try {
    verification = await verifyCurrentFeeArtifact(identity);
  } catch {
    verification = {
      status: "unavailable", valid: false, sourceUrl: review.sourceUrl,
      digest: review.digest, formulaVersion: review.formulaVersion,
      verifiedAt: Date.now(), reason: "fee_artifact_verification_error",
    };
  }
  lastArtifactVerification = verification;
  const gateStatus: Exclude<FeeVerificationStatus, "pending" | "verified"> =
    verification.valid ? "unavailable" :
      verification.status === "unavailable" ? "unavailable" : "invalid";
  const gateReason = verification.valid
    ? "live_fee_metadata_verification_required" : verification.reason;
  if (!await finishFeeVerification(gateIdentity, attemptId, gateStatus, gateReason,
      null, verification.verifiedAt === null ? new Date() :
        new Date(verification.verifiedAt))) {
    throw new Error("Durable fee verification state could not be committed");
  }
  if (!verification.valid) {
    if (verification.status === "unavailable") {
      throw new Error(verification.reason ?? "Canonical fee artifact is temporarily unavailable");
    }
    throw new Error(verification.reason ?? "Canonical fee artifact verification failed");
  }
  const saved = await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    if (!config || !Number.isSafeInteger(config.microLiveRunCapMicros) ||
        config.microLiveRunCapMicros < MIN_RUN_CAP_MICROS ||
        config.microLiveRunCapMicros > MAX_EXPOSURE_MICROS) return false;
    const [updated] = await tx.update(microLiveConfigTable).set({
      microLiveFeeApprovalId: review.id,
      microLiveFeeApprovalDigest: review.digest,
      microLiveFeeApprovalApproved: true,
      microLiveFeeApprovalInvalidated: false,
      microLiveFeeApprovalApprovedAt: new Date(now),
      microLiveFeePolicyVersion: STANDING_FEE_POLICY_VERSION,
      microLiveFeeApprovalSourceUrl: review.sourceUrl,
      microLiveFeeFormulaVersion: review.formulaVersion,
      microLiveFeeMaximumExposureMicros: MAX_EXPOSURE_MICROS,
      microLiveFeeApprovedBy: approvingActor,
      microLiveFeeApprovedRunCapMicros: config.microLiveRunCapMicros,
      microLiveFeeArtifactStatus: "verified",
      microLiveFeeArtifactCheckedAt: verification.verifiedAt
        ? new Date(verification.verifiedAt) : new Date(now),
      microLiveFeeArtifactReason: null,
    }).where(eq(microLiveConfigTable.id, "singleton")).returning({
      id: microLiveConfigTable.id,
    });
    return updated !== undefined;
  });
  if (!saved) return null;
  // Authorization is now durable; the process-local review is no longer an
  // authorization source and must never be renewed after a restart.
  currentReview = null;
  return feeApprovalView();
}

/** Starts one immediate read-only check and a five-minute process-local monitor. */
export function startFeeArtifactMonitor(): void {
  if (artifactMonitorTimer) return;
  const check = async () => {
    if (artifactMonitorInFlight) return artifactMonitorInFlight;
    artifactMonitorInFlight = (async () => {
      try {
        const row = await readApprovalRow();
        if (row?.microLiveFeeApprovalApproved) {
          const approval = completeApproval(row);
          if (!approval) {
            const reason = Number.isSafeInteger(row.microLiveFeeApprovedRunCapMicros) &&
              row.microLiveRunCapMicros > row.microLiveFeeApprovedRunCapMicros!
              ? "approved_run_cap_exceeded"
              : "persisted_approval_identity_invalid";
            const [updated] = await db.update(microLiveConfigTable).set({
              microLiveFeeApprovalApproved: false,
              microLiveFeeApprovalInvalidated: true,
              microLiveFeeArtifactStatus: "invalid",
              microLiveFeeArtifactCheckedAt: new Date(),
              microLiveFeeArtifactReason: reason,
            }).where(and(
              eq(microLiveConfigTable.id, "singleton"),
              eq(microLiveConfigTable.microLiveFeeApprovalApproved, true),
              row.microLiveFeeApprovalId === null
                ? isNull(microLiveConfigTable.microLiveFeeApprovalId)
                : eq(microLiveConfigTable.microLiveFeeApprovalId,
                  row.microLiveFeeApprovalId),
              row.microLiveFeeApprovalDigest === null
                ? isNull(microLiveConfigTable.microLiveFeeApprovalDigest)
                : eq(microLiveConfigTable.microLiveFeeApprovalDigest,
                  row.microLiveFeeApprovalDigest),
            )).returning({ id: microLiveConfigTable.id });
            if (updated) lastArtifactVerification = {
              status: "invalid", valid: false, sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
              digest: row.microLiveFeeApprovalDigest,
              formulaVersion: row.microLiveFeeFormulaVersion,
              verifiedAt: Date.now(), reason,
            };
          } else {
            await checkApprovedFeeArtifactNow();
          }
        }
      } catch {
        lastArtifactVerification = {
          status: "unavailable", valid: false, sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
          digest: null, formulaVersion: null, verifiedAt: Date.now(),
          reason: "fee_artifact_monitor_error",
        };
      } finally {
        artifactMonitorInFlight = null;
      }
    })();
    return artifactMonitorInFlight;
  };
  void check();
  artifactMonitorTimer = setInterval(() => void check(), FEE_ARTIFACT_MONITOR_MS);
  artifactMonitorTimer.unref?.();
}