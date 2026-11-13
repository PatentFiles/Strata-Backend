import assert from "node:assert/strict";
import test from "node:test";
import { V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { REVIEWED_RELEASE } from "./reviewedRelease";
import {
  DEPLOYED_SHA_RUNTIME_UNAVAILABLE,
  deployedGitSha,
} from "./deployedGitSha";
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
  assert.equal(approved.entryPolicyRuntimeDiagnosticReason, null);
});

test("undefined entry-policy runtime env is missing and does not approve", () => {
  const state = entryPolicyRuntimeState({});
  assert.equal(state.entryPolicyRuntimeApproved, false);
  assert.equal(state.entryPolicyLiveBlocked, true);
  assert.equal(state.entryPolicyBlockReason, ENTRY_POLICY_REVIEW_BLOCKER);
  assert.equal(state.entryPolicyRuntimeEnvName, "V13_ENTRY_POLICY_RUNTIME_APPROVED");
  assert.equal(state.entryPolicyRuntimeExpectedValue, V13_ENTRY_POLICY_VERSION);
  assert.equal(state.entryPolicyRuntimeConfiguredState, "MISSING");
  assert.equal(state.entryPolicyRuntimeConfiguredValue, null);
  assert.equal(state.entryPolicyRuntimeConfiguredLength, null);
  assert.equal(state.entryPolicyRuntimeHasLeadingOrTrailingWhitespace, false);
  assert.equal(state.entryPolicyRuntimeDiagnosticReason, "runtime_approval_env_missing");
});

test("exact entry-policy runtime value matches and approves", () => {
  const state = entryPolicyRuntimeState({
    V13_ENTRY_POLICY_RUNTIME_APPROVED: V13_ENTRY_POLICY_VERSION,
  });
  assert.equal(state.entryPolicyRuntimeApproved, true);
  assert.equal(state.entryPolicyLiveBlocked, false);
  assert.equal(state.entryPolicyBlockReason, null);
  assert.equal(state.entryPolicyRuntimeConfiguredState, "MATCH");
  assert.equal(state.entryPolicyRuntimeConfiguredValue, V13_ENTRY_POLICY_VERSION);
  assert.equal(state.entryPolicyRuntimeConfiguredLength, V13_ENTRY_POLICY_VERSION.length);
  assert.equal(state.entryPolicyRuntimeHasLeadingOrTrailingWhitespace, false);
  assert.equal(state.entryPolicyRuntimeDiagnosticReason, null);
});

test("wrong entry-policy runtime value mismatches without approving", () => {
  const wrong = "not-the-reviewed-v2";
  const state = entryPolicyRuntimeState({ V13_ENTRY_POLICY_RUNTIME_APPROVED: wrong });
  assert.equal(state.entryPolicyRuntimeApproved, false);
  assert.equal(state.entryPolicyLiveBlocked, true);
  assert.equal(state.entryPolicyBlockReason, ENTRY_POLICY_REVIEW_BLOCKER);
  assert.equal(state.entryPolicyRuntimeConfiguredState, "MISMATCH");
  assert.equal(state.entryPolicyRuntimeConfiguredValue, wrong);
  assert.equal(state.entryPolicyRuntimeConfiguredLength, wrong.length);
  assert.equal(state.entryPolicyRuntimeHasLeadingOrTrailingWhitespace, false);
  assert.equal(state.entryPolicyRuntimeDiagnosticReason, "runtime_approval_env_mismatch");
  const empty = entryPolicyRuntimeState({ V13_ENTRY_POLICY_RUNTIME_APPROVED: "" });
  assert.equal(empty.entryPolicyRuntimeConfiguredState, "MISMATCH");
  assert.equal(empty.entryPolicyRuntimeConfiguredValue, "");
  assert.equal(empty.entryPolicyRuntimeConfiguredLength, 0);
  assert.equal(empty.entryPolicyRuntimeDiagnosticReason, "runtime_approval_env_mismatch");
});

test("leading or trailing whitespace stays a mismatch and is not trimmed into approval", () => {
  for (const value of [
    ` ${V13_ENTRY_POLICY_VERSION}`,
    `${V13_ENTRY_POLICY_VERSION} `,
    ` ${V13_ENTRY_POLICY_VERSION} `,
    `"${V13_ENTRY_POLICY_VERSION}"`,
  ]) {
    const state = entryPolicyRuntimeState({ V13_ENTRY_POLICY_RUNTIME_APPROVED: value });
    assert.equal(state.entryPolicyRuntimeApproved, false, value);
    assert.equal(state.entryPolicyBlockReason, ENTRY_POLICY_REVIEW_BLOCKER, value);
    assert.equal(state.entryPolicyRuntimeConfiguredState, "MISMATCH", value);
    assert.equal(state.entryPolicyRuntimeConfiguredValue, value, value);
    assert.equal(state.entryPolicyRuntimeConfiguredLength, value.length, value);
    if (value === `"${V13_ENTRY_POLICY_VERSION}"`) {
      assert.equal(state.entryPolicyRuntimeHasLeadingOrTrailingWhitespace, false, value);
      assert.equal(state.entryPolicyRuntimeDiagnosticReason, "runtime_approval_env_mismatch", value);
    } else {
      assert.equal(state.entryPolicyRuntimeHasLeadingOrTrailingWhitespace, true, value);
      assert.equal(state.entryPolicyRuntimeDiagnosticReason, "runtime_approval_env_whitespace_mismatch", value);
    }
  }
  const paddedWrong = entryPolicyRuntimeState({ V13_ENTRY_POLICY_RUNTIME_APPROVED: " wrong " });
  assert.equal(paddedWrong.entryPolicyRuntimeApproved, false);
  assert.equal(paddedWrong.entryPolicyRuntimeDiagnosticReason, "runtime_approval_env_whitespace_mismatch");
});

test("deployed git sha reads only Railway's commit variable", () => {
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(deployedGitSha({}), DEPLOYED_SHA_RUNTIME_UNAVAILABLE);
  assert.notEqual(deployedGitSha({}), REVIEWED_RELEASE.commit);
  assert.equal(deployedGitSha({ RAILWAY_GIT_COMMIT_SHA: sha }), sha);
  assert.equal(deployedGitSha({ RAILWAY_GIT_COMMIT_SHA: ` ${sha}` }), DEPLOYED_SHA_RUNTIME_UNAVAILABLE);
  assert.equal(deployedGitSha({ RAILWAY_GIT_COMMIT_SHA: sha.slice(0, 7) }), DEPLOYED_SHA_RUNTIME_UNAVAILABLE);
});
