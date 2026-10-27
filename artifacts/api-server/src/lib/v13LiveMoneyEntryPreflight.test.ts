import assert from "node:assert/strict";
import test from "node:test";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import { preflightV13LiveMoneyEntry } from "./v13LiveMoneyEntryPreflight";
import {
  computeV13LiveMoneyPolicyHash,
  type V13ApprovedLiveMoneyPolicy,
} from "./v13LiveMoneyRisk";

const policy = (): V13ApprovedLiveMoneyPolicy => {
  const p: V13ApprovedLiveMoneyPolicy = {
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
    maxEntryStakeCents: 500_000,
    maxEntryAllInCents: 510_000,
    maxOpenPositions: 1,
    maxDailyLossCents: 2_000_000,
    maxTotalLossCents: 2_000_000,
    maxQuoteAgeMs: 1_000,
    maxFeeEvidenceAgeMs: 15_000,
    feePolicyVersion: "standing-fee-policy-v1",
    feeSourceUrl: "https://fee-source.invalid/schedule",
    feeFormulaVersion: "quadratic-fee-v1",
    requireFullDepth: true,
    entryTimeInForce: "IOC",
    entryLimitSource: "SIGNAL_REFERENCE_OFFER",
    policyHash: null,
    createdBy: "operator",
    approvedBy: "operator",
    approvedAt: new Date("2026-10-07T03:00:00.000Z"),
  };
  p.policyHash = computeV13LiveMoneyPolicyHash(p);
  return p;
};

const nowMs = Date.parse("2026-10-07T03:10:00.000Z");

const base = () => ({
  policy: policy(),
  strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
  strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
  signal: "SCOUT" as const,
  direction: "UP" as const,
  referenceOffer: 0.50,
  bestAskDollars: "0.4800",
  askLevels: [
    { priceDollars: "0.4800", availableContracts: "2000" },
    { priceDollars: "0.4900", availableContracts: "3000" },
    { priceDollars: "0.5000", availableContracts: "5000" },
    { priceDollars: "0.5100", availableContracts: "100000" },
  ],
  quoteAgeMs: 250,
  nowMs,
  feeEvidence: {
    policyVersion: "standing-fee-policy-v1",
    sourceUrl: "https://fee-source.invalid/schedule",
    formulaVersion: "quadratic-fee-v1",
    fingerprint: "fee-evidence-fingerprint-001",
    verifiedAtMs: nowMs - 1_000,
    contracts: 10_000,
    limitPrice: 0.50,
    reservedEntryFeeCents: 4_000,
    reservedExitFeeCents: 5_000,
  },
  availableCashCents: 1_000_000,
  capitalRemainingCents: 2_000_000,
  openPositions: 0,
  realizedDailyLossCents: 0,
  realizedTotalLossCents: 0,
});

test("production preflight binds a full-depth 5000-dollar IOC to exact fee evidence", () => {
  const result = preflightV13LiveMoneyEntry(base());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.contracts, 10_000);
  assert.equal(result.plan.limitPrice, 0.50);
  assert.equal(result.plan.worstCaseGrossCents, 500_000);
  assert.equal(result.plannedAllInCents, 509_000);
  assert.equal(result.feeEvidenceFingerprint, "fee-evidence-fingerprint-001");
  assert.equal(result.policyHash, base().policy.policyHash);
  assert.equal(result.strategyParameterSetId, V13_CHAMPION_PARAMETER_SET.id);
  assert.equal(result.strategyParameterHash, V13_CHAMPION_PARAMETER_HASH);
});

test("preflight sizes down instead of forcing 5000 dollars through shallow depth", () => {
  const input = base();
  input.askLevels = [
    { priceDollars: "0.4800", availableContracts: "1000" },
    { priceDollars: "0.4900", availableContracts: "1000" },
    { priceDollars: "0.5100", availableContracts: "100000" },
  ];
  input.feeEvidence.contracts = 2_000;
  input.feeEvidence.limitPrice = 0.49;
  input.feeEvidence.reservedEntryFeeCents = 1_000;
  input.feeEvidence.reservedExitFeeCents = 1_500;
  const result = preflightV13LiveMoneyEntry(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.contracts, 2_000);
  assert.equal(result.plan.limitPrice, 0.49);
  assert.equal(result.plan.worstCaseGrossCents, 98_000);
  assert.ok(result.plannedAllInCents < 500_000);
});

test("approved $5 SCOUT executes 10 whole 46-cent contracts at $4.60 gross, not a $5 minimum", () => {
  const input = base();
  input.policy.maxEntryStakeCents = 500;
  input.policy.maxEntryAllInCents = 625;
  input.policy.capitalLimitCents = 2500;
  input.policy.maxDailyLossCents = 1000;
  input.policy.maxTotalLossCents = 1500;
  input.policy.policyHash = computeV13LiveMoneyPolicyHash(input.policy);
  input.referenceOffer = 0.46;
  input.bestAskDollars = "0.4600";
  input.askLevels = [{priceDollars:"0.4600",availableContracts:"10"}];
  input.availableCashCents = 2500;
  input.capitalRemainingCents = 2500;
  input.feeEvidence.contracts = 10;
  input.feeEvidence.limitPrice = 0.46;
  input.feeEvidence.reservedEntryFeeCents = 20;
  input.feeEvidence.reservedExitFeeCents = 20;
  const good = preflightV13LiveMoneyEntry({...input,configuredStakeCents:500});
  assert.equal(good.ok,true);
  if(!good.ok)return;
  assert.equal(good.plan.contracts,10);
  assert.equal(good.plan.worstCaseGrossCents,460);
  assert.equal(good.plannedAllInCents,500);
  assert.ok(good.plannedAllInCents<=625);
  // A legacy or tampered sub-$5 *configured* stake remains rejected.
  assert.deepEqual(preflightV13LiveMoneyEntry({...input,configuredStakeCents:150}),{
    ok:false,reason:"live_money_configured_stake_invalid",
  });
  // A fee-evidence mismatch must not become executable on the partial path.
  input.feeEvidence.contracts=11;
  assert.deepEqual(preflightV13LiveMoneyEntry({...input,configuredStakeCents:500}),{
    ok:false,reason:"live_money_fee_evidence_invalid_or_stale",
  });
});

test("fee quote for a different size or price cannot authorize the planned order", () => {
  const wrongCount = base();
  wrongCount.feeEvidence.contracts = 9_999;
  assert.deepEqual(preflightV13LiveMoneyEntry(wrongCount), {
    ok: false,
    reason: "live_money_fee_evidence_invalid_or_stale",
  });

  const wrongPrice = base();
  wrongPrice.feeEvidence.limitPrice = 0.49;
  assert.deepEqual(preflightV13LiveMoneyEntry(wrongPrice), {
    ok: false,
    reason: "live_money_fee_evidence_invalid_or_stale",
  });
});

test("stale or changed fee policy evidence fails closed", () => {
  const stale = base();
  stale.feeEvidence.verifiedAtMs = nowMs - stale.policy.maxFeeEvidenceAgeMs - 1;
  assert.deepEqual(preflightV13LiveMoneyEntry(stale), {
    ok: false,
    reason: "live_money_fee_evidence_invalid_or_stale",
  });

  const changed = base();
  changed.feeEvidence.formulaVersion = "different-formula";
  assert.deepEqual(preflightV13LiveMoneyEntry(changed), {
    ok: false,
    reason: "live_money_fee_evidence_invalid_or_stale",
  });
});

test("preflight refuses to chase asks above the persisted V13 offer", () => {
  const input = base();
  input.bestAskDollars = "0.5100";
  input.askLevels = [{ priceDollars: "0.5100", availableContracts: "100000" }];
  const result = preflightV13LiveMoneyEntry(input);
  assert.deepEqual(result, {
    ok: false,
    reason: "live_money_best_ask_above_signal_ceiling",
  });
});


test("production preflight rejects non-champion strategy parameter identity", () => {
  const wrongId = base();
  wrongId.strategyParameterSetId = "research-c50";
  assert.deepEqual(preflightV13LiveMoneyEntry(wrongId), {
    ok: false,
    reason: "live_money_strategy_identity_not_champion",
  });

  const wrongHash = base();
  wrongHash.strategyParameterHash = "0".repeat(64);
  assert.deepEqual(preflightV13LiveMoneyEntry(wrongHash), {
    ok: false,
    reason: "live_money_strategy_identity_not_champion",
  });
});
