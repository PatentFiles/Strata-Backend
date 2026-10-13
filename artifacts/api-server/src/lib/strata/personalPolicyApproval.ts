import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import {
  computeV13LiveMoneyPolicyHash,
  V13_MAX_ENTRY_STAKE_CENTS,
  type V13ApprovedLiveMoneyPolicy,
} from "../v13LiveMoneyRisk";

export const APPROVE_OWNED_POLICY_CONFIRMATION = "APPROVE_OWNED_ACCOUNT_POLICY";

export interface OwnedPolicyLimits {
  capitalLimitCents: number;
  maxEntryStakeCents: number;
  maxEntryAllInCents: number;
  maxDailyLossCents: number;
  maxTotalLossCents: number;
  maxQuoteAgeMs: number;
  maxFeeEvidenceAgeMs: number;
}

export interface OwnedPolicyFeeEvidence {
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
}

export interface OwnedPolicyChampionEvidence {
  reviewId: string;
  evidenceHash: string;
  selectedBy: string;
  selectedAt: Date;
}

const APPROVE_SQL = `
  -- owned-policy:approve
  UPDATE v13_live_money_policy
  SET state = 'APPROVED',
      strategy_version = 'V1.3',
      strategy_parameter_set_id = $3,
      strategy_parameter_hash = $4,
      champion_selection_review_id = $5,
      champion_selection_evidence_hash = $6,
      champion_selected_by = $7,
      champion_selected_at = $8,
      capital_limit_cents = $9,
      max_entry_stake_cents = $10,
      max_entry_all_in_cents = $11,
      max_open_positions = 1,
      max_daily_loss_cents = $12,
      max_total_loss_cents = $13,
      max_quote_age_ms = $14,
      max_fee_evidence_age_ms = $15,
      fee_policy_version = $16,
      fee_source_url = $17,
      fee_formula_version = $18,
      require_full_depth = true,
      entry_time_in_force = 'IOC',
      entry_limit_source = 'SIGNAL_REFERENCE_OFFER',
      approved_by = $7,
      approved_at = $19,
      policy_hash = $20
  WHERE id = $1
    AND execution_account_id = $2
    AND execution_account_id IS NOT NULL
    AND created_by = $21
    AND state = 'DRAFT'
  RETURNING id
`;

const LINK_SQL = `
  -- owned-policy:link
  UPDATE v13_production_account
  SET policy_id = $1
  WHERE id = $2
    AND owner_user_id = $3::uuid
    AND owner_user_id IS NOT NULL
    AND policy_id IS NULL
  RETURNING id
`;

export function authorizeOwnedPolicy(input: {
  ownerUserId: string;
  executionAccountId: string;
  policyId: string;
  version: number;
  confirmation: unknown;
  limits: OwnedPolicyLimits | null;
  fee: OwnedPolicyFeeEvidence | null;
  champion: OwnedPolicyChampionEvidence | null;
  approvedAt: Date;
}): { ok: true; policy: V13ApprovedLiveMoneyPolicy } | { ok: false; reason: string } {
  if (input.confirmation !== APPROVE_OWNED_POLICY_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required" };
  }
  if (!input.ownerUserId || !input.executionAccountId || !input.policyId) {
    return { ok: false, reason: "policy_not_owned" };
  }
  if (!input.limits) return { ok: false, reason: "policy_limits_missing" };
  if (!input.fee?.policyVersion.trim() || !input.fee.sourceUrl.trim() || !input.fee.formulaVersion.trim()) {
    return { ok: false, reason: "fee_artifact_unverified" };
  }
  if (!input.champion || !/^[0-9a-f]{64}$/.test(input.champion.evidenceHash) ||
      !input.champion.reviewId.trim() || !input.champion.selectedBy.trim() ||
      !(input.champion.selectedAt instanceof Date) ||
      input.champion.selectedAt.getTime() > input.approvedAt.getTime()) {
    return { ok: false, reason: "champion_evidence_missing" };
  }
  const limits = input.limits;
  const integers = [
    limits.capitalLimitCents, limits.maxEntryStakeCents, limits.maxEntryAllInCents,
    limits.maxDailyLossCents, limits.maxTotalLossCents, limits.maxQuoteAgeMs, limits.maxFeeEvidenceAgeMs,
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    return { ok: false, reason: "policy_limits_invalid" };
  }
  if (limits.maxEntryStakeCents > V13_MAX_ENTRY_STAKE_CENTS ||
      limits.maxEntryStakeCents > limits.maxEntryAllInCents ||
      limits.maxEntryAllInCents > limits.capitalLimitCents ||
      limits.maxDailyLossCents > limits.capitalLimitCents ||
      limits.maxTotalLossCents > limits.capitalLimitCents ||
      limits.maxQuoteAgeMs > 15_000 || limits.maxFeeEvidenceAgeMs > 15_000) {
    return { ok: false, reason: "policy_limits_invalid" };
  }
  const policy: V13ApprovedLiveMoneyPolicy = {
    id: input.policyId,
    version: input.version,
    supersedesPolicyId: null,
    state: "APPROVED",
    strategyVersion: "V1.3",
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    championSelectionReviewId: input.champion.reviewId,
    championSelectionEvidenceHash: input.champion.evidenceHash,
    championSelectedBy: input.champion.selectedBy,
    championSelectedAt: input.champion.selectedAt,
    capitalLimitCents: limits.capitalLimitCents,
    maxEntryStakeCents: limits.maxEntryStakeCents,
    maxEntryAllInCents: limits.maxEntryAllInCents,
    maxOpenPositions: 1,
    maxDailyLossCents: limits.maxDailyLossCents,
    maxTotalLossCents: limits.maxTotalLossCents,
    maxQuoteAgeMs: limits.maxQuoteAgeMs,
    maxFeeEvidenceAgeMs: limits.maxFeeEvidenceAgeMs,
    feePolicyVersion: input.fee.policyVersion,
    feeSourceUrl: input.fee.sourceUrl,
    feeFormulaVersion: input.fee.formulaVersion,
    requireFullDepth: true,
    entryTimeInForce: "IOC",
    entryLimitSource: "SIGNAL_REFERENCE_OFFER",
    policyHash: null,
    createdBy: input.ownerUserId,
    approvedBy: input.champion.selectedBy,
    approvedAt: input.approvedAt,
  };
  policy.policyHash = computeV13LiveMoneyPolicyHash(policy);
  return { ok: true, policy };
}

export async function persistOwnedPolicyApproval(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> },
  input: {
    ownerUserId: string;
    executionAccountId: string;
    policy: V13ApprovedLiveMoneyPolicy;
  },
): Promise<{ ok: true; policyId: string } | { ok: false; reason: string }> {
  if (input.policy.state !== "APPROVED" || input.policy.policyHash !== computeV13LiveMoneyPolicyHash(input.policy)) {
    return { ok: false, reason: "policy_hash_mismatch" };
  }
  if (input.policy.createdBy !== input.ownerUserId) return { ok: false, reason: "policy_not_owned" };
  const approved = await db.query(APPROVE_SQL, [
    input.policy.id,
    input.executionAccountId,
    input.policy.strategyParameterSetId,
    input.policy.strategyParameterHash,
    input.policy.championSelectionReviewId,
    input.policy.championSelectionEvidenceHash,
    input.policy.championSelectedBy,
    input.policy.championSelectedAt?.toISOString() ?? null,
    input.policy.capitalLimitCents,
    input.policy.maxEntryStakeCents,
    input.policy.maxEntryAllInCents,
    input.policy.maxDailyLossCents,
    input.policy.maxTotalLossCents,
    input.policy.maxQuoteAgeMs,
    input.policy.maxFeeEvidenceAgeMs,
    input.policy.feePolicyVersion,
    input.policy.feeSourceUrl,
    input.policy.feeFormulaVersion,
    input.policy.approvedAt?.toISOString() ?? null,
    input.policy.policyHash,
    input.ownerUserId,
  ]);
  if ((approved.rowCount ?? approved.rows.length) !== 1) return { ok: false, reason: "policy_not_approved" };
  const linked = await db.query(LINK_SQL, [input.policy.id, input.executionAccountId, input.ownerUserId]);
  if ((linked.rowCount ?? linked.rows.length) !== 1) return { ok: false, reason: "policy_not_linked" };
  return { ok: true, policyId: input.policy.id };
}
