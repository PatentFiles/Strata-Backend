import assert from "node:assert/strict";
import test, { after } from "node:test";
import { db, pool, microLiveConfigTable, liveExecutionConfigTable, microLivePairBoundaryTable,
  microLiveCommissioningArchiveTable } from "@workspace/db";
import { repairDevelopmentCommissioning, type DisposableRepairProof } from "./v13CommissioningRepair";
import { canonical, digest, LINKAGE_FIELDS, type RepairRequest } from "./v13CommissioningTransition";

const url = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url && process.env.DATABASE_URL === url &&
  /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url));
after(() => pool.end());
const oldRun = "00000000-0000-4000-8000-000000000001";
const request: RepairRequest = { apply: true, expectedRun: oldRun, actor: "simulated-owner",
  ticker: "KXBTC15M-TEST", binding: { accountMode: "exclusive", subaccount: 1, exchangeIndex: 2 } };
async function fixture() {
  assert.equal((await pool.query("SHOW fsync")).rows[0].fsync, "on");
  assert.equal((await pool.query("SHOW synchronous_commit")).rows[0].synchronous_commit, "on");
  const actual = (await pool.query("SELECT current_database() db,host(inet_server_addr()) host")).rows[0];
  assert.match(actual.db, /^v13_disposable_\d+$/); assert.equal(actual.host, "127.0.0.1");
  await pool.query(`TRUNCATE micro_live_config,live_execution_config,micro_live_pair_boundary,
    micro_live_commissioning_archive,micro_live_run_archive,micro_live_orders,micro_live_fills,
    micro_live_settlements,micro_live_decisions CASCADE`);
  const now = new Date();
  const [config] = await db.insert(microLiveConfigTable).values({
    id: "singleton", microLiveRunId: oldRun, microLiveRunPhase: "FROZEN",
    microLiveRunCapMicros: 1_000_000, microLiveAccountMode: "primary_nonexclusive",
    microLiveSelectedSubaccount: 0, microLiveSelectedExchangeIndex: null,
    microLiveRunFreezeReason: "entry_expired_without_proven_terminal_position",
    microLiveRunArmedAt: now, microLiveRunApprovalId: "synthetic-prior-approval",
    microLiveRunApprovalDigest: "a".repeat(64), manualKillSwitch: true,
    liveExecutionEnabled: false, microLiveProductionEnabled: false,
  }).returning();
  await db.insert(liveExecutionConfigTable).values({ id: "singleton", manualKillSwitch: true, liveExecutionEnabled: false });
  await db.insert(microLivePairBoundaryTable).values({
    subaccountNumber: 1, exchangeIndex: 2, state: "funded",
    restrictedApiKeyId: "synthetic-index2-key", restrictedKeyFingerprint: "b".repeat(64),
    cleanBalanceMicros: "0", cleanBalanceSemantics: "available_cash", cleanSnapshotAuthenticated: true,
    cleanOrderCount: 0, cleanFillCount: 0, cleanPositionCount: 0, cleanSettlementCount: 0,
    cleanBoundaryAt: now, cleanBoundaryEvidenceDigest: "c".repeat(64),
    fundingTransferId: "synthetic-transfer", fundingAmountCents: 2500, fundingTransferredAt: now,
    postFundingBalanceMicros: "25000000", postFundingBalanceSemantics: "available_cash",
    postFundingSnapshotAuthenticated: true, postFundingSnapshotAt: now, postFundingEvidenceDigest: "d".repeat(64),
  });
  await db.insert(microLiveCommissioningArchiveTable).values({ priorRunId: oldRun, phase: "FROZEN",
    capMicros: 1_000_000, snapshot: JSON.parse(JSON.stringify(config)), snapshotDigest: digest(config),
    archivedBy: "simulated-prior-owner", archivedAt: now });
  const proof: DisposableRepairProof = {
    keyIdentity: () => ({ apiKeyId: "synthetic-index2-key", fingerprint: "b".repeat(64) }),
    authenticate: async () => {
    const time = new Date();
    return { keyId: "synthetic-index2-key", fingerprint: "b".repeat(64),
      cursor: "synthetic-cursor", checkpointDigest: "e".repeat(64), scanAt: time, checkedAt: time };
  } };
  return { proof };
}
async function snapshot() {
  const tables = ["micro_live_config", "live_execution_config", "micro_live_pair_boundary",
    "micro_live_commissioning_archive", "micro_live_run_archive"] as const;
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return canonical(result);
}
test("real Drizzle serializable adapter populates exactly 17 linkages; frozen flags, limits and historical archive survive", async () => {
  const f = await fixture();
  const before = (await db.select().from(microLiveConfigTable))[0]!;
  const old = (await pool.query("SELECT * FROM micro_live_commissioning_archive WHERE prior_run_id=$1", [oldRun])).rows[0];
  const result = await repairDevelopmentCommissioning(request, f.proof);
  assert.equal(result.status, "reconciled");
  const afterConfig = (await db.select().from(microLiveConfigTable))[0]!;
  for (const key of LINKAGE_FIELDS) assert.ok(afterConfig[key] !== null && afterConfig[key] !== undefined);
  for (const key of ["manualKillSwitch", "liveExecutionEnabled", "microLiveProductionEnabled",
    "microLiveRunPhase", "microLiveRunCapMicros", "maxLiveBankrollCents", "maxSingleOrderRiskCents",
    "maxScoutStakeCents", "maxConfirmAdditionalStakeCents", "maxCumulativeReservedCents"] as const)
    assert.equal(afterConfig[key], before[key]);
  assert.equal(canonical((await pool.query("SELECT * FROM micro_live_commissioning_archive WHERE prior_run_id=$1", [oldRun])).rows[0]), canonical(old));
  const saved = await snapshot();
  assert.equal((await repairDevelopmentCommissioning(request, f.proof)).status, "already-reconciled");
  assert.equal(await snapshot(), saved);
});
test("real PostgreSQL rollback at every actual write stage preserves singleton, boundary and both archives exactly", async () => {
  for (const stage of ["after_prior_archive", "after_singleton", "after_boundary", "after_successor_archive"]) {
    const f = await fixture(), before = await snapshot();
    f.proof.fault = at => { if (at === stage) throw new Error(`crash_${stage}`); };
    await assert.rejects(repairDevelopmentCommissioning(request, f.proof), /crash_/);
    assert.equal(await snapshot(), before);
  }
});
test("dry-run is a read-only transaction and fresh authenticated failure never writes", async () => {
  const f = await fixture(), before = await snapshot();
  assert.equal((await repairDevelopmentCommissioning({ ...request, apply: false }, f.proof)).status, "dry-run");
  assert.equal(await snapshot(), before);
  f.proof.authenticate = async () => { throw new Error("simulated_signed_history_incomplete"); };
  await assert.rejects(repairDevelopmentCommissioning(request, f.proof), /history_incomplete/);
  assert.equal(await snapshot(), before);
});
test("real database constraints reject partial boundary initialization and incomplete funding writes", async () => {
  await fixture(); const before = await snapshot();
  await assert.rejects(pool.query("UPDATE micro_live_pair_boundary SET initialized_run_id='partial'"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE micro_live_pair_boundary SET funding_transfer_id=NULL"), { code: "23514" });
  assert.equal(await snapshot(), before);
});
test("parallel repair attempts serialize: one successor commits and no duplicate archive can commit", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => repairDevelopmentCommissioning(request, f.proof)));
  assert.ok(results.some(r => r.status === "fulfilled" && r.value.status === "reconciled"));
  assert.equal((await pool.query("SELECT count(*) FROM micro_live_run_archive")).rows[0].count, "1");
  assert.equal((await pool.query("SELECT count(*) FROM micro_live_commissioning_archive")).rows[0].count, "2");
  assert.equal((await repairDevelopmentCommissioning(request, f.proof)).status, "already-reconciled");
});
test("test seam cannot bypass runtime context or final key identity/freshness checks", async () => {
  const f = await fixture(), before = await snapshot();
  const env = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    await assert.rejects(repairDevelopmentCommissioning(request, f.proof), /explicit_disposable_context_required/);
  } finally { process.env.NODE_ENV = env; }
  assert.equal(await snapshot(), before);
  f.proof.keyIdentity = () => ({ apiKeyId: "changed", fingerprint: "b".repeat(64) });
  await assert.rejects(repairDevelopmentCommissioning(request, f.proof), /final_identity_or_freshness_changed/);
  assert.equal(await snapshot(), before);
});
