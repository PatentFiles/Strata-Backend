import assert from "node:assert/strict";
import test from "node:test";
import {
  frozenUnusedRunBlockReason,
  type FrozenUnusedRunSnapshot,
} from "./microLiveBoundedRunTransition";

const validSnapshot = (): FrozenUnusedRunSnapshot => ({
  phase: "FROZEN",
  runId: "frozen-one-dollar-run",
  requestedPriorRunId: "frozen-one-dollar-run",
  freezeReason: "operator_froze_unused_run_for_reviewed_transition",
  armedAt: new Date("2026-09-25T21:00:00.000Z"),
  approvalId: "original-approval",
  approvalDigest: "original-digest",
  capMicros: 1_000_000,
  reservedMicros: 0,
  entryAttempted: false,
  exitAttempted: false,
  accountMode: "primary_nonexclusive",
  selectedSubaccount: 0,
  accountingUnresolved: false,
  databaseMicroLiveEnabled: false,
  databaseExecutionEnabled: false,
  killSwitchOn: true,
  bindingMatches: true,
  orderCount: 0,
  fillCount: 0,
  settlementCount: 0,
});

test("a frozen unused run is explicitly archivable without an elapsed-time condition", () => {
  assert.equal(frozenUnusedRunBlockReason(validSnapshot()), null);
});

test("legacy expiry freeze reasons remain archivable after pristine-state checks", () => {
  assert.equal(frozenUnusedRunBlockReason({
    ...validSnapshot(), freezeReason: "entry_expired_without_proven_terminal_position",
  }), null);
});

function dedicatedSnapshot(subaccountNumber = 2): FrozenUnusedRunSnapshot {
  return {
    ...validSnapshot(),
    accountMode: "exclusive",
    selectedSubaccount: subaccountNumber,
    selectedExchangeIndex: 2,
    restrictedApiKeyId: "dedicated-key-id",
    restrictedKeyFingerprint: "a".repeat(64),
    fundingAnchor: {
      subaccountNumber,
      exchangeIndex: 2,
      transferId: "funding-transfer-id",
      transferAt: new Date("2026-09-26T10:00:00.000Z"),
      amountCents: 2500,
    },
    pairCashBaseline: {
      subaccountNumber,
      exchangeIndex: 2,
      runId: "frozen-one-dollar-run",
      availableCashMicros: "25000000",
      capturedAt: new Date("2026-09-26T10:00:01.000Z"),
      evidenceDigest: "b".repeat(64),
    },
    activityCheckpoint: {
      subaccountNumber,
      exchangeIndex: 2,
      runId: "frozen-one-dollar-run",
      cursor: "cursor-2-1",
      capturedAt: new Date("2026-09-26T10:00:02.000Z"),
      evidenceDigest: "c".repeat(64),
    },
  };
}

test("a frozen dedicated run archives only with a complete immutable (N,2) identity", () => {
  assert.equal(frozenUnusedRunBlockReason(dedicatedSnapshot()), null);
  assert.equal(frozenUnusedRunBlockReason(dedicatedSnapshot(37)), null);
  assert.equal(
    frozenUnusedRunBlockReason({ ...dedicatedSnapshot(), selectedExchangeIndex: 1 }),
    "account_mode_or_pair_changed",
  );
  assert.equal(
    frozenUnusedRunBlockReason({
      ...dedicatedSnapshot(),
      fundingAnchor: { ...dedicatedSnapshot().fundingAnchor!, subaccountNumber: 1 },
    }),
    "dedicated_pair_identity_unproven",
  );
  assert.equal(
    frozenUnusedRunBlockReason({
      ...dedicatedSnapshot(),
      pairCashBaseline: {
        ...dedicatedSnapshot().pairCashBaseline!,
        availableCashMicros: "24999999",
      },
    }),
    "dedicated_pair_identity_unproven",
  );
  assert.equal(
    frozenUnusedRunBlockReason({
      ...dedicatedSnapshot(),
      activityCheckpoint: {
        ...dedicatedSnapshot().activityCheckpoint!,
        exchangeIndex: 1,
      },
    }),
    "dedicated_pair_identity_unproven",
  );
  assert.equal(
    frozenUnusedRunBlockReason({
      ...dedicatedSnapshot(),
      restrictedKeyFingerprint: "not-a-digest",
    }),
    "dedicated_pair_identity_unproven",
  );
});

test("new-run transition preserves one-use claims and refuses any prior attempt or exposure", () => {
  for (const change of [
    { entryAttempted: true },
    { exitAttempted: true },
    { reservedMicros: 1 },
    { orderCount: 1 },
    { fillCount: 1 },
    { settlementCount: 1 },
  ] satisfies Partial<FrozenUnusedRunSnapshot>[]) {
    assert.equal(
      frozenUnusedRunBlockReason({ ...validSnapshot(), ...change }),
      change.entryAttempted ? "bounded_run_attempt_or_reservation_exists" :
        change.exitAttempted ? "bounded_run_attempt_or_reservation_exists" :
          change.reservedMicros ? "bounded_run_attempt_or_reservation_exists" :
            "bounded_run_ledger_not_empty",
    );
  }
});

test("archiving requires a freeze reason, frozen gates, and unchanged identity", () => {
  assert.equal(frozenUnusedRunBlockReason({
    ...validSnapshot(), freezeReason: null,
  }), "bounded_run_freeze_reason_missing");
  assert.equal(frozenUnusedRunBlockReason({
    ...validSnapshot(), databaseExecutionEnabled: true,
  }), "new_run_requires_frozen_database_gates");
  assert.equal(frozenUnusedRunBlockReason({
    ...validSnapshot(), requestedPriorRunId: "another-run",
  }), "bounded_run_identity_changed");
});