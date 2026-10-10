import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db, liveExecutionConfigTable, microLiveCommissioningArchiveTable,
  microLiveConfigTable, microLiveFillTable, microLiveOrderTable,
  microLivePairBoundaryTable, microLivePairFeeApprovalTable,
  microLivePairFundingAttemptTable, microLiveSettlementTable,
} from "@workspace/db";
import { verifyKalshiRestrictedTradingKeyForSubaccount } from "./kalshiAccountClient";
import { readKalshiDedicatedPairEvidence } from "./kalshiAccountClient";
import { fundingAnchorFromRow, historyReasons } from "./microLivePairBoundary";
import {
  CANONICAL_FEE_SCHEDULE_URL, MAX_FEE_SCHEDULE_BYTES,
  parseFeeSchedulePdf, STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  STANDING_FEE_POLICY_VERSION, verifyCurrentFeeArtifact,
} from "./microLiveFeeArtifact";

const PAIR = 1;
const SHARD = 2;
const CAP = 1_000_000;
// On 2026-09-27 UTC, a fresh GET to CANONICAL_FEE_SCHEDULE_URL returned HTTP
// 429 to this Replit environment. This incident-scoped, commissioning-only
// exception is for the exact owner-supplied July 7 PDF, not proof of a
// successful server fetch or of the source's current availability.
export const PAIR_429_ATTESTATION_SOURCE =
  "owner_attested_http_429_2026_09_27" as const;
const OWNER_ATTESTED_HTTP_429_PDF_DIGEST =
  "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
export type PairFeeReviewSource = "server_fetched" | typeof PAIR_429_ATTESTATION_SOURCE;
type Outcome = { status: "pending" | "reviewed" | "approved" | "blocked"; reason: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function identity() {
  const id = process.env.KALSHI_INDEX2_API_KEY_ID?.trim();
  const raw = process.env.KALSHI_INDEX2_PRIVATE_KEY?.trim();
  if (!id || !raw) return null;
  const pem = raw.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  return { id, fingerprint: createHash("sha256").update(`${id}\u001f${pem}`).digest("hex") };
}

export function commissioningApprovalEnabled() {
  return process.env.NODE_ENV === "development" &&
    process.env.REPLIT_DEPLOYMENT !== "1" &&
    process.env.KALSHI_API_ENVIRONMENT === "production" &&
    process.env.MICRO_LIVE_PRODUCTION_ENABLED !== "true" &&
    process.env.LIVE_EXECUTION_ENABLED !== "true";
}

type Config = typeof microLiveConfigTable.$inferSelect;
type Boundary = typeof microLivePairBoundaryTable.$inferSelect;
type Live = typeof liveExecutionConfigTable.$inferSelect;
export function frozen(config: Config | undefined, live: Live | undefined): config is Config {
  return !!config && !!live && config.microLiveRunPhase === "FROZEN" &&
    !!config.microLiveRunId && config.microLiveRunCapMicros === CAP &&
    !config.microLiveEntryAttempted && !config.microLiveExitAttempted &&
    config.microLiveReservedMicros === 0 && !config.microLiveAccountingUnresolved &&
    config.manualKillSwitch && live.manualKillSwitch &&
    !config.microLiveProductionEnabled && !config.liveExecutionEnabled &&
    !live.liveExecutionEnabled && commissioningApprovalEnabled();
}
export function funded(boundary: Boundary | undefined, key: NonNullable<ReturnType<typeof identity>>): boundary is Boundary {
  return !!boundary && boundary.state === "funded" && !boundary.ambiguityFrozenAt &&
    boundary.subaccountNumber === PAIR && boundary.exchangeIndex === SHARD &&
    boundary.restrictedApiKeyId === key.id &&
    boundary.restrictedKeyFingerprint === key.fingerprint &&
    boundary.cleanBalanceMicros === "0" && boundary.cleanSnapshotAuthenticated &&
    boundary.cleanOrderCount === 0 && boundary.cleanFillCount === 0 &&
    boundary.cleanPositionCount === 0 && boundary.cleanSettlementCount === 0 &&
    boundary.fundingAmountCents === 2500 && !!boundary.fundingTransferId &&
    boundary.postFundingBalanceMicros === "25000000" &&
    boundary.postFundingSnapshotAuthenticated === true &&
    /^[0-9a-f]{64}$/.test(boundary.postFundingEvidenceDigest ?? "");
}
export function matches(
  row: typeof microLivePairFeeApprovalTable.$inferSelect,
  archive: typeof microLiveCommissioningArchiveTable.$inferSelect,
  config: Config, boundary: Boundary, key: NonNullable<ReturnType<typeof identity>>,
) {
  return row.subaccountNumber === PAIR && row.exchangeIndex === SHARD &&
    row.allInCapMicros === CAP && row.priorRunId === config.microLiveRunId &&
    archive.priorRunId === row.priorRunId && archive.phase === "FROZEN" &&
    archive.capMicros === CAP && archive.snapshotDigest === createHash("sha256")
      .update(canonical(archive.snapshot)).digest("hex") &&
    canonical(archive.snapshot) === canonical(JSON.parse(JSON.stringify(config))) &&
    row.restrictedApiKeyId === key.id &&
    row.restrictedKeyFingerprint === key.fingerprint &&
    row.fundingTransferId === boundary.fundingTransferId &&
    row.fundingEvidenceDigest === boundary.postFundingEvidenceDigest;
}

export async function commissioningApprovalView() {
  const [row] = await db.select().from(microLivePairFeeApprovalTable)
    .where(eq(microLivePairFeeApprovalTable.subaccountNumber, PAIR)).limit(1);
  return row ? {
    status: row.state, pair: "(1,2)", allInCapMicros: row.allInCapMicros,
    reviewId: row.reviewId, pdfDigest: row.pdfDigest,
    reviewSource: row.reviewSource,
    sourceAttestedAt: row.sourceAttestedAt?.toISOString() ?? null,
    reviewExpiresAt: row.reviewExpiresAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
  } : { status: "not_prepared", pair: "(1,2)", allInCapMicros: CAP };
}

/** Archive-only copy and separate pending approval; never mutate the historical row. */
export async function preparePairCommissioningApproval(
  actorId: string,
  verifyKey = verifyKalshiRestrictedTradingKeyForSubaccount,
): Promise<Outcome> {
  if (!commissioningApprovalEnabled() || !actorId.trim() || actorId.length > 256)
    return { status: "blocked", reason: "commissioning_environment_or_actor_invalid" };
  const key = identity();
  if (!key || !await verifyKey(PAIR, "index2"))
    return { status: "blocked", reason: "index2_key_unverified" };
  try {
    return await db.transaction(async tx => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [live] = await tx.select().from(liveExecutionConfigTable)
        .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
      const [boundary] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR)).for("update").limit(1);
      if (!frozen(config, live) || !funded(boundary, key))
        return { status: "blocked" as const, reason: "frozen_gates_or_funding_changed" };
      const orders = await tx.select({ id: microLiveOrderTable.id }).from(microLiveOrderTable).limit(1);
      const fills = await tx.select({ id: microLiveFillTable.id }).from(microLiveFillTable).limit(1);
      const settlements = await tx.select({ id: microLiveSettlementTable.positionId }).from(microLiveSettlementTable).limit(1);
      const attempts = await tx.select().from(microLivePairFundingAttemptTable);
      if (orders.length || fills.length || settlements.length || attempts.length !== 1 ||
          attempts[0]?.state !== "reconciled" ||
          attempts[0].transferId !== boundary.fundingTransferId)
        return { status: "blocked" as const, reason: "ledger_or_funding_attempt_changed" };
      const [archive] = await tx.select().from(microLiveCommissioningArchiveTable)
        .where(eq(microLiveCommissioningArchiveTable.priorRunId, config.microLiveRunId!)).limit(1);
      const [row] = await tx.select().from(microLivePairFeeApprovalTable)
        .where(eq(microLivePairFeeApprovalTable.subaccountNumber, PAIR)).limit(1);
      if (archive || row) return archive && row && matches(row, archive, config, boundary, key)
        ? { status: row.state as Outcome["status"], reason: "approval_previously_prepared" }
        : { status: "blocked", reason: "commissioning_identity_changed" };
      const snapshot = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
      await tx.insert(microLiveCommissioningArchiveTable).values({
        priorRunId: config.microLiveRunId!, phase: "FROZEN", capMicros: CAP,
        snapshot, snapshotDigest: createHash("sha256").update(canonical(snapshot)).digest("hex"),
        archivedBy: actorId,
      });
      await tx.insert(microLivePairFeeApprovalTable).values({
        subaccountNumber: PAIR, exchangeIndex: SHARD, priorRunId: config.microLiveRunId!,
        restrictedApiKeyId: key.id, restrictedKeyFingerprint: key.fingerprint,
        fundingTransferId: boundary.fundingTransferId!,
        fundingEvidenceDigest: boundary.postFundingEvidenceDigest!,
        allInCapMicros: CAP, state: "pending",
      });
      return { status: "pending", reason: "archive_and_separate_approval_prepared" };
    });
  } catch {
    return { status: "blocked", reason: "commissioning_preparation_failed" };
  }
}

async function stillBound(row: typeof microLivePairFeeApprovalTable.$inferSelect) {
  const key = identity();
  if (!key || !commissioningApprovalEnabled()) return false;
  const [[config], [live], [boundary], [archive]] = await Promise.all([
    db.select().from(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton")).limit(1),
    db.select().from(liveExecutionConfigTable).where(eq(liveExecutionConfigTable.id, "singleton")).limit(1),
    db.select().from(microLivePairBoundaryTable).where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR)).limit(1),
    db.select().from(microLiveCommissioningArchiveTable)
      .where(eq(microLiveCommissioningArchiveTable.priorRunId, row.priorRunId)).limit(1),
  ]);
  return frozen(config, live) && funded(boundary, key) &&
    !!archive && matches(row, archive, config, boundary, key);
}

/** A fee approval is not run authorization, but must not bless changed pair history. */
async function freshPairStillClean(row: typeof microLivePairFeeApprovalTable.$inferSelect) {
  try {
    const [boundary] = await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR)).limit(1);
    const attempts = await db.select().from(microLivePairFundingAttemptTable);
    const key = identity();
    if (!key || !funded(boundary, key) || attempts.length !== 1 ||
        attempts[0]?.state !== "reconciled" ||
        attempts[0].transferId !== row.fundingTransferId ||
        attempts[0].marketTicker?.startsWith("KXBTC15M-") !== true)
      return false;
    const anchor = fundingAnchorFromRow(boundary);
    if (!anchor) return false;
    const evidence = await readKalshiDedicatedPairEvidence(
      PAIR, attempts[0].marketTicker, anchor, "index2",
    );
    const counts = evidence.recordCounts;
    const scanAt = Date.parse(evidence.scanFinishedAt);
    const reasons = historyReasons(evidence, true);
    // The fee-only approval does not authorize a run: the historical inventory
    // timestamp and pre-funding cross-shard provenance remain unproven. A future
    // initializer must demand its own complete, fresh account proof.
    const feeOnlyReasons = new Set([
      "subaccount_inventory_balance_stale", "post_funding_25_snapshot_unverified",
    ]);
    const records = evidence.records ?? [];
    const pairTransfers = records.filter(record =>
      record.feed === "subaccount_transfer" && record.classification === "pair");
    const changedTransfers = records.some(record =>
      record.feed.includes("transfer") &&
      (record.classification === "pair" || record.classification === "ambiguous") &&
      record.id !== row.fundingTransferId &&
      (!record.occurredAt || !Number.isFinite(Date.parse(record.occurredAt)) ||
        Date.parse(record.occurredAt) >=
        (boundary.postFundingSnapshotAt?.getTime() ?? 0)));
    return evidence.pair.subaccountNumber === PAIR &&
      evidence.pair.exchangeIndex === SHARD &&
      evidence.marketExchangeIndex === SHARD &&
      evidence.keyRestrictionVerified && evidence.tradePermissionVerified &&
      reasons.every(reason => feeOnlyReasons.has(reason)) &&
      Number.isFinite(scanAt) && Math.abs(Date.now() - scanAt) <= 30_000 &&
      evidence.collateralSnapshot?.availableCashMicros === "25000000" &&
      evidence.collateralSnapshot.inventoryBalanceMicros === "25000000" &&
      evidence.collateralSnapshot.restingEntryReserveMicros === "0" &&
      records.some(record => record.feed === "scoped_balance" &&
        record.details.portfolio_value === "0") &&
      counts.positions === 0 && counts.orders === 0 &&
      counts.fills === 0 && counts.settlements === 0 &&
      pairTransfers.length === 1 && pairTransfers[0]?.id === row.fundingTransferId &&
      !changedTransfers;
  } catch {
    return false;
  }
}

/** Reviewing does not approve anything; the owner must make a second explicit POST. */
export async function reviewPairCommissioningFeePdf(
  bytes: Buffer, actorId: string, source: PairFeeReviewSource, attestOfficial = false,
): Promise<Outcome> {
  if (!commissioningApprovalEnabled() || bytes.length > MAX_FEE_SCHEDULE_BYTES)
    return { status: "blocked", reason: "pdf_or_environment_invalid" };
  const [row] = await db.select().from(microLivePairFeeApprovalTable)
    .where(eq(microLivePairFeeApprovalTable.subaccountNumber, PAIR)).limit(1);
  if (!row || row.state !== "pending" || !await stillBound(row))
    return { status: "blocked", reason: "separate_approval_not_pending" };
  const parsed = await parseFeeSchedulePdf(bytes).catch(() => null);
  if (!parsed) return { status: "blocked", reason: "fee_schedule_unverified" };
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (source === PAIR_429_ATTESTATION_SOURCE) {
    if (attestOfficial !== true || !actorId || actorId !== process.env.PHASE4_ADMIN_USER_ID ||
        digest !== OWNER_ATTESTED_HTTP_429_PDF_DIGEST ||
        parsed.effectiveDate !== "2026-07-07" ||
        parsed.formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION ||
        !parsed.feeRule.includes("KXBTC15M"))
      return { status: "blocked", reason: "owner_attestation_or_exact_pdf_invalid" };
  } else if (source === "server_fetched" && attestOfficial !== true) {
    const verification = await verifyCurrentFeeArtifact({
      digest, policyVersion: STANDING_FEE_POLICY_VERSION,
      sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    });
    if (!verification.valid) return { status: "blocked", reason: verification.reason ?? "official_fee_unverified" };
  } else {
    return { status: "blocked", reason: "review_source_invalid" };
  }
  const [updated] = await db.update(microLivePairFeeApprovalTable).set({
    state: "reviewed", reviewId: randomUUID(), pdfDigest: digest,
    reviewSource: source,
    sourceAttestedBy: source === PAIR_429_ATTESTATION_SOURCE ? actorId : null,
    sourceAttestedAt: source === PAIR_429_ATTESTATION_SOURCE ? new Date() : null,
    reviewExpiresAt: new Date(Date.now() + 600_000),
  }).where(and(eq(microLivePairFeeApprovalTable.subaccountNumber, PAIR),
    eq(microLivePairFeeApprovalTable.state, "pending"))).returning();
  return updated ? { status: "reviewed", reason: "owner_approval_required" }
    : { status: "blocked", reason: "review_changed" };
}

function reviewSourceStillBound(
  row: typeof microLivePairFeeApprovalTable.$inferSelect, actorId: string,
) {
  if (row.reviewSource === "server_fetched")
    return row.sourceAttestedBy === null && row.sourceAttestedAt === null;
  return row.reviewSource === PAIR_429_ATTESTATION_SOURCE &&
    row.pdfDigest === OWNER_ATTESTED_HTTP_429_PDF_DIGEST &&
    row.sourceAttestedBy === actorId &&
    !!row.sourceAttestedAt && row.sourceAttestedAt.getTime() <= Date.now() &&
    row.sourceAttestedAt.getTime() <= (row.reviewExpiresAt?.getTime() ?? 0);
}

export async function approvePairCommissioningFee(
  reviewId: string, actorId: string,
): Promise<Outcome> {
  if (!/^[0-9a-f-]{36}$/i.test(reviewId) || !actorId.trim() || actorId.length > 256)
    return { status: "blocked", reason: "owner_approval_invalid" };
  const [row] = await db.select().from(microLivePairFeeApprovalTable)
    .where(eq(microLivePairFeeApprovalTable.subaccountNumber, PAIR)).limit(1);
  if (!row || row.state !== "reviewed" || row.reviewId !== reviewId ||
      !row.pdfDigest || !row.reviewExpiresAt ||
      !reviewSourceStillBound(row, actorId) ||
      row.reviewExpiresAt.getTime() <= Date.now() || !await stillBound(row) ||
      !await freshPairStillClean(row))
    return { status: "blocked", reason: "review_expired_or_boundary_changed" };
  if (row.reviewSource === "server_fetched") {
    const verification = await verifyCurrentFeeArtifact({
      digest: row.pdfDigest, policyVersion: STANDING_FEE_POLICY_VERSION,
      sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    });
    if (!verification.valid) return { status: "blocked", reason: verification.reason ?? "official_fee_unverified" };
  }
  return db.transaction(async tx => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    const [live] = await tx.select().from(liveExecutionConfigTable)
      .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
    const [boundary] = await tx.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR)).for("update").limit(1);
    const [archive] = await tx.select().from(microLiveCommissioningArchiveTable)
      .where(eq(microLiveCommissioningArchiveTable.priorRunId, row.priorRunId)).limit(1);
    const [locked] = await tx.select().from(microLivePairFeeApprovalTable)
      .where(eq(microLivePairFeeApprovalTable.subaccountNumber, PAIR)).for("update").limit(1);
    const orders = await tx.select({ id: microLiveOrderTable.id }).from(microLiveOrderTable).limit(1);
    const fills = await tx.select({ id: microLiveFillTable.id }).from(microLiveFillTable).limit(1);
    const settlements = await tx.select({ id: microLiveSettlementTable.positionId })
      .from(microLiveSettlementTable).limit(1);
    const attempts = await tx.select().from(microLivePairFundingAttemptTable);
    const key = identity();
    if (!key || !frozen(config, live) || !funded(boundary, key) || !archive ||
        !locked || !matches(locked, archive, config, boundary, key) ||
        orders.length || fills.length || settlements.length ||
        attempts.length !== 1 || attempts[0]?.state !== "reconciled" ||
        attempts[0].transferId !== locked.fundingTransferId ||
        locked.state !== "reviewed" || locked.reviewId !== reviewId ||
        locked.pdfDigest !== row.pdfDigest ||
         locked.reviewSource !== row.reviewSource ||
         locked.sourceAttestedBy !== row.sourceAttestedBy ||
         locked.sourceAttestedAt?.getTime() !== row.sourceAttestedAt?.getTime() ||
         !reviewSourceStillBound(locked, actorId) ||
        !locked.reviewExpiresAt || locked.reviewExpiresAt.getTime() <= Date.now())
      return { status: "blocked", reason: "approval_interlock_failed" };
    const [updated] = await tx.update(microLivePairFeeApprovalTable).set({
      state: "approved", approvedBy: actorId, approvedAt: new Date(),
    }).where(and(eq(microLivePairFeeApprovalTable.subaccountNumber, PAIR),
      eq(microLivePairFeeApprovalTable.state, "reviewed"))).returning();
    return updated ? { status: "approved", reason: "separate_fee_policy_approved_only_execution_off" }
      : { status: "blocked", reason: "approval_interlock_failed" };
  });
}