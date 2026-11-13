import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, microLiveFeeVerificationTable, pool } from "@workspace/db";
import {
  beginFeeVerification, finishFeeVerification, getFeeVerificationState,
  lockFeeVerificationForPost,
  type FeeVerificationIdentity,
} from "./microLiveFeeVerification";

if (!/^micro_live_test_[a-f0-9]{24}$/.test(
  process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "",
)) {
  throw new Error("Fee verification gate tests require a disposable isolated schema");
}

after(async () => {
  await pool.end();
});

function identity(): FeeVerificationIdentity {
  return {
    approvalId: randomUUID(),
    approvalDigest: "a".repeat(64),
    policyVersion: "micro-live-standing-fee-policy-v1",
    sourceUrl: "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
    formulaVersion: "standard-quadratic-0.07-v1",
  };
}

async function verifyRuntimeEvidence(
  approval: FeeVerificationIdentity,
  checkedAt = new Date(),
  fingerprint = `live-metadata|${approval.approvalId}|${approval.approvalDigest}`,
) {
  const attempt = await beginFeeVerification(approval);
  assert.ok(attempt);
  assert.equal(await finishFeeVerification(
    approval, attempt, "verified", null, fingerprint, checkedAt,
  ), true);
  return { checkedAt, fingerprint };
}

test("a crash with a committed pending gate stays blocked across restart reads", async () => {
  const approval = identity();
  const attempt = await beginFeeVerification(approval);
  assert.ok(attempt);
  // A new reader, representing a restarted process, observes the durable row.
  assert.deepEqual(await getFeeVerificationState(approval), {
    status: "pending", attemptId: attempt, reason: null, checkedAt: null,
    feeEvidenceFingerprint: null,
  });
  assert.equal(await beginFeeVerification(approval), null,
    "pending state is never auto-cleared by a restart or another successful attempt");
  assert.equal(await finishFeeVerification(approval, attempt, "verified", null,
    `live-metadata|${approval.approvalId}`, new Date()), true);
});

test("a definitive invalidation survives later good data and cannot be re-opened", async () => {
  const approval = identity();
  const attempt = await beginFeeVerification(approval);
  assert.ok(attempt);
  assert.equal(await finishFeeVerification(approval, attempt, "invalid",
    "unsupported_fee_type"), true);
  assert.equal((await getFeeVerificationState(approval))?.status, "invalid");
  assert.equal(await finishFeeVerification(approval, attempt, "verified", null), false);
  assert.equal(await beginFeeVerification(approval), null,
    "later good metadata cannot clear a definitive invalidation");
  assert.equal(await db.select().from(microLiveFeeVerificationTable)
    .where(eq(microLiveFeeVerificationTable.approvalId, approval.approvalId))
    .then((rows) => rows[0]?.status), "invalid");
});

test("PDF 429 is durably unavailable but preserves the approved identity", async () => {
  const approval = identity();
  const attempt = await beginFeeVerification(approval);
  assert.ok(attempt);
  assert.equal(await finishFeeVerification(approval, attempt, "unavailable",
    "official_fee_schedule_http_429"), true);
  const state = await getFeeVerificationState(approval);
  assert.equal(state?.status, "unavailable");
  assert.equal(state?.reason, "official_fee_schedule_http_429");
  assert.equal((await db.select().from(microLiveFeeVerificationTable)
    .where(eq(microLiveFeeVerificationTable.approvalId, approval.approvalId)))[0]?.approvalDigest,
  approval.approvalDigest);
  assert.ok(await beginFeeVerification(approval),
    "unavailable evidence may be retried without replacing the approved identity");
});

test("stale or mismatched writers cannot finish another identity's attempt", async () => {
  const approval = identity();
  const attempt = await beginFeeVerification(approval);
  assert.ok(attempt);
  assert.equal(await finishFeeVerification({
    ...approval, approvalDigest: "b".repeat(64),
  }, attempt, "invalid", "wrong_identity"), false);
  assert.equal(await finishFeeVerification(approval, "stale-attempt", "invalid",
    "stale_writer"), false);
  assert.equal((await getFeeVerificationState(approval))?.status, "pending");
  assert.equal(await finishFeeVerification(approval, attempt, "verified", null,
    `live-metadata|${approval.approvalId}`, new Date()), true);
});

test("concurrent verifier starts yield exactly one live attempt", async () => {
  const approval = identity();
  const starts = await Promise.all(Array.from({ length: 8 }, () =>
    beginFeeVerification(approval)));
  const active = starts.filter((attempt): attempt is string => attempt !== null);
  assert.equal(active.length, 1);
  assert.equal((await getFeeVerificationState(approval))?.attemptId, active[0]);
  assert.equal(await finishFeeVerification(approval, active[0]!, "verified", null,
    `live-metadata|${approval.approvalId}`, new Date()), true);
});

test("only exact, fresh metadata evidence holds the final POST lock", async () => {
  const approval = identity();
  const checkedAt = new Date();
  const { fingerprint } = await verifyRuntimeEvidence(approval, checkedAt);
  const now = checkedAt.getTime() + 2_000;
  const allowed = await db.transaction((tx) =>
    lockFeeVerificationForPost(tx, approval, fingerprint, checkedAt, now));
  assert.equal(allowed, true);

  for (const [expectedFingerprint, expectedAt, requestNow] of [
    ["other-live-evidence", checkedAt, now],
    [fingerprint, new Date(checkedAt.getTime() - 1), now],
    [fingerprint, checkedAt, checkedAt.getTime() - 1],
    [fingerprint, checkedAt, checkedAt.getTime() + 15_001],
  ] as const) {
    assert.equal(await db.transaction((tx) =>
      lockFeeVerificationForPost(tx, approval, expectedFingerprint, expectedAt, requestNow)),
    false);
  }
  assert.equal(await db.transaction((tx) => lockFeeVerificationForPost(
    tx, { ...approval, sourceUrl: `${approval.sourceUrl}/wrong` },
    fingerprint, checkedAt, now,
  )), false);
});

test("missing, pending, unavailable, and invalid evidence never permit POST", async () => {
  const absent = identity();
  assert.equal(await db.transaction((tx) => lockFeeVerificationForPost(
    tx, absent, "missing", new Date(), Date.now(),
  )), false);

  for (const status of ["pending", "unavailable", "invalid"] as const) {
    const approval = identity();
    const attempt = await beginFeeVerification(approval);
    assert.ok(attempt);
    if (status !== "pending") {
      assert.equal(await finishFeeVerification(
        approval, attempt, status, `test_${status}`, null, new Date(),
      ), true);
    }
    assert.equal(await db.transaction((tx) => lockFeeVerificationForPost(
      tx, approval, "any-fingerprint", new Date(), Date.now(),
    )), false, `${status} must block`);
  }
});

test("verified status cannot be stored without usable checked_at and evidence fingerprint", async () => {
  const approval = identity();
  await assert.rejects(db.insert(microLiveFeeVerificationTable).values({
    ...approval, status: "verified", attemptId: null, reason: null,
    checkedAt: null, feeEvidenceFingerprint: null,
  }));
  assert.equal(await finishFeeVerification(
    approval, "unstarted", "verified", null, null, null,
  ), false);
  const attempt = await beginFeeVerification(approval);
  assert.ok(attempt);
  assert.equal(await finishFeeVerification(
    approval, attempt, "verified", null, "   ", new Date(),
  ), false);
});