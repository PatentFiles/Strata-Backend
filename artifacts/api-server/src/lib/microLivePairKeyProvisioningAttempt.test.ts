import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import {
  db, kalshiKeyProvisioningAttemptTable, liveExecutionConfigTable,
  microLiveConfigTable, microLivePairBoundaryTable,
  microLivePairKeyProvisioningAttemptTable,
  microLiveSubaccountCreationAttemptTable, pool,
} from "@workspace/db";
import {
  PAIR_KEY_NAME, PAIR_SCOPES, databasePairKeyAttemptStore as store,
} from "./microLivePairKeyProvisioningAttempt.js";

const creationAttemptId = randomUUID();
const creationInventoryDigest = "1".repeat(64);
const cleanBoundaryEvidenceDigest = "2".repeat(64);
const changedBoundaryEvidenceDigest = "3".repeat(64);
const historicalAttemptId = randomUUID();
const historicKeyName = "MICRO_LIVE_SUBACCOUNT_1";

const authorizationEnvironment = [
  "NODE_ENV",
  "REPLIT_DEPLOYMENT",
  "KALSHI_INDEX2_KEY_PROVISIONING_ENABLED",
  "KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED",
] as const;
const previousEnvironment = new Map(
  authorizationEnvironment.map((key) => [key, process.env[key]]),
);

after(async () => {
  for (const key of authorizationEnvironment) {
    const previous = previousEnvironment.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  await pool.end();
});

function authorizeProvisioning(): void {
  process.env.NODE_ENV = "development";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED = "true";
  process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED = "true";
}

async function seedFrozenPair() {
  const createdAt = new Date();
  const verifiedAt = new Date();
  const boundaryAt = new Date();

  await db.insert(microLiveConfigTable).values({
    id: "singleton",
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
    microLiveRunPhase: "FROZEN",
  });
  await db.insert(liveExecutionConfigTable).values({
    id: "singleton",
    mode: "SHADOW_LIVE",
    liveExecutionEnabled: false,
    manualKillSwitch: true,
  });
  await db.insert(microLiveSubaccountCreationAttemptTable).values({
    attemptId: creationAttemptId,
    targetExchangeIndex: 2,
    prePostInventoryDigest: creationInventoryDigest,
    prePostInventory: { before: [], after: [] },
    createdAt,
    state: "verified",
    attemptedAt: createdAt,
    responseReceivedAt: createdAt,
    verifiedAt,
    subaccountNumber: 1,
    responseStatus: 201,
  });
  await db.insert(microLivePairBoundaryTable).values({
    subaccountNumber: 1,
    exchangeIndex: 2,
    cleanBalanceMicros: "0",
    cleanBalanceSemantics: "available_cash",
    cleanSnapshotAuthenticated: true,
    cleanOrderCount: 0,
    cleanFillCount: 0,
    cleanPositionCount: 0,
    cleanSettlementCount: 0,
    cleanBoundaryAt: boundaryAt,
    cleanBoundaryEvidenceDigest,
    creationAttemptId,
    creationInventoryDigest,
    state: "CREATED_CLEAN",
  });
  await db.insert(kalshiKeyProvisioningAttemptTable).values({
    attemptId: historicalAttemptId,
    keyName: historicKeyName,
    subaccount: 1,
    scopes: [...PAIR_SCOPES],
    createdAt,
    state: "prepared",
  });
}

async function cleanupFixture(): Promise<void> {
  await db.delete(microLivePairKeyProvisioningAttemptTable);
  await db.delete(kalshiKeyProvisioningAttemptTable)
    .where(eq(kalshiKeyProvisioningAttemptTable.attemptId, historicalAttemptId));
  await db.delete(microLivePairBoundaryTable);
  await db.delete(microLiveSubaccountCreationAttemptTable);
  await db.delete(liveExecutionConfigTable);
  await db.delete(microLiveConfigTable);
}

async function historicalRow() {
  const [row] = await db.select().from(kalshiKeyProvisioningAttemptTable);
  assert.ok(row);
  return {
    attemptId: row.attemptId,
    keyName: row.keyName,
    state: row.state,
    recoveryConfirmedAt: row.recoveryConfirmedAt,
    recoveryReason: row.recoveryReason,
  };
}

test("pair key provisioning is one-shot and boundary/gate guarded", async (t) => {
  t.after(async () => {
    await cleanupFixture();
  });

  await seedFrozenPair();
  const historicalBefore = await historicalRow();

  await t.test("authorization and both kill switches are required", async () => {
    delete process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED;
    authorizeProvisioning();
    process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED = "false";
    assert.equal(await store.prepare(), null);
    authorizeProvisioning();

    await db.update(microLiveConfigTable).set({ manualKillSwitch: false });
    assert.equal(await store.prepare(), null);
    await db.update(microLiveConfigTable).set({ manualKillSwitch: true });

    await db.update(liveExecutionConfigTable).set({ manualKillSwitch: false });
    assert.equal(await store.prepare(), null);
    await db.update(liveExecutionConfigTable).set({ manualKillSwitch: true });
  });

  await t.test("a changed clean-boundary digest blocks the attempted latch", async () => {
    const attemptId = await store.prepare();
    assert.ok(attemptId);
    await db.update(microLivePairBoundaryTable)
      .set({ cleanBoundaryEvidenceDigest: changedBoundaryEvidenceDigest });
    assert.equal(await store.markAttempted(attemptId), false);
    assert.equal((await store.get())?.state, "prepared");
    assert.deepEqual(await historicalRow(), historicalBefore);
  });

  await cleanupFixture();
  await seedFrozenPair();
  const historicalBeforeRetry = await historicalRow();
  await t.test("uncertain attempt cannot be repeated and does not touch history", async () => {
    authorizeProvisioning();
    const attemptId = await store.prepare();
    assert.ok(attemptId);
    assert.equal((await store.get())?.state, "prepared");
    assert.equal(await store.prepare(), null);

    assert.equal(await store.markAttempted(attemptId), true);
    assert.equal(await store.markAttempted(attemptId), false);
    assert.equal((await store.get())?.state, "attempted");
    assert.equal(await store.markUncertain(attemptId), true);
    assert.equal(await store.markUncertain(attemptId), false);
    assert.equal(await store.markAttempted(attemptId), false);
    assert.equal(await store.markResponse(attemptId, "unexpected-key-id"), false);
    assert.equal(await store.prepare(), null);

    const row = await store.get();
    assert.equal(row?.state, "uncertain");
    assert.equal(row?.keyId, null);
    assert.deepEqual(await historicalRow(), historicalBeforeRetry);
  });
});

test("binding requires exact key/provenance, metadata verification, and handoff", async (t) => {
  await seedFrozenPair();
  t.after(async () => {
    await cleanupFixture();
  });
  authorizeProvisioning();

  const attemptId = await store.prepare();
  assert.ok(attemptId);
  assert.equal(await store.markAttempted(attemptId), true);
  assert.equal(await store.markResponse(attemptId, "pair-key-verified-001"), true);

  const provenance = {
    creationAttemptId,
    cleanBoundaryEvidenceDigest,
  };
  assert.equal(await store.bindingEligible(1, "pair-key-verified-001", provenance), false);

  assert.equal(await store.markMetadataVerified(attemptId), true);
  assert.equal(await store.bindingEligible(1, "pair-key-verified-001", provenance), false);
  assert.equal(await store.markConfirmed(attemptId), true);
  assert.equal(await store.bindingEligible(1, "pair-key-verified-001", provenance), true);

  assert.equal(await store.bindingEligible(1, "different-key-id", provenance), false);
  assert.equal(await store.bindingEligible(2, "pair-key-verified-001", provenance), false);
  assert.equal(await store.bindingEligible(1, "pair-key-verified-001", {
    ...provenance,
    creationAttemptId: randomUUID(),
  }), false);
  assert.equal(await store.bindingEligible(1, "pair-key-verified-001", {
    ...provenance,
    cleanBoundaryEvidenceDigest: changedBoundaryEvidenceDigest,
  }), false);
  assert.equal((await store.get())?.keyId, "pair-key-verified-001");
});

test("metadata verification may complete after handoff confirmation", async (t) => {
  await seedFrozenPair();
  t.after(async () => {
    await cleanupFixture();
  });
  authorizeProvisioning();

  const attemptId = await store.prepare();
  assert.ok(attemptId);
  assert.equal(await store.markAttempted(attemptId), true);
  assert.equal(await store.markResponse(attemptId, "pair-key-verified-002"), true);
  assert.equal(await store.markConfirmed(attemptId), true);
  assert.equal((await store.get())?.metadataVerifiedAt, null);
  assert.equal(await store.bindingEligible(1, "pair-key-verified-002", {
    creationAttemptId,
    cleanBoundaryEvidenceDigest,
  }), false);

  assert.equal(await store.markMetadataVerified(attemptId), true);
  assert.ok((await store.get())?.metadataVerifiedAt);
  assert.equal(await store.bindingEligible(1, "pair-key-verified-002", {
    creationAttemptId,
    cleanBoundaryEvidenceDigest,
  }), true);
  assert.equal(PAIR_KEY_NAME, "MICRO_LIVE_INDEX2_SUBACCOUNT_1");
});