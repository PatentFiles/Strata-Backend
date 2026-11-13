import { and, eq, sql } from "drizzle-orm";
import {
  db, pool, microLiveConfigTable, liveExecutionConfigTable,
  microLivePairBoundaryTable, microLiveCommissioningArchiveTable,
  microLiveRunArchiveTable, microLivePairFeeApprovalTable,
  microLivePairFundingAttemptTable, microLivePairKeyProvisioningAttemptTable,
  microLiveSubaccountCreationAttemptTable,
} from "@workspace/db";
import { requireDevelopmentDatabase } from "../../scripts/require-development-db.mjs";
import { configuredKey, fundingAnchorFromRow, historyReasons, transferIsExactFunding } from "./microLivePairBoundary";
import { frozen, funded, matches } from "./microLivePairCommissioningApproval";
import { readKalshiDedicatedPairEvidence } from "./kalshiAccountClient";
import {
  verifyCurrentFeeArtifact, STANDING_FEE_POLICY_VERSION,
  CANONICAL_FEE_SCHEDULE_URL, STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
} from "./microLiveFeeArtifact";
import {
  canonical, digest, requireRepair, REPAIR_REASON, runCommissioningTransition,
  type Plan, type RepairRequest, type Row, type Snapshot, type FreshProof,
} from "./v13CommissioningTransition";

function developmentContext() {
  requireRepair(process.env.NODE_ENV === "development" &&
    process.env.REPLIT_DEPLOYMENT !== "1" && process.env.CI !== "true" &&
    process.env.GITHUB_ACTIONS !== "true" &&
    process.env.KALSHI_API_ENVIRONMENT === "production" &&
    process.env.LIVE_EXECUTION_ENABLED !== "true" &&
    process.env.MICRO_LIVE_PRODUCTION_ENABLED !== "true",
  "explicit_development_context_required");
  requireRepair(process.env.MICRO_LIVE_ACCOUNT_MODE === "exclusive" &&
    process.env.KALSHI_BOT_SUBACCOUNT === "1", "dedicated_environment_binding_required");
}

export type DisposableRepairProof = {
  authenticate: (state: Snapshot, ticker: string) => Promise<FreshProof>;
  keyIdentity: () => { apiKeyId: string; fingerprint: string };
  fault?: (stage: string) => void;
};
// Injection can ONLY target an explicitly named loopback disposable test DB.
// The normal CLI has no injection argument and retains every real proof guard.
export async function repairDevelopmentCommissioning(request: RepairRequest, disposable?: DisposableRepairProof) {
  async function prove(client: { query: (text: string) => Promise<{ rows: unknown[] }> }) {
    if (!disposable) { developmentContext(); await requireDevelopmentDatabase(client); return; }
    requireRepair(process.env.NODE_ENV === "test" &&
      process.env.DATABASE_URL === process.env.V13_DISPOSABLE_DATABASE_URL &&
      /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(process.env.V13_DISPOSABLE_DATABASE_URL ?? ""),
    "explicit_disposable_context_required");
    const result = await client.query("SELECT current_database() AS db,host(inet_server_addr()) AS host");
    const row = (result as { rows: { db: string; host: string }[] }).rows[0];
    requireRepair(row && /^v13_disposable_\d+$/.test(row.db) && row.host === "127.0.0.1",
      "disposable_database_identity_required");
  }
  return runCommissioningTransition({
    async proveDevelopment() {
      await prove(pool);
    },
    async transaction(apply, body) {
      return db.transaction(async tx => {
        const txClient = {
          async query(text: string) { return await tx.execute(sql.raw(text)); },
        };
        await prove(txClient);
        if (apply) {
          // Serialize competing repairs and freeze evidence/ledger inserts through the final commit.
          // Fixed identifiers only; never interpolate caller input into SQL.
          await tx.execute(sql`LOCK TABLE micro_live_config, live_execution_config,
            micro_live_pair_boundary, micro_live_commissioning_archive, micro_live_run_archive,
            micro_live_pair_fee_approval, micro_live_pair_funding_attempts,
            micro_live_pair_key_provisioning_attempts, micro_live_subaccount_creation_attempts,
            micro_live_orders, micro_live_fills, micro_live_settlements, micro_live_decisions
            IN SHARE ROW EXCLUSIVE MODE`);
        }
        const read = async (expectedRun: string): Promise<Snapshot> => {
          const [[config], [live], [boundary], [archive], [audit]] = await Promise.all([
            tx.select().from(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton")),
            tx.select().from(liveExecutionConfigTable).where(eq(liveExecutionConfigTable.id, "singleton")),
            tx.select().from(microLivePairBoundaryTable).where(eq(microLivePairBoundaryTable.subaccountNumber, 1)),
            tx.select().from(microLiveCommissioningArchiveTable).where(eq(microLiveCommissioningArchiveTable.priorRunId, expectedRun)),
            tx.select().from(microLiveRunArchiveTable).where(eq(microLiveRunArchiveTable.priorRunId, expectedRun)),
          ]);
          requireRepair(config && live && boundary && archive, "commissioning_evidence_missing");
          const [afterArchive] = await tx.select().from(microLiveCommissioningArchiveTable)
            .where(eq(microLiveCommissioningArchiveTable.priorRunId, config.microLiveRunId ?? ""));
          return { config, live, boundary, archive, audit, afterArchive,
            original: archive.snapshot };
        };
        const authenticate = async (state: Snapshot, ticker: string) => {
          if (disposable) return disposable.authenticate(state, ticker);
          developmentContext();
          const key = configuredKey("index2");
          const boundary = state.boundary as typeof microLivePairBoundaryTable.$inferSelect;
          requireRepair(key, "index2_credentials_missing");
          requireRepair(frozen(state.config as typeof microLiveConfigTable.$inferSelect,
            state.live as typeof liveExecutionConfigTable.$inferSelect), "frozen_gates_changed");
          // The same funded-evidence guard applies to an already initialized, audited boundary.
          requireRepair(funded({ ...boundary, state: "funded" },
            { id: key.apiKeyId, fingerprint: key.fingerprint }), "funded_index2_boundary_mismatch");
          const [fee] = await tx.select().from(microLivePairFeeApprovalTable)
            .where(eq(microLivePairFeeApprovalTable.subaccountNumber, 1));
          const funding = await tx.select().from(microLivePairFundingAttemptTable);
          const provisioning = await tx.select().from(microLivePairKeyProvisioningAttemptTable);
          const creation = await tx.select().from(microLiveSubaccountCreationAttemptTable);
          requireRepair(fee && fee.state === "approved" &&
            matches(fee, state.archive as typeof microLiveCommissioningArchiveTable.$inferSelect,
              state.original as typeof microLiveConfigTable.$inferSelect,
              boundary, { id: key.apiKeyId, fingerprint: key.fingerprint }),
          "existing_fee_archive_binding_mismatch");
          requireRepair(funding.length === 1 && funding[0].state === "reconciled" &&
            funding[0].sourceSubaccount === 0 && funding[0].destinationSubaccount === 1 &&
            funding[0].exchangeIndex === 2 && funding[0].amountCents === 2500 &&
            funding[0].transferId === boundary.fundingTransferId,
          "funding_attempt_mismatch");
          requireRepair(provisioning.length === 1 && provisioning[0].state === "handoff_confirmed" &&
            provisioning[0].subaccount === 1 && provisioning[0].exchangeIndex === 2 &&
            provisioning[0].keyId === key.apiKeyId && provisioning[0].confirmedAt &&
            provisioning[0].metadataVerifiedAt &&
            canonical(provisioning[0].scopes?.slice().sort()) === canonical(["read", "write::trade"]) &&
            creation.length === 1 && creation[0].state === "verified" &&
            creation[0].subaccountNumber === 1 && creation[0].targetExchangeIndex === 2 &&
            creation[0].verifiedAt && creation[0].attemptId === boundary.creationAttemptId &&
            creation[0].prePostInventoryDigest === boundary.creationInventoryDigest &&
            provisioning[0].creationAttemptId === creation[0].attemptId &&
            provisioning[0].cleanBoundaryEvidenceDigest === boundary.cleanBoundaryEvidenceDigest,
          "provisioning_or_creation_evidence_mismatch");
          const activity = await tx.execute(sql`SELECT
            (SELECT count(*) FROM micro_live_orders) AS orders,
            (SELECT count(*) FROM micro_live_fills) AS fills,
            (SELECT count(*) FROM micro_live_settlements) AS settlements,
            (SELECT count(*) FROM micro_live_decisions WHERE status IS DISTINCT FROM 'BLOCK') AS unexplained`);
          requireRepair(activity.rows.length === 1 &&
            Object.values(activity.rows[0]).every(value => Number(value) === 0), "local_activity_present");
          const anchor = fundingAnchorFromRow(boundary);
          requireRepair(anchor, "recorded_funding_anchor_invalid");
          const evidence = await readKalshiDedicatedPairEvidence(1, ticker, anchor, "index2");
          const reasons = historyReasons(evidence, true);
          const records = evidence.records ?? [];
          requireRepair(reasons.length === 0 &&
            evidence.balance.subaccountNumber === 1 && evidence.balance.exchangeIndex === 2 &&
            evidence.marketExchangeIndex === 2 && evidence.keyRestrictionVerified &&
            evidence.tradePermissionVerified && evidence.postAnchorCashDeltaMicros === "0" &&
            evidence.collateralSnapshot?.availableCashMicros === "25000000" &&
            evidence.collateralSnapshot?.inventoryBalanceMicros === "0" &&
            evidence.collateralSnapshot?.restingEntryReserveMicros === "0" &&
            ["positions", "orders", "fills", "settlements"]
              .every(name => Number((evidence.recordCounts as unknown as Row)[name]) === 0) &&
            records.every(record => record.feed === "subaccount_transfer" &&
              record.classification === "pair" && record.id === boundary.fundingTransferId &&
              transferIsExactFunding(record, 1)) &&
            records.filter(record => record.feed === "subaccount_transfer").length === 1,
          "authenticated_pair_activity_or_history_unproven");
          requireRepair(fee.pdfDigest, "approved_fee_digest_missing");
          // GET/parse only: do not call the durable fee-observation/approval writers.
          const official = await verifyCurrentFeeArtifact({ digest: fee.pdfDigest,
            policyVersion: STANDING_FEE_POLICY_VERSION,
            sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
            formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION });
          requireRepair(official.valid, "existing_fee_artifact_not_current");
          const checkedAt = new Date();
          const scanAt = new Date(evidence.scanFinishedAt);
          const startedAt = Date.parse(evidence.scanStartedAt);
          requireRepair(Number.isFinite(startedAt) && startedAt <= scanAt.getTime() &&
            checkedAt.getTime() - startedAt <= 15_000 &&
            scanAt.getTime() >= (boundary.postFundingSnapshotAt?.getTime() ?? Infinity),
          "authenticated_history_scan_stale");
          const checkpointDigest = evidence.checkpointDigest ?? digest({
            boundaryDigest: boundary.cleanBoundaryEvidenceDigest,
            fundingDigest: boundary.postFundingEvidenceDigest, records,
            scanStartedAt: evidence.scanStartedAt, scanFinishedAt: evidence.scanFinishedAt,
          });
          return { keyId: key.apiKeyId, fingerprint: key.fingerprint,
            cursor: evidence.scanFinishedAt, checkpointDigest, scanAt, checkedAt };
        };
        const write = async (plan: Plan, actor: string) => {
          await prove(txClient);
          const key = disposable ? disposable.keyIdentity() : configuredKey("index2");
          requireRepair(key?.apiKeyId === plan.proof.keyId &&
            key?.fingerprint === plan.proof.fingerprint &&
            Date.now() - plan.proof.scanAt.getTime() >= 0 &&
            Date.now() - plan.proof.scanAt.getTime() <= 15_000,
          "final_identity_or_freshness_changed");
          const before = plan.before as typeof microLiveConfigTable.$inferSelect;
          const after = plan.after as typeof microLiveConfigTable.$inferSelect;
          const date = (value: unknown) => value ? new Date(value as string | Date) : null;
          await tx.insert(microLiveRunArchiveTable).values({
            priorRunId: before.microLiveRunId!, successorRunId: after.microLiveRunId!,
            phase: "FROZEN", armedAt: date(before.microLiveRunArmedAt)!,
            deadlineAt: date(before.microLiveRunDeadline), approvalId: before.microLiveRunApprovalId!,
            approvalDigest: before.microLiveRunApprovalDigest!,
            approvalSourceUrl: before.microLiveFeeApprovalSourceUrl,
            approvalFormulaVersion: before.microLiveFeeFormulaVersion,
            approvalApprover: before.microLiveFeeApprovedBy,
            freezeReason: before.microLiveRunFreezeReason!, capMicros: before.microLiveRunCapMicros,
            reservedMicros: before.microLiveReservedMicros, entryAttempted: false, exitAttempted: false,
            accountMode: before.microLiveAccountMode!, selectedSubaccount: before.microLiveSelectedSubaccount!,
            selectedExchangeIndex: before.microLiveSelectedExchangeIndex,
            maxLiveBankrollCents: before.maxLiveBankrollCents,
            maxSingleOrderRiskCents: before.maxSingleOrderRiskCents,
            maxCumulativeReservedCents: before.maxCumulativeReservedCents,
            maxScoutStakeCents: before.maxScoutStakeCents,
            maxConfirmAdditionalStakeCents: before.maxConfirmAdditionalStakeCents,
            actorId: actor, transitionReason: REPAIR_REASON, archivedAt: plan.proof.checkedAt,
          });
          disposable?.fault?.("after_prior_archive");
          const result = await tx.update(microLiveConfigTable)
            .set(plan.patch as Partial<typeof microLiveConfigTable.$inferInsert>)
            .where(and(eq(microLiveConfigTable.id, "singleton"),
              eq(microLiveConfigTable.microLiveRunId, before.microLiveRunId!),
              eq(microLiveConfigTable.microLiveRunPhase, "FROZEN"),
              eq(microLiveConfigTable.manualKillSwitch, true),
              eq(microLiveConfigTable.liveExecutionEnabled, false),
              eq(microLiveConfigTable.microLiveProductionEnabled, false))).returning();
          requireRepair(result.length === 1 && canonical(result[0]) === canonical(plan.after),
            "singleton_update_interlock_failed");
          disposable?.fault?.("after_singleton");
          const bound = await tx.update(microLivePairBoundaryTable).set({
            state: "initialized", initializedRunId: after.microLiveRunId,
            initializedAt: plan.proof.checkedAt, activityCheckpointCursor: plan.proof.cursor,
            activityCheckpointAt: plan.proof.scanAt,
            activityCheckpointDigest: plan.proof.checkpointDigest, updatedAt: plan.proof.checkedAt,
          }).where(and(eq(microLivePairBoundaryTable.subaccountNumber, 1),
            eq(microLivePairBoundaryTable.exchangeIndex, 2),
            eq(microLivePairBoundaryTable.state, "funded"))).returning();
          requireRepair(bound.length === 1, "boundary_update_interlock_failed");
          disposable?.fault?.("after_boundary");
          await tx.insert(microLiveCommissioningArchiveTable).values({
            priorRunId: after.microLiveRunId!, phase: "FROZEN", capMicros: 1_000_000,
            snapshot: JSON.parse(JSON.stringify(result[0])),
            snapshotDigest: digest(result[0]), archivedBy: actor, archivedAt: plan.proof.checkedAt,
          });
          disposable?.fault?.("after_successor_archive");
          requireRepair(Date.now() - plan.proof.scanAt.getTime() <= 15_000,
            "commit_evidence_stale");
        };
        return body({ read, authenticate, write });
      }, { isolationLevel: "serializable", accessMode: apply ? "read write" : "read only" });
    },
  }, request);
}
