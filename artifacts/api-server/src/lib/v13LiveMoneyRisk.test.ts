import assert from "node:assert/strict";
import test from "node:test";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import {
  computeV13LiveMoneyPolicyHash,
  evaluateV13LiveMoneyRisk,
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
    capitalLimitCents: 2_000_000,
    maxEntryStakeCents: V13_MAX_ENTRY_STAKE_CENTS,
    maxEntryAllInCents: 510_000,
    maxOpenPositions: 1,
    maxDailyLossCents: 100_000,
    maxTotalLossCents: 500_000,
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
  plannedGrossCents: 500_000,
  reservedEntryFeeCents: 4_000,
  reservedExitFeeCents: 5_000,
  availableCashCents: 1_000_000,
  capitalRemainingCents: 2_000_000,
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

test("approved policy permits a 5000-dollar stake only when fee-inclusive exposure fits", () => {
  assert.deepEqual(evaluateV13LiveMoneyRisk(baseInput()), {
    ok: true,
    plannedAllInCents: 509_000,
  });
});

test("one cent above 5000 dollars notional is rejected even if account cash is larger", () => {
  const input = baseInput();
  input.plannedGrossCents = 500_001;
  input.availableCashCents = 5_000_000;
  input.capitalRemainingCents = 5_000_000;
  assert.equal(evaluateV13LiveMoneyRisk(input).ok, false);
});

test("fees can block a 5000-dollar stake even when contract notional is within limit", () => {
  const input = baseInput();
  input.reservedExitFeeCents = 6_001;
  assert.deepEqual(evaluateV13LiveMoneyRisk(input), {
    ok: false,
    reason: "live_money_entry_exceeds_capital_or_stake_limit",
  });
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
