import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  db, pool, liveExecutionConfigTable, microLiveConfigTable,
  microLivePairBoundaryTable, microLiveCommissioningArchiveTable,
  microLiveRunArchiveTable,
} from "@workspace/db";
import {
  canonical, digest, REPAIR_REASON, runCommissioningTransition,
  type Plan, type RepairPort, type Snapshot,
} from "./v13CommissioningTransition";

const historicalRun = "00000000-0000-4000-8000-000000000001";
const baseTime = new Date("2026-10-07T12:00:00.000Z");
const scanAt = new Date(baseTime.getTime() + 1_000);
const checkedAt = new Date(baseTime.getTime() + 2_000);
const keyId = "synthetic-index2-key";
const fingerprint = "b".repeat(64);
const checkpointDigest = "d".repeat(64);

const request = {
  apply: true,
  expectedRun: historicalRun,
  actor: "ci-commissioning-repair",
  ticker: "KXBTC15M-TEST",
  binding: { accountMode: "exclusive", subaccount: 1, exchangeIndex: 2 },
} as const;

async function proveDisposableDatabase() {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const result = await pool.query("select current_database() as database_name");
  assert.equal(result.rows[0]?.database_name, "v13_ci");
}

async function resetFixture() {
  await pool.query(`
    TRUNCATE TABLE
      micro_live_run_archive,
      micro_live_commissioning_archive,
      micro_live_pair_boundary,
      micro_live_decisions,
      micro_live_fills,
      micro_live_orders,
      micro_live_settlements,
      live_execution_config,
      micro_live_config
    RESTART IDENTITY CASCADE
  `);
}

async function seedFixture() {
  await db.insert(microLiveConfigTable).values({
    id: "singleton",
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
    maxLiveBankrollCents: 2500,
    maxSingleOrderRiskCents: 100,
    maxCumulativeReservedCents: 2500,
    maxScoutStakeCents: 100,
    maxConfirmAdditionalStakeCents: 100,
    microLiveRunCapMicros: 1_000_000,
    microLiveRunId: historicalRun,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveRunPhase: "FROZEN",
    microLiveRunArmedAt: baseTime,
    microLiveRunApprovalId: "historical-approval",
    microLiveRunApprovalDigest: "a".repeat(64),
    microLiveRunFreezeReason: "entry_expired_without_proven_terminal_position",
    microLiveAccountMode: "primary_nonexclusive",
    microLiveSelectedSubaccount: 0,
    microLiveSelectedExchangeIndex: null,
    microLiveAccountingUnresolved: false,
    microLiveReservedMicros: 0,
    createdAt: baseTime,
    updatedAt: baseTime,
  });
  await db.insert(liveExecutionConfigTable).values({
    id: "singleton",
    mode: "SHADOW_LIVE",
    liveExecutionEnabled: false,
    manualKillSwitch: true,
  });
  await db.insert(microLivePairBoundaryTable).values({
    subaccountNumber: 1,
    exchangeIndex: 2,
    restrictedApiKeyId: keyId,
    restrictedKeyFingerprint: fingerprint,
    cleanBalanceMicros: "0",
    cleanBalanceSemantics: "available_cash",
    cleanSnapshotAuthenticated: true,
    cleanOrderCount: 0,
    cleanFillCount: 0,
    cleanPositionCount: 0,
    cleanSettlementCount: 0,
    cleanBoundaryAt: new Date(baseTime.getTime() - 60_000),
    cleanBoundaryEvidenceDigest: "e".repeat(64),
    state: "funded",
    fundingTransferId: "synthetic-transfer",
    fundingAmountCents: 2500,
    fundingTransferredAt: baseTime,
    postFundingBalanceMicros: "25000000",
    postFundingBalanceSemantics: "available_cash",
    postFundingSnapshotAuthenticated: true,
    postFundingSnapshotAt: baseTime,
    postFundingEvidenceDigest: "c".repeat(64),
    createdAt: baseTime,
    updatedAt: baseTime,
  });
  const [original] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton"));
  assert.ok(original);
  const snapshot = JSON.parse(JSON.stringify(original));
  await db.insert(microLiveCommissioningArchiveTable).values({
    priorRunId: historicalRun,
    phase: "FROZEN",
    capMicros: 1_000_000,
    snapshot,
    snapshotDigest: digest(snapshot),
    archivedBy: "ci-fixture",
    archivedAt: baseTime,
  });
}

function postgresPort(options: { failAfterConfig?: boolean } = {}): RepairPort {
  return {
    async proveDevelopment() {
      await proveDisposableDatabase();
    },
    async transaction(apply, body) {
      return db.transaction(async tx => {
        if (apply) {
          await tx.execute(sql`LOCK TABLE micro_live_config, live_execution_config,
            micro_live_pair_boundary, micro_live_commissioning_archive, micro_live_run_archive,
            micro_live_orders, micro_live_fills, micro_live_settlements, micro_live_decisions
            IN SHARE ROW EXCLUSIVE MODE`);
        }
        const read = async (expectedRun: string): Promise<Snapshot> => {
          const [[config], [live], [boundary], [archive], [audit]] = await Promise.all([
            tx.select().from(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton")),
            tx.select().from(liveExecutionConfigTable).where(eq(liveExecutionConfigTable.id, "singleton")),
            tx.select().from(microLivePairBoundaryTable)
              .where(eq(microLivePairBoundaryTable.subaccountNumber, 1)),
            tx.select().from(microLiveCommissioningArchiveTable)
              .where(eq(microLiveCommissioningArchiveTable.priorRunId, expectedRun)),
            tx.select().from(microLiveRunArchiveTable)
              .where(eq(microLiveRunArchiveTable.priorRunId, expectedRun)),
          ]);
          assert.ok(config && live && boundary && archive);
          const [afterArchive] = await tx.select().from(microLiveCommissioningArchiveTable)
            .where(eq(microLiveCommissioningArchiveTable.priorRunId, config.microLiveRunId ?? ""));
          return {
            config, live, boundary, archive, audit, afterArchive,
            original: archive.snapshot,
          };
        };
        const authenticate = async () => ({
          keyId,
          fingerprint,
          cursor: "synthetic-checkpoint",
          checkpointDigest,
          scanAt,
          checkedAt,
        });
        const write = async (plan: Plan, actor: string) => {
          const before = plan.before as typeof microLiveConfigTable.$inferSelect;
          const afterState = plan.after as typeof microLiveConfigTable.$inferSelect;
          const date = (value: unknown) => value ? new Date(value as string | Date) : null;
          await tx.insert(microLiveRunArchiveTable).values({
            priorRunId: before.microLiveRunId!,
            successorRunId: afterState.microLiveRunId!,
            phase: "FROZEN",
            armedAt: date(before.microLiveRunArmedAt)!,
            deadlineAt: date(before.microLiveRunDeadline),
            approvalId: before.microLiveRunApprovalId!,
            approvalDigest: before.microLiveRunApprovalDigest!,
            approvalSourceUrl: before.microLiveFeeApprovalSourceUrl,
            approvalFormulaVersion: before.microLiveFeeFormulaVersion,
            approvalApprover: before.microLiveFeeApprovedBy,
            freezeReason: before.microLiveRunFreezeReason!,
            capMicros: before.microLiveRunCapMicros,
            reservedMicros: before.microLiveReservedMicros,
            entryAttempted: false,
            exitAttempted: false,
            accountMode: before.microLiveAccountMode!,
            selectedSubaccount: before.microLiveSelectedSubaccount!,
            selectedExchangeIndex: before.microLiveSelectedExchangeIndex,
            maxLiveBankrollCents: before.maxLiveBankrollCents,
            maxSingleOrderRiskCents: before.maxSingleOrderRiskCents,
            maxCumulativeReservedCents: before.maxCumulativeReservedCents,
            maxScoutStakeCents: before.maxScoutStakeCents,
            maxConfirmAdditionalStakeCents: before.maxConfirmAdditionalStakeCents,
            actorId: actor,
            transitionReason: REPAIR_REASON,
            archivedAt: plan.proof.checkedAt,
          });
          const updated = await tx.update(microLiveConfigTable)
            .set(plan.patch as Partial<typeof microLiveConfigTable.$inferInsert>)
            .where(and(
              eq(microLiveConfigTable.id, "singleton"),
              eq(microLiveConfigTable.microLiveRunId, before.microLiveRunId!),
              eq(microLiveConfigTable.microLiveRunPhase, "FROZEN"),
              eq(microLiveConfigTable.manualKillSwitch, true),
              eq(microLiveConfigTable.liveExecutionEnabled, false),
              eq(microLiveConfigTable.microLiveProductionEnabled, false),
            )).returning();
          assert.equal(updated.length, 1);
          assert.equal(canonical(updated[0]), canonical(plan.after));
          if (options.failAfterConfig) throw new Error("ci_forced_rollback");
          const bound = await tx.update(microLivePairBoundaryTable).set({
            state: "initialized",
            initializedRunId: afterState.microLiveRunId,
            initializedAt: plan.proof.checkedAt,
            activityCheckpointCursor: plan.proof.cursor,
            activityCheckpointAt: plan.proof.scanAt,
            activityCheckpointDigest: plan.proof.checkpointDigest,
            updatedAt: plan.proof.checkedAt,
          }).where(and(
            eq(microLivePairBoundaryTable.subaccountNumber, 1),
            eq(microLivePairBoundaryTable.exchangeIndex, 2),
            eq(microLivePairBoundaryTable.state, "funded"),
          )).returning();
          assert.equal(bound.length, 1);
          await tx.insert(microLiveCommissioningArchiveTable).values({
            priorRunId: afterState.microLiveRunId!,
            phase: "FROZEN",
            capMicros: 1_000_000,
            snapshot: JSON.parse(JSON.stringify(updated[0])),
            snapshotDigest: digest(updated[0]),
            archivedBy: actor,
            archivedAt: plan.proof.checkedAt,
          });
        };
        return body({ read, authenticate, write });
      }, { isolationLevel: "serializable", accessMode: apply ? "read write" : "read only" });
    },
  };
}

beforeEach(async () => {
  await proveDisposableDatabase();
  await resetFixture();
  await seedFixture();
});

after(async () => {
  await resetFixture();
  await pool.end();
});

test("real PostgreSQL transaction commits the dedicated linkage atomically", { concurrency: false }, async () => {
  const result = await runCommissioningTransition(postgresPort(), request);
  assert.equal(result.status, "reconciled");
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal(config?.microLiveAccountMode, "exclusive");
  assert.equal(config?.microLiveSelectedSubaccount, 1);
  assert.equal(config?.microLiveSelectedExchangeIndex, 2);
  assert.equal(config?.manualKillSwitch, true);
  assert.equal(config?.liveExecutionEnabled, false);
  assert.equal(config?.microLiveProductionEnabled, false);
  assert.equal(config?.microLiveFundingAnchorAmountCents, 2500);
  assert.equal(config?.microLivePairCashBaselineMicros, "25000000");
  assert.equal(config?.microLiveRestrictedKeyFingerprint, fingerprint);
  const audits = await db.select().from(microLiveRunArchiveTable);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.priorRunId, historicalRun);
  const [boundary] = await db.select().from(microLivePairBoundaryTable);
  assert.equal(boundary?.state, "initialized");
  assert.equal(boundary?.initializedRunId, config?.microLiveRunId);
  const archives = await db.select().from(microLiveCommissioningArchiveTable);
  assert.equal(archives.length, 2);
  assert.equal((await runCommissioningTransition(postgresPort(), request)).status, "already-reconciled");
  assert.equal((await db.select().from(microLiveRunArchiveTable)).length, 1);
});

test("real PostgreSQL transaction rolls every partial repair write back", { concurrency: false }, async () => {
  await assert.rejects(
    runCommissioningTransition(postgresPort({ failAfterConfig: true }), request),
    /ci_forced_rollback/,
  );
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal(config?.microLiveRunId, historicalRun);
  assert.equal(config?.microLiveAccountMode, "primary_nonexclusive");
  assert.equal(config?.microLiveSelectedSubaccount, 0);
  assert.equal(config?.microLiveSelectedExchangeIndex, null);
  assert.equal((await db.select().from(microLiveRunArchiveTable)).length, 0);
  assert.equal((await db.select().from(microLiveCommissioningArchiveTable)).length, 1);
  const [boundary] = await db.select().from(microLivePairBoundaryTable);
  assert.equal(boundary?.state, "funded");
  assert.equal(boundary?.initializedRunId, null);
});

test("PostgreSQL rejects partial dedicated binding that violates linkage constraints", { concurrency: false }, async () => {
  await assert.rejects(db.transaction(async tx => {
    await tx.update(microLiveConfigTable).set({
      microLiveAccountMode: "exclusive",
      microLiveSelectedSubaccount: 1,
      microLiveSelectedExchangeIndex: 2,
    }).where(eq(microLiveConfigTable.id, "singleton"));
  }));
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal(config?.microLiveAccountMode, "primary_nonexclusive");
  assert.equal(config?.microLiveSelectedSubaccount, 0);
  assert.equal(config?.microLiveSelectedExchangeIndex, null);
});
