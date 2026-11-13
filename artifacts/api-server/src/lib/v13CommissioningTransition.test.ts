import assert from "node:assert/strict";
import test from "node:test";
import {
  canonical, digest, LINKAGE_FIELDS, REPAIR_REASON, runCommissioningTransition,
  parseRepairArguments,
  type RepairPort, type RepairRequest, type Row, type Snapshot,
} from "./v13CommissioningTransition";

const historical = "00000000-0000-4000-8000-000000000001";
const time = new Date("2026-10-07T12:00:00.000Z");
const request: RepairRequest = {
  apply: true, expectedRun: historical, actor: "offline-operator", ticker: "KXBTC15M-TEST",
  binding: { accountMode: "exclusive", subaccount: 1, exchangeIndex: 2 },
};

function fixture() {
  const original: Row = {
    id: "singleton", microLiveRunId: historical, microLiveRunPhase: "FROZEN",
    microLiveRunCapMicros: 1_000_000, microLiveAccountMode: "primary_nonexclusive",
    microLiveSelectedSubaccount: 0, microLiveSelectedExchangeIndex: null,
    microLiveRunFreezeReason: "entry_expired_without_proven_terminal_position",
    microLiveRunArmedAt: time, microLiveRunApprovalId: "historical-approval",
    microLiveRunApprovalDigest: "a".repeat(64),
    microLiveEntryAttempted: false, microLiveExitAttempted: false,
    microLiveReservedMicros: 0, microLiveAccountingUnresolved: false,
    manualKillSwitch: true, liveExecutionEnabled: false, microLiveProductionEnabled: false,
    maxLiveBankrollCents: 2500, maxSingleOrderRiskCents: 100,
    maxScoutStakeCents: 100, maxConfirmAdditionalStakeCents: 100,
    maxCumulativeReservedCents: 2500, updatedAt: time,
  };
  LINKAGE_FIELDS.forEach(field => { original[field] = null; });
  const state: Snapshot = {
    config: structuredClone(original), original,
    live: { manualKillSwitch: true, liveExecutionEnabled: false },
    boundary: {
      state: "funded", initializedRunId: null, subaccountNumber: 1, exchangeIndex: 2,
      restrictedApiKeyId: "synthetic-index2-key", restrictedKeyFingerprint: "b".repeat(64),
      fundingTransferId: "synthetic-transfer", fundingAmountCents: 2500,
      fundingTransferredAt: time, postFundingSnapshotAt: time,
      postFundingBalanceMicros: "25000000", postFundingEvidenceDigest: "c".repeat(64),
    },
    archive: { priorRunId: historical, snapshot: structuredClone(original),
      snapshotDigest: digest(original) },
  };
  let writes = 0;
  let refuseTarget = false;
  let activity = false;
  let stale = false;
  let failStage = 0;
  const port: RepairPort = {
    async proveDevelopment() { if (refuseTarget) throw new Error("unrecognized_database"); },
    async transaction(_apply, body) {
      // A disposable, in-memory atomic database. Nothing imports pg or app services.
      const checkpoint = structuredClone(state);
      const priorWrites = writes;
      try {
        return await body({
          async read() { return structuredClone(state); },
          async authenticate() {
            if (activity) throw new Error("local_activity_present");
            return { keyId: "synthetic-index2-key", fingerprint: "b".repeat(64),
              cursor: "synthetic-checkpoint", checkpointDigest: "d".repeat(64),
              scanAt: stale ? new Date(time.getTime() - 16_000) : time, checkedAt: time };
          },
          async write(plan, actor) {
            writes++;
            state.audit = { priorRunId: historical, successorRunId: plan.after.microLiveRunId,
              transitionReason: REPAIR_REASON, actor };
            if (failStage === 1) throw new Error("simulated_archive_insert_failure");
            state.config = structuredClone(plan.after);
            if (failStage === 2) throw new Error("simulated_singleton_update_failure");
            state.boundary.state = "initialized";
            state.boundary.initializedRunId = plan.after.microLiveRunId;
            state.boundary.activityCheckpointCursor = plan.proof.cursor;
            state.boundary.activityCheckpointDigest = plan.proof.checkpointDigest;
            state.boundary.activityCheckpointAt = plan.proof.scanAt;
            state.afterArchive = { priorRunId: plan.after.microLiveRunId,
              snapshot: structuredClone(plan.after), snapshotDigest: digest(plan.after) };
            if (failStage === 3) throw new Error("simulated_successor_audit_failure");
          },
        });
      } catch (error) {
        for (const key of Object.keys(state)) delete (state as unknown as Row)[key];
        Object.assign(state, checkpoint);
        writes = priorWrites;
        throw error;
      }
    },
  };
  return { state, port, writes: () => writes,
    wrongTarget: () => { refuseTarget = true; }, activity: () => { activity = true; },
    stale: () => { stale = true; }, fail: (stage: number) => { failStage = stage; } };
}

test("success populates all 17 fields and preserves history, flags, phase and risk limits", async () => {
  const f = fixture(); const oldArchive = canonical(f.state.archive);
  const result = await runCommissioningTransition(f.port, request);
  assert.equal(result.status, "reconciled"); assert.equal(f.writes(), 1);
  for (const field of LINKAGE_FIELDS) assert.notEqual(f.state.config[field], null);
  assert.equal(canonical(f.state.archive), oldArchive);
  assert.equal(f.state.config.microLiveRunPhase, "FROZEN");
  assert.equal(f.state.config.manualKillSwitch, true);
  assert.equal(f.state.config.liveExecutionEnabled, false);
  assert.equal(f.state.config.microLiveProductionEnabled, false);
  assert.equal(f.state.live.liveExecutionEnabled, false);
  for (const key of Object.keys(f.state.original).filter(key => key.startsWith("max")))
    assert.equal(f.state.config[key], f.state.original[key]);
  assert.equal(f.state.audit?.priorRunId, historical);
  assert.notEqual(f.state.config.microLiveRunId, historical);
  assert.equal(f.state.afterArchive?.snapshotDigest, digest(f.state.config));
});
test("wrong/production/unknown database proof refuses before mutation", async () => {
  const f = fixture(); f.wrongTarget();
  await assert.rejects(runCommissioningTransition(f.port, request), /unrecognized_database/);
  assert.equal(f.writes(), 0);
});
for (const binding of [
  { accountMode: "primary_nonexclusive", subaccount: 1, exchangeIndex: 2 },
  { accountMode: "exclusive", subaccount: 0, exchangeIndex: 2 },
  { accountMode: "exclusive", subaccount: 1, exchangeIndex: 0 },
]) test("wrong dedicated binding: " + JSON.stringify(binding), async () => {
  const f = fixture();
  await assert.rejects(runCommissioningTransition(f.port, { ...request, binding }), /dedicated_binding/);
  assert.equal(f.writes(), 0);
});
test("mismatched installed INDEX2 fingerprint refuses", async () => {
  const f = fixture(); f.state.boundary.restrictedKeyFingerprint = "e".repeat(64);
  await assert.rejects(runCommissioningTransition(f.port, request), /fingerprint_mismatch/);
});
test("inconsistent recorded funding amount refuses", async () => {
  const f = fixture(); f.state.boundary.fundingAmountCents = 2499;
  await assert.rejects(runCommissioningTransition(f.port, request), /funding_conflict/);
});
test("existing order/fill/settlement or unexplained activity refuses", async () => {
  const f = fixture(); f.activity();
  await assert.rejects(runCommissioningTransition(f.port, request), /activity_present/);
  assert.equal(f.writes(), 0);
});
test("partial prepopulation refuses without mutation", async () => {
  const f = fixture(); f.state.config.microLiveFundingAnchorTransferId = "conflicting-transfer";
  await assert.rejects(runCommissioningTransition(f.port, request), /prepopulation/);
});
test("legacy primary checkpoints cannot be silently cleared", async () => {
  const f = fixture();
  f.state.original.microLivePrimaryActivityCheckpointCursor = "historical-primary-proof";
  f.state.config.microLivePrimaryActivityCheckpointCursor = "historical-primary-proof";
  f.state.archive.snapshotDigest = digest(f.state.original);
  await assert.rejects(runCommissioningTransition(f.port, request), /historical_snapshot_required/);
  assert.equal(f.writes(), 0);
});
test("freshness failure refuses", async () => {
  const f = fixture(); f.stale();
  await assert.rejects(runCommissioningTransition(f.port, request), /fresh_authenticated/);
});
test("second apply is idempotent and leaves complete state unchanged", async () => {
  const f = fixture(); await runCommissioningTransition(f.port, request);
  const before = canonical(f.state);
  assert.equal((await runCommissioningTransition(f.port, request)).status, "already-reconciled");
  assert.equal(f.writes(), 1); assert.equal(canonical(f.state), before);
});
test("tampered successor/audit refuses", async () => {
  const f = fixture(); await runCommissioningTransition(f.port, request);
  f.state.config.microLiveRestrictedKeyFingerprint = "e".repeat(64);
  await assert.rejects(runCommissioningTransition(f.port, request), /audit_mismatch/);
});
for (const field of ["manualKillSwitch", "liveExecutionEnabled", "microLiveProductionEnabled"])
  test("unsafe execution gate refuses: " + field, async () => {
    const f = fixture(); f.state.config[field] = field !== "manualKillSwitch";
    await assert.rejects(runCommissioningTransition(f.port, request), /closed_unused/);
    assert.equal(f.writes(), 0);
  });
for (const stage of [1, 2, 3]) test("full transaction rollback at write stage " + stage, async () => {
  const f = fixture(); f.fail(stage); const before = canonical(f.state);
  await assert.rejects(runCommissioningTransition(f.port, request), /simulated_/);
  assert.equal(canonical(f.state), before); assert.equal(f.writes(), 0);
});
test("dry-run is redacted, complete and never writes", async () => {
  const f = fixture(); const before = canonical(f.state);
  const result = await runCommissioningTransition(f.port, { ...request, apply: false });
  assert.equal(result.status, "dry-run"); assert.equal(f.writes(), 0);
  assert.equal(canonical(f.state), before);
  const report = JSON.stringify(result);
  assert.ok(!report.includes("synthetic-index2-key") && !report.includes("synthetic-transfer"));
  for (const field of LINKAGE_FIELDS) assert.ok(report.includes(field));
});
test("CLI refuses missing, ambiguous and unknown command flags", () => {
  assert.throws(() => parseRepairArguments([]), /explicit_mode/);
  assert.throws(() => parseRepairArguments(["--dry-run", "--apply-development-commissioning"]), /explicit_mode/);
  assert.throws(() => parseRepairArguments(["--dry-run", "--force"]), /invalid_arguments/);
  assert.throws(() => parseRepairArguments(["--dry-run=false", "--apply-development-commissioning"]), /invalid_arguments/);
  assert.equal(parseRepairArguments(["--dry-run"]).apply, false);
});
