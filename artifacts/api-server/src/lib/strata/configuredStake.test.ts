import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTRY_POLICY_REVIEW_BLOCKER,
  entryPolicyRuntimeState,
  parseConfiguredStakeCents,
  stakeStatus,
  validateConfiguredStake,
  type StakeFacts,
} from "./configuredStake";

const clear: StakeFacts = {
  configuredStakeCents: 2500,
  revision: 3,
  approvedMaxEntryStakeCents: 500_000,
  availableCashCents: 2500,
  workerRunning: false,
  openPositionCount: 0,
  preparedIntentCount: 0,
  dispatchedIntentCount: 0,
  unknownIntentCount: 0,
  unresolvedOrderCount: 0,
};

test("integer stake within the approved maximum is editable while stopped", () => {
  assert.deepEqual(parseConfiguredStakeCents(2500), { ok: true, cents: 2500 });
  assert.deepEqual(parseConfiguredStakeCents("2500"), { ok: true, cents: 2500 });
  assert.equal(validateConfiguredStake(clear, 2500).ok, true);
  assert.equal(stakeStatus(clear).editable, true);
  assert.equal(stakeStatus(clear).revision, 3);
});

test("zero, negative, fractional, NaN, and overflow cents are rejected", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0", "-5", "1.5", "1e2", "", "9007199254740993"]) {
    assert.equal(parseConfiguredStakeCents(value).ok, false, String(value));
  }
  assert.equal(validateConfiguredStake(clear, 0).ok, false);
});

test("stake above the approved maximum is rejected", () => {
  const decision = validateConfiguredStake(clear, 500_001);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "above_approved_max_entry_stake");
  const ceiling: StakeFacts = { ...clear, approvedMaxEntryStakeCents: 2_500_000 };
  assert.equal(validateConfiguredStake(ceiling, 2_500_000).ok, true);
  const overCeiling = validateConfiguredStake(ceiling, 2_500_001);
  assert.equal(overCeiling.ok, false);
  if (!overCeiling.ok) assert.equal(overCeiling.reason, "above_approved_max_entry_stake");
  const aboveSmallerApproval = validateConfiguredStake(clear, 2_500_000);
  assert.equal(aboveSmallerApproval.ok, false);
});

test("stake cannot change while running, positioned, or an intent is unresolved", () => {
  const cases: Array<[Partial<StakeFacts>, string]> = [
    [{ workerRunning: true }, "worker_running"],
    [{ openPositionCount: 1 }, "open_production_position"],
    [{ preparedIntentCount: 1, unresolvedOrderCount: 1 }, "prepared_intent"],
    [{ dispatchedIntentCount: 1, unresolvedOrderCount: 1 }, "dispatched_intent"],
    [{ unknownIntentCount: 1, unresolvedOrderCount: 1 }, "unknown_intent"],
  ];
  for (const [patch, reason] of cases) {
    const decision = validateConfiguredStake({ ...clear, ...patch }, 100);
    assert.equal(decision.ok, false, reason);
    if (!decision.ok) assert.equal(decision.blockers[0], reason);
  }
});

test("entry policy review stays blocked unless the exact runtime marker is present", () => {
  const blocked = entryPolicyRuntimeState({});
  assert.equal(blocked.championId, "v13-champion-2-c52-confirm53");
  assert.equal(blocked.parameterHash, "314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161");
  assert.equal(blocked.entryPolicyVersion, "v13-first-qualifying-cross-v2");
  assert.equal(blocked.entryPolicyRuntimeApproved, false);
  assert.equal(blocked.entryPolicyLiveBlocked, true);
  assert.equal(blocked.entryPolicyBlockReason, ENTRY_POLICY_REVIEW_BLOCKER);
  const approved = entryPolicyRuntimeState({ V13_ENTRY_POLICY_RUNTIME_APPROVED: "v13-first-qualifying-cross-v2" });
  assert.equal(approved.entryPolicyRuntimeApproved, true);
  assert.equal(approved.entryPolicyBlockReason, null);
});
