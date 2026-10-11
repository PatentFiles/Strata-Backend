import { createHash } from "node:crypto";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
  V13_ENTRY_POLICY_VERSION, V13_LEGACY_ENTRY_POLICY,
} from "@workspace/v13-strategy";

export const V13_MAX_ENTRY_STAKE_CENTS = 2_500_000;

export type V13ApprovedLiveMoneyPolicy = {
  id: string;
  version: number;
  supersedesPolicyId: string | null;
  state: "DRAFT" | "APPROVED" | "REVOKED";
  strategyVersion: string;
  strategyParameterSetId: string;
  strategyParameterHash: string;
  entryPolicyVersion?: string | null;
  championSelectionReviewId: string | null;
  championSelectionEvidenceHash: string | null;
  championSelectedBy: string | null;
  championSelectedAt: Date | null;
  capitalLimitCents: number;
  maxEntryStakeCents: number;
  maxEntryAllInCents: number;
  maxOpenPositions: number;
  maxDailyLossCents: number;
  maxTotalLossCents: number;
  maxQuoteAgeMs: number;
  maxFeeEvidenceAgeMs: number;
  feePolicyVersion: string | null;
  feeSourceUrl: string | null;
  feeFormulaVersion: string | null;
  requireFullDepth: boolean;
  entryTimeInForce: string;
  entryLimitSource: string;
  policyHash: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
};

export type V13LiveMoneyRiskInput = {
  policy: V13ApprovedLiveMoneyPolicy;
  plannedGrossCents: number;
  reservedEntryFeeCents: number;
  reservedExitFeeCents: number;
  availableCashCents: number;
  capitalRemainingCents: number;
  openPositions: number;
  realizedDailyLossCents: number;
  realizedTotalLossCents: number;
  quoteAgeMs: number;
  feeEvidenceAgeMs: number;
  feePolicyVersion: string;
  feeSourceUrl: string;
  feeFormulaVersion: string;
  feeEvidenceFingerprint: string;
  fullDepthProven: boolean;
};

export type V13LiveMoneyRiskDecision =
  | { ok: true; plannedAllInCents: number }
  | { ok: false; reason: string };

export function computeV13LiveMoneyPolicyHash(
  policy: V13ApprovedLiveMoneyPolicy,
): string {
  const canonical = JSON.stringify({
    id: policy.id,
    version: policy.version,
    supersedesPolicyId: policy.supersedesPolicyId,
    state: policy.state,
    strategyVersion: policy.strategyVersion,
    strategyParameterSetId: policy.strategyParameterSetId,
    strategyParameterHash: policy.strategyParameterHash,
    // Preserve historical policy hashes byte-for-byte; v2 is explicitly bound.
    ...(policy.entryPolicyVersion == null ? {} : { entryPolicyVersion: policy.entryPolicyVersion }),
    championSelectionReviewId: policy.championSelectionReviewId,
    championSelectionEvidenceHash: policy.championSelectionEvidenceHash,
    championSelectedBy: policy.championSelectedBy,
    championSelectedAt: policy.championSelectedAt?.toISOString() ?? null,
    capitalLimitCents: policy.capitalLimitCents,
    maxEntryStakeCents: policy.maxEntryStakeCents,
    maxEntryAllInCents: policy.maxEntryAllInCents,
    maxOpenPositions: policy.maxOpenPositions,
    maxDailyLossCents: policy.maxDailyLossCents,
    maxTotalLossCents: policy.maxTotalLossCents,
    maxQuoteAgeMs: policy.maxQuoteAgeMs,
    maxFeeEvidenceAgeMs: policy.maxFeeEvidenceAgeMs,
    feePolicyVersion: policy.feePolicyVersion,
    feeSourceUrl: policy.feeSourceUrl,
    feeFormulaVersion: policy.feeFormulaVersion,
    requireFullDepth: policy.requireFullDepth,
    entryTimeInForce: policy.entryTimeInForce,
    entryLimitSource: policy.entryLimitSource,
    createdBy: policy.createdBy,
    approvedBy: policy.approvedBy,
    approvedAt: policy.approvedAt?.toISOString() ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Pure final risk gate for a production-sized V13 IOC entry.
 *
 * It authorizes no exchange mutation. Contract notional is capped at $25,000.
 * The separate all-in ceiling and capital checks include entry and reserved
 * exit fees so fees cannot silently push the authorized cash exposure higher.
 */
export function evaluateV13LiveMoneyRisk(
  input: V13LiveMoneyRiskInput,
): V13LiveMoneyRiskDecision {
  const p = input.policy;
  if (p.state !== "APPROVED" || p.strategyVersion !== "V1.3" ||
      (p.entryPolicyVersion != null && p.entryPolicyVersion !== V13_ENTRY_POLICY_VERSION &&
       p.entryPolicyVersion !== V13_LEGACY_ENTRY_POLICY) ||
      p.strategyParameterSetId !== V13_CHAMPION_PARAMETER_SET.id ||
      p.strategyParameterHash !== V13_CHAMPION_PARAMETER_HASH ||
      p.entryTimeInForce !== "IOC" ||
      p.entryLimitSource !== "SIGNAL_REFERENCE_OFFER" ||
      !p.requireFullDepth || !input.fullDepthProven ||
      !p.policyHash || !/^[0-9a-f]{64}$/.test(p.policyHash) ||
      !p.createdBy.trim() || !p.approvedBy?.trim() ||
      !p.feePolicyVersion?.trim() || !p.feeSourceUrl?.trim() ||
      !p.feeFormulaVersion?.trim() ||
      !p.championSelectionReviewId?.trim() ||
      !p.championSelectionEvidenceHash ||
      !/^[0-9a-f]{64}$/.test(p.championSelectionEvidenceHash) ||
      !p.championSelectedBy?.trim() ||
      !(p.championSelectedAt instanceof Date) ||
      !Number.isFinite(p.championSelectedAt.getTime()) ||
      !(p.approvedAt instanceof Date) || !Number.isFinite(p.approvedAt.getTime()) ||
      p.championSelectedAt.getTime() > p.approvedAt.getTime() ||
      p.policyHash !== computeV13LiveMoneyPolicyHash(p)) {
    return { ok: false, reason: "live_money_policy_not_approved_or_complete" };
  }

  const integers = [
    p.version, p.capitalLimitCents, p.maxEntryStakeCents, p.maxEntryAllInCents,
    p.maxOpenPositions, p.maxDailyLossCents, p.maxTotalLossCents,
    p.maxQuoteAgeMs, p.maxFeeEvidenceAgeMs,
    input.plannedGrossCents, input.reservedEntryFeeCents, input.reservedExitFeeCents,
    input.availableCashCents, input.capitalRemainingCents, input.openPositions,
    input.realizedDailyLossCents, input.realizedTotalLossCents, input.quoteAgeMs,
    input.feeEvidenceAgeMs,
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      p.version < 1 ||
      p.maxEntryStakeCents < 1 || p.maxEntryStakeCents > V13_MAX_ENTRY_STAKE_CENTS ||
      p.maxEntryAllInCents < p.maxEntryStakeCents ||
      p.maxEntryAllInCents > p.capitalLimitCents ||
      p.capitalLimitCents < p.maxEntryStakeCents ||
      p.maxOpenPositions !== 1 ||
      p.maxDailyLossCents < 1 || p.maxTotalLossCents < 1 ||
      p.maxDailyLossCents > p.capitalLimitCents ||
      p.maxTotalLossCents > p.capitalLimitCents ||
      p.maxQuoteAgeMs < 1 || p.maxQuoteAgeMs > 15_000 ||
      p.maxFeeEvidenceAgeMs < 1 || p.maxFeeEvidenceAgeMs > 15_000) {
    return { ok: false, reason: "live_money_policy_limits_invalid" };
  }
  if (input.quoteAgeMs > p.maxQuoteAgeMs) {
    return { ok: false, reason: "live_money_quote_stale" };
  }
  if (input.feeEvidenceAgeMs > p.maxFeeEvidenceAgeMs ||
      input.feePolicyVersion !== p.feePolicyVersion ||
      input.feeSourceUrl !== p.feeSourceUrl ||
      input.feeFormulaVersion !== p.feeFormulaVersion ||
      !input.feeEvidenceFingerprint.trim()) {
    return { ok: false, reason: "live_money_fee_evidence_stale_or_mismatched" };
  }
  if (input.openPositions >= p.maxOpenPositions) {
    return { ok: false, reason: "live_money_position_limit_reached" };
  }
  if (input.realizedDailyLossCents >= p.maxDailyLossCents ||
      input.realizedTotalLossCents >= p.maxTotalLossCents) {
    return { ok: false, reason: "live_money_loss_limit_reached" };
  }

  const plannedAllInCents =
    input.plannedGrossCents + input.reservedEntryFeeCents + input.reservedExitFeeCents;
  if (!Number.isSafeInteger(plannedAllInCents) ||
      input.plannedGrossCents < 1 ||
      input.plannedGrossCents > p.maxEntryStakeCents ||
      plannedAllInCents > p.maxEntryAllInCents ||
      plannedAllInCents > input.availableCashCents ||
      plannedAllInCents > input.capitalRemainingCents ||
      plannedAllInCents > p.capitalLimitCents) {
    return { ok: false, reason: "live_money_entry_exceeds_capital_or_stake_limit" };
  }
  return { ok: true, plannedAllInCents };
}
