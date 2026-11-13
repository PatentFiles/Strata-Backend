import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import {
  db, liveExecutionConfigTable, microLiveCommissioningArchiveTable,
  microLiveConfigTable, microLivePairBoundaryTable,
  microLivePairFeeApprovalTable, microLivePairFundingAttemptTable, pool,
} from "@workspace/db";
import {
  preparePairCommissioningApproval, reviewPairCommissioningFeePdf,
} from "./microLivePairCommissioningApproval";

if (!/^micro_live_test_[a-f0-9]{24}$/.test(process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? ""))
  throw new Error("Commissioning tests require an isolated development schema");
const keys = [
  "NODE_ENV", "REPLIT_DEPLOYMENT", "KALSHI_API_ENVIRONMENT",
  "MICRO_LIVE_PRODUCTION_ENABLED", "LIVE_EXECUTION_ENABLED",
  "KALSHI_INDEX2_API_KEY_ID", "KALSHI_INDEX2_PRIVATE_KEY",
  "PHASE4_ADMIN_USER_ID",
] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
after(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await pool.end();
});

test("immutable FROZEN snapshot and pair-only $1 draft cannot create a run twice or change caps", async () => {
  Object.assign(process.env, {
    NODE_ENV: "development", REPLIT_DEPLOYMENT: "0",
    KALSHI_API_ENVIRONMENT: "production",
    MICRO_LIVE_PRODUCTION_ENABLED: "false", LIVE_EXECUTION_ENABLED: "false",
    KALSHI_INDEX2_API_KEY_ID: "isolated-index2-key",
    KALSHI_INDEX2_PRIVATE_KEY: "isolated-private-key",
    PHASE4_ADMIN_USER_ID: "isolated-owner",
  });
  const t = new Date();
  const digest = "a".repeat(64);
  const runId = randomUUID();
  const transferId = `isolated-funding-${randomUUID()}`;
  const fingerprint = createHash("sha256")
    .update("isolated-index2-key\u001fisolated-private-key").digest("hex");
  await db.insert(microLiveConfigTable).values({
    id: "singleton", microLiveRunId: runId, microLiveRunPhase: "FROZEN",
    microLiveRunCapMicros: 1_000_000, microLiveRunArmedAt: t,
    microLiveRunFreezeReason: "entry_expired_without_proven_terminal_position",
    microLiveRunApprovalId: randomUUID(), microLiveRunApprovalDigest: digest,
    microLiveAccountMode: "primary_nonexclusive", microLiveSelectedSubaccount: 0,
  });
  await db.insert(liveExecutionConfigTable).values({ id: "singleton" });
  await db.insert(microLivePairBoundaryTable).values({
    subaccountNumber: 1, exchangeIndex: 2, state: "funded",
    restrictedApiKeyId: "isolated-index2-key", restrictedKeyFingerprint: fingerprint,
    keyBoundAt: t, keyBindingEvidenceDigest: digest,
    creationAttemptId: randomUUID(), creationInventoryDigest: digest,
    cleanBalanceMicros: "0", cleanBalanceSemantics: "available_cash",
    cleanSnapshotAuthenticated: true, cleanOrderCount: 0,
    cleanFillCount: 0, cleanPositionCount: 0, cleanSettlementCount: 0,
    cleanBoundaryAt: t, cleanBoundaryEvidenceDigest: digest,
    fundingTransferId: transferId, fundingAmountCents: 2500,
    fundingTransferredAt: t, postFundingBalanceMicros: "25000000",
    postFundingBalanceSemantics: "available_cash", postFundingSnapshotAuthenticated: true,
    postFundingSnapshotAt: t, postFundingEvidenceDigest: digest,
  });
  await db.insert(microLivePairFundingAttemptTable).values({
    attemptId: randomUUID(), sourceSubaccount: 0, destinationSubaccount: 1,
    exchangeIndex: 2, amountCents: 2500, marketTicker: "KXBTC15M-ISOLATED",
    state: "reconciled", sourceScopedBeforeMicros: "50000000",
    sourceInventoryBeforeMicros: "50000000",
    cleanBoundaryDigest: digest, attemptedAt: t,
    responseReceivedAt: t, transferId, reconciledAt: t,
  });
  const before = await db.select().from(microLiveConfigTable);
  const verify = async (n: number, source?: "shared" | "index2") =>
    n === 1 && source === "index2";
  const prepared = await preparePairCommissioningApproval("isolated-owner", verify);
  assert.equal(prepared.status, "pending", prepared.reason);
  const [archive] = await db.select().from(microLiveCommissioningArchiveTable)
    .where(eq(microLiveCommissioningArchiveTable.priorRunId, runId));
  const [approval] = await db.select().from(microLivePairFeeApprovalTable);
  assert.equal(archive?.phase, "FROZEN");
  assert.equal(archive?.priorRunId, runId);
  assert.equal(approval?.state, "pending");
  assert.equal(approval?.allInCapMicros, 1_000_000);
  assert.equal(approval?.exchangeIndex, 2);
  assert.equal(approval?.restrictedKeyFingerprint, fingerprint);
  assert.equal(approval?.fundingTransferId, transferId);
  assert.ok(approval);
  await assert.rejects(db.insert(microLivePairFeeApprovalTable).values({
    ...approval, subaccountNumber: 2, allInCapMicros: 1_000_000,
  }));
  await assert.rejects(db.insert(microLivePairFeeApprovalTable).values({
    ...approval, subaccountNumber: 2, allInCapMicros: 5_000_000,
  }));
  assert.deepEqual(await db.select().from(microLiveConfigTable), before);
  assert.equal((await preparePairCommissioningApproval("isolated-owner", verify)).reason,
    "approval_previously_prepared");
  assert.equal((await db.select().from(microLiveCommissioningArchiveTable)).length, 1);
  assert.equal((await db.select().from(microLivePairFeeApprovalTable)).length, 1);
  const pdf = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  const expectedDigest = createHash("sha256").update(pdf).digest("hex");
  assert.equal((await reviewPairCommissioningFeePdf(
    pdf, "isolated-owner", "owner_attested_http_429_2026_09_27", false,
  )).reason, "owner_attestation_or_exact_pdf_invalid");
  assert.equal((await db.select().from(microLivePairFeeApprovalTable))[0]?.state, "pending");
  assert.equal((await reviewPairCommissioningFeePdf(
    pdf, "wrong-owner", "owner_attested_http_429_2026_09_27", true,
  )).reason, "owner_attestation_or_exact_pdf_invalid");
  let sourceFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    sourceFetches++;
    throw new Error("owner-attested review must not fetch the canonical PDF");
  }) as typeof fetch;
  let reviewed: Awaited<ReturnType<typeof reviewPairCommissioningFeePdf>>;
  try {
    reviewed = await reviewPairCommissioningFeePdf(
      pdf, "isolated-owner", "owner_attested_http_429_2026_09_27", true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sourceFetches, 0);
  assert.equal(reviewed.status, "reviewed", reviewed.reason);
  const [reviewedRow] = await db.select().from(microLivePairFeeApprovalTable);
  assert.equal(reviewedRow?.pdfDigest, expectedDigest);
  assert.equal(reviewedRow?.reviewSource, "owner_attested_http_429_2026_09_27");
  assert.equal(reviewedRow?.sourceAttestedBy, "isolated-owner");
  assert.ok(reviewedRow?.sourceAttestedAt);
  assert.equal(reviewedRow?.approvedAt, null);
  assert.deepEqual(await db.select().from(microLiveConfigTable), before);
  process.env.KALSHI_INDEX2_API_KEY_ID = "wrong-key";
  assert.equal((await preparePairCommissioningApproval("isolated-owner", verify)).status, "blocked");
  process.env.KALSHI_INDEX2_API_KEY_ID = "isolated-index2-key";
  await db.update(microLiveConfigTable).set({ liveExecutionEnabled: true })
    .where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal((await preparePairCommissioningApproval("isolated-owner", verify)).status, "blocked");
  const [after] = await db.select().from(microLivePairFeeApprovalTable);
  assert.equal(after?.state, "reviewed");
  assert.equal(after?.approvedAt, null);
});