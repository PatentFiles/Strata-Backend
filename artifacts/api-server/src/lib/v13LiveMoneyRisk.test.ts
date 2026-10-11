import assert from "node:assert/strict";
import test from "node:test";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import {
  computeV13LiveMoneyPolicyHash,
  evaluateV13LiveMoneyRisk,
  remainingLossBudgetAllowsEntry,
  V13_MAX_ENTRY_STAKE_CENTS,
  type V13ApprovedLiveMoneyPolicy,
} from "./v13LiveMoneyRisk";

const FEE_POLICY = "micro-live-standing-fee-policy-v1";
const FEE_SOURCE = "https://kalshi.com/docs/kalshi-fee-schedule.pdf";
const FEE_FORMULA = "standard-quadratic-0.07-v1";

const approved = (): V13ApprovedLiveMoneyPolicy => {
  const policy: V13ApprovedLiveMoneyPolicy = {
    id: "v13-live-1",
    version: 1,
    supersedesPolicyId: null,
    state: "APPROVED",
    strategyVersion: "V1.3",
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    championSelectionReviewId: "final-champion-review-2026-10-07",
    championSelectionEvidenceHash: "a".repeat(64),
    championSelectedBy: "operator",
    championSelectedAt: new Date("2026-10-07T02:55:00.000Z"),
    capitalLimitCents: 3_000_000,
    maxEntryStakeCents: V13_MAX_ENTRY_STAKE_CENTS,
    maxEntryAllInCents: 2_509_000,
    maxOpenPositions: 1,
    maxDailyLossCents: 3_000_000,
    maxTotalLossCents: 3_000_000,
    maxQuoteAgeMs: 1_000,
    maxFeeEvidenceAgeMs: 1_000,
    feePolicyVersion: FEE_POLICY,
    feeSourceUrl: FEE_SOURCE,
    feeFormulaVersion: FEE_FORMULA,
    requireFullDepth: true,
    entryTimeInForce: "IOC",
    entryLimitSource: "SIGNAL_REFERENCE_OFFER",
    policyHash: null,
    createdBy: "operator",
    approvedBy: "operator",
    approvedAt: new Date("2026-10-07T03:00:00.000Z"),
  };
  policy.policyHash = computeV13LiveMoneyPolicyHash(policy);
  return policy;
};

const baseInput = () => ({
  policy: approved(),
  plannedGrossCents: 2_500_000,
  reservedEntryFeeCents: 4_000,
  reservedExitFeeCents: 5_000,
  availableCashCents: 3_000_000,
  capitalRemainingCents: 3_000_000,
  openPositions: 0,
  realizedDailyLossCents: 0,
  realizedTotalLossCents: 0,
  quoteAgeMs: 250,
  feeEvidenceAgeMs: 250,
  feePolicyVersion: FEE_POLICY,
  feeSourceUrl: FEE_SOURCE,
  feeFormulaVersion: FEE_FORMULA,
  feeEvidenceFingerprint: "verified-market-fee-evidence",
  fullDepthProven: true,
});

test("approved policy permits a 25000-dollar stake only when fee-inclusive exposure fits", () => {
  assert.equal(V13_MAX_ENTRY_STAKE_CENTS, 2_500_000);
  const decision = evaluateV13LiveMoneyRisk(baseInput());
  assert.deepEqual(decision, {
    ok: true,
    plannedAllInCents: 2_509_000,
  });
  assert.equal(Number.isSafeInteger(2_509_000), true);
});

test("one cent above 25000 dollars notional is rejected even if account cash is larger", () => {
  const input = baseInput();
  input.plannedGrossCents = 2_500_001;
  input.availableCashCents = 5_000_000;
  input.capitalRemainingCents = 5_000_000;
  assert.equal(evaluateV13LiveMoneyRisk(input).ok, false);
});

test("a policy stake above 25000 dollars is rejected", () => {
  const input = baseInput();
  input.policy.maxEntryStakeCents = 2_500_001;
  input.policy.maxEntryAllInCents = 2_600_000;
  input.policy.capitalLimitCents = 3_000_000;
  input.policy.policyHash = computeV13LiveMoneyPolicyHash(input.policy);
  assert.deepEqual(evaluateV13LiveMoneyRisk(input), {
    ok: false,
    reason: "live_money_policy_limits_invalid",
  });
});

test("fees can block a 25000-dollar stake even when contract notional is within limit", () => {
  const input = baseInput();
  input.reservedExitFeeCents = 5_001;
  assert.deepEqual(evaluateV13LiveMoneyRisk(input), {
    ok: false,
    reason: "live_money_entry_exceeds_capital_or_stake_limit",
  });
});

test("available cash, capital remaining, and capital limit still cap a 25000-dollar ceiling", () => {
  const shortCash = baseInput();
  shortCash.availableCashCents = 2_508_999;
  assert.deepEqual(evaluateV13LiveMoneyRisk(shortCash), {
    ok: false,
    reason: "live_money_entry_exceeds_capital_or_stake_limit",
  });

  const shortRemaining = baseInput();
  shortRemaining.capitalRemainingCents = 2_508_999;
  assert.equal(evaluateV13LiveMoneyRisk(shortRemaining).ok, false);

  const shortCapital = baseInput();
  shortCapital.policy.capitalLimitCents = 2_508_999;
  shortCapital.policy.maxEntryAllInCents = 2_508_999;
  shortCapital.policy.maxDailyLossCents = 2_508_999;
  shortCapital.policy.maxTotalLossCents = 2_508_999;
  shortCapital.policy.policyHash = computeV13LiveMoneyPolicyHash(shortCapital.policy);
  assert.equal(evaluateV13LiveMoneyRisk(shortCapital).ok, false);
});

function launchPolicy(): V13ApprovedLiveMoneyPolicy {
  const policy: V13ApprovedLiveMoneyPolicy = {
    ...approved(),
    capitalLimitCents: 15_000,
    maxEntryStakeCents: 150,
    maxEntryAllInCents: 200,
    maxOpenPositions: 1,
    maxDailyLossCents: 500,
    maxTotalLossCents: 1_500,
    maxQuoteAgeMs: 1_000,
    maxFeeEvidenceAgeMs: 1_000,
    policyHash: null,
  };
  policy.policyHash = computeV13LiveMoneyPolicyHash(policy);
  return policy;
}

function launchInput(plannedGrossCents: number, reservedEntryFeeCents: number, reservedExitFeeCents: number) {
  return {
    ...baseInput(),
    policy: launchPolicy(),
    plannedGrossCents,
    reservedEntryFeeCents,
    reservedExitFeeCents,
    availableCashCents: 15_000,
    capitalRemainingCents: 15_000,
    realizedDailyLossCents: 0,
    realizedTotalLossCents: 0,
    quoteAgeMs: 250,
    feeEvidenceAgeMs: 250,
  };
}

test("$150 launch all-in includes both fee reserves and rejects one cent over $2", () => {
  assert.equal(launchPolicy().maxOpenPositions, 1);
  assert.deepEqual(evaluateV13LiveMoneyRisk(launchInput(150, 24, 25)), { ok: true, plannedAllInCents: 199 });
  assert.deepEqual(evaluateV13LiveMoneyRisk(launchInput(150, 25, 25)), { ok: true, plannedAllInCents: 200 });
  assert.deepEqual(evaluateV13LiveMoneyRisk(launchInput(150, 25, 26)), {
    ok: false,
    reason: "live_money_entry_exceeds_capital_or_stake_limit",
  });
  assert.deepEqual(evaluateV13LiveMoneyRisk(launchInput(150, 51, 0)), {
    ok: false,
    reason: "live_money_entry_exceeds_capital_or_stake_limit",
  });
  assert.equal(evaluateV13LiveMoneyRisk(launchInput(151, 0, 0)).ok, false);
  const twoPositions = launchPolicy();
  twoPositions.maxOpenPositions = 2;
  twoPositions.policyHash = computeV13LiveMoneyPolicyHash(twoPositions);
  assert.equal(evaluateV13LiveMoneyRisk({ ...launchInput(150, 25, 25), policy: twoPositions }).ok, false);
});

test("$5 daily and $15 total remaining loss budgets block an entry that would exceed either", () => {
  const fit = launchInput(150, 25, 25);
  assert.deepEqual(evaluateV13LiveMoneyRisk(fit), { ok: true, plannedAllInCents: 200 });
  fit.realizedDailyLossCents = 300;
  assert.equal(evaluateV13LiveMoneyRisk(fit).ok, true);
  fit.realizedDailyLossCents = 301;
  assert.deepEqual(evaluateV13LiveMoneyRisk(fit), {
    ok: false,
    reason: "live_money_entry_exceeds_remaining_loss_budget",
  });
  fit.realizedDailyLossCents = 500;
  assert.equal(evaluateV13LiveMoneyRisk(fit).ok, false);
  assert.equal(remainingLossBudgetAllowsEntry(200, 500, 500, 1_500, 0), false);
  const total = launchInput(150, 25, 25);
  total.realizedTotalLossCents = 1_300;
  assert.equal(evaluateV13LiveMoneyRisk(total).ok, true);
  total.realizedTotalLossCents = 1_301;
  assert.deepEqual(evaluateV13LiveMoneyRisk(total), {
    ok: false,
    reason: "live_money_entry_exceeds_remaining_loss_budget",
  });
  assert.equal(remainingLossBudgetAllowsEntry(200, 500, 0, 1_500, 1_301), false);
  assert.equal(remainingLossBudgetAllowsEntry(200, 500, 300, 1_500, 1_300), true);
});

test("policy hash binds a non-null entry policy version and leaves null unbound", () => {
  const policy = approved();
  const unbound = computeV13LiveMoneyPolicyHash(policy);
  policy.entryPolicyVersion = null;
  assert.equal(computeV13LiveMoneyPolicyHash(policy), unbound);
  policy.entryPolicyVersion = "v13-first-qualifying-cross-v2";
  assert.notEqual(computeV13LiveMoneyPolicyHash(policy), unbound);
});

test("policy hash changes when an approved limit or fee identity changes", () => {
  const policy = approved();
  const original = policy.policyHash;
  policy.maxEntryAllInCents += 1;
  assert.notEqual(computeV13LiveMoneyPolicyHash(policy), original);
  assert.deepEqual(evaluateV13LiveMoneyRisk({ ...baseInput(), policy }), {
    ok: false,
    reason: "live_money_policy_not_approved_or_complete",
  });

  const feePolicy = approved();
  const feeOriginal = feePolicy.policyHash;
  feePolicy.feeFormulaVersion = "changed-formula";
  assert.notEqual(computeV13LiveMoneyPolicyHash(feePolicy), feeOriginal);

  const strategyPolicy = approved();
  const strategyOriginal = strategyPolicy.policyHash;
  strategyPolicy.strategyParameterHash = "0".repeat(64);
  assert.notEqual(computeV13LiveMoneyPolicyHash(strategyPolicy), strategyOriginal);
  assert.equal(evaluateV13LiveMoneyRisk({ ...baseInput(), policy: strategyPolicy }).ok, false);
});

test("missing or tampered final champion-selection evidence fails closed", () => {
  const missing = baseInput();
  missing.policy.championSelectionReviewId = null;
  missing.policy.policyHash = computeV13LiveMoneyPolicyHash(missing.policy);
  assert.deepEqual(evaluateV13LiveMoneyRisk(missing), {
    ok: false,
    reason: "live_money_policy_not_approved_or_complete",
  });

  const tampered = baseInput();
  tampered.policy.championSelectionEvidenceHash = "0".repeat(64);
  assert.notEqual(computeV13LiveMoneyPolicyHash(tampered.policy), tampered.policy.policyHash);
  assert.equal(evaluateV13LiveMoneyRisk(tampered).ok, false);

  const selectedAfterApproval = baseInput();
  selectedAfterApproval.policy.championSelectedAt =
    new Date(selectedAfterApproval.policy.approvedAt!.getTime() + 1);
  selectedAfterApproval.policy.policyHash =
    computeV13LiveMoneyPolicyHash(selectedAfterApproval.policy);
  assert.equal(evaluateV13LiveMoneyRisk(selectedAfterApproval).ok, false);
});

test("draft policy, stale quote, missing depth, existing position, and loss limits all fail closed", () => {
  const draft = baseInput();
  draft.policy.state = "DRAFT";
  draft.policy.policyHash = computeV13LiveMoneyPolicyHash(draft.policy);
  assert.equal(evaluateV13LiveMoneyRisk(draft).ok, false);

  const stale = baseInput();
  stale.quoteAgeMs = 1_001;
  assert.equal(evaluateV13LiveMoneyRisk(stale).ok, false);

  const noDepth = baseInput();
  noDepth.fullDepthProven = false;
  assert.equal(evaluateV13LiveMoneyRisk(noDepth).ok, false);

  const occupied = baseInput();
  occupied.openPositions = 1;
  assert.equal(evaluateV13LiveMoneyRisk(occupied).ok, false);

  const lossLimited = baseInput();
  lossLimited.realizedDailyLossCents = lossLimited.policy.maxDailyLossCents;
  assert.equal(evaluateV13LiveMoneyRisk(lossLimited).ok, false);
});

test("stale or mismatched fee evidence blocks before live entry", () => {
  const stale = baseInput();
  stale.feeEvidenceAgeMs = stale.policy.maxFeeEvidenceAgeMs + 1;
  assert.deepEqual(evaluateV13LiveMoneyRisk(stale), {
    ok: false,
    reason: "live_money_fee_evidence_stale_or_mismatched",
  });

  const wrongFormula = baseInput();
  wrongFormula.feeFormulaVersion = "different-formula";
  assert.equal(evaluateV13LiveMoneyRisk(wrongFormula).ok, false);

  const missingFingerprint = baseInput();
  missingFingerprint.feeEvidenceFingerprint = "";
  assert.equal(evaluateV13LiveMoneyRisk(missingFingerprint).ok, false);
});
