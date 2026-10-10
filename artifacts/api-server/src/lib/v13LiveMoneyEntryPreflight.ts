import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import {
  planV13IocEntry,
  type V13DepthLevel,
  type V13ExecutionDirection,
  type V13ExecutionSignal,
  type V13IocEntryPlan,
} from "./v13ExecutionPlanner";
import {
  evaluateV13LiveMoneyRisk,
  type V13ApprovedLiveMoneyPolicy,
} from "./v13LiveMoneyRisk";

export type V13VerifiedFeeEvidence = {
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
  fingerprint: string;
  verifiedAtMs: number;
  contracts: number;
  limitPrice: number;
  reservedEntryFeeCents: number;
  reservedExitFeeCents: number;
};

export type V13LiveMoneyEntryPreflightInput = {
  policy: V13ApprovedLiveMoneyPolicy;
  strategyParameterSetId: string;
  strategyParameterHash: string;
  signal: V13ExecutionSignal;
  direction: V13ExecutionDirection;
  referenceOffer: number;
  bestAskDollars: string | null;
  askLevels: V13DepthLevel[];
  quoteAgeMs: number;
  nowMs: number;
  feeEvidence: V13VerifiedFeeEvidence;
  availableCashCents: number;
  capitalRemainingCents: number;
  openPositions: number;
  realizedDailyLossCents: number;
  realizedTotalLossCents: number;
  /** Operator target. The approved policy maximum stays the hard ceiling. */
  configuredStakeCents?: number;
};

export type V13LiveMoneyEntryPreflightResult =
  | {
      ok: true;
      plan: V13IocEntryPlan;
      plannedAllInCents: number;
      policyHash: string;
      strategyParameterSetId: string;
      strategyParameterHash: string;
      feeEvidenceFingerprint: string;
    }
  | { ok: false; reason: string };

function exactPlanFeeEvidence(
  plan: V13IocEntryPlan,
  evidence: V13VerifiedFeeEvidence,
): boolean {
  return Number.isSafeInteger(evidence.contracts) &&
    evidence.contracts === plan.contracts &&
    Number.isFinite(evidence.limitPrice) &&
    Math.abs(evidence.limitPrice - plan.limitPrice) <= 0.0000001 &&
    Number.isSafeInteger(evidence.reservedEntryFeeCents) &&
    evidence.reservedEntryFeeCents >= 0 &&
    Number.isSafeInteger(evidence.reservedExitFeeCents) &&
    evidence.reservedExitFeeCents >= 0;
}

/**
 * Pure production entry preflight. This function never submits an order.
 *
 * A caller may mint a one-use exchange POST capability only after this returns
 * ok=true, and must bind that capability to the returned contract count,
 * limit price, champion strategy parameter ID/hash, policy hash and fee evidence fingerprint.
 */
export function preflightV13LiveMoneyEntry(
  input: V13LiveMoneyEntryPreflightInput,
): V13LiveMoneyEntryPreflightResult {
  if (
    input.strategyParameterSetId !== V13_CHAMPION_PARAMETER_SET.id ||
    input.strategyParameterHash !== V13_CHAMPION_PARAMETER_HASH ||
    input.policy.strategyParameterSetId !== input.strategyParameterSetId ||
    input.policy.strategyParameterHash !== input.strategyParameterHash
  ) {
    return { ok: false, reason: "live_money_strategy_identity_not_champion" };
  }
  const configured = input.configuredStakeCents;
  if (configured !== undefined && (
    !Number.isSafeInteger(configured) || configured < 1 ||
    configured > input.policy.maxEntryStakeCents
  )) {
    return { ok: false, reason: "live_money_configured_stake_invalid" };
  }
  const plan = planV13IocEntry({
    signal: input.signal,
    direction: input.direction,
    referenceOffer: input.referenceOffer,
    maxStakeCents: configured ?? input.policy.maxEntryStakeCents,
    bestAskDollars: input.bestAskDollars,
    askLevels: input.askLevels,
  });
  if (!plan.ok) {
    return { ok: false, reason: `live_money_${plan.reason}` };
  }

  const fees = input.feeEvidence;
  const feeAgeMs = input.nowMs - fees.verifiedAtMs;
  if (!fees.policyVersion.trim() || !fees.sourceUrl.trim() ||
      !fees.formulaVersion.trim() || fees.fingerprint.trim().length < 16 ||
      fees.policyVersion !== input.policy.feePolicyVersion ||
      fees.sourceUrl !== input.policy.feeSourceUrl ||
      fees.formulaVersion !== input.policy.feeFormulaVersion ||
      !Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(fees.verifiedAtMs) ||
      !Number.isSafeInteger(feeAgeMs) || feeAgeMs < 0 ||
      feeAgeMs > input.policy.maxFeeEvidenceAgeMs ||
      !exactPlanFeeEvidence(plan.plan, fees)) {
    return { ok: false, reason: "live_money_fee_evidence_invalid_or_stale" };
  }

  const risk = evaluateV13LiveMoneyRisk({
    policy: input.policy,
    plannedGrossCents: plan.plan.worstCaseGrossCents,
    reservedEntryFeeCents: fees.reservedEntryFeeCents,
    reservedExitFeeCents: fees.reservedExitFeeCents,
    availableCashCents: input.availableCashCents,
    capitalRemainingCents: input.capitalRemainingCents,
    openPositions: input.openPositions,
    realizedDailyLossCents: input.realizedDailyLossCents,
    realizedTotalLossCents: input.realizedTotalLossCents,
    quoteAgeMs: input.quoteAgeMs,
    feeEvidenceAgeMs: feeAgeMs,
    feePolicyVersion: fees.policyVersion,
    feeSourceUrl: fees.sourceUrl,
    feeFormulaVersion: fees.formulaVersion,
    feeEvidenceFingerprint: fees.fingerprint,
    fullDepthProven: true,
  });
  if (!risk.ok) return risk;
  if (configured !== undefined && plan.plan.worstCaseGrossCents > configured) {
    return { ok: false, reason: "live_money_configured_stake_exceeded" };
  }

  return {
    ok: true,
    plan: plan.plan,
    plannedAllInCents: risk.plannedAllInCents,
    policyHash: input.policy.policyHash!,
    strategyParameterSetId: input.strategyParameterSetId,
    strategyParameterHash: input.strategyParameterHash,
    feeEvidenceFingerprint: fees.fingerprint,
  };
}
