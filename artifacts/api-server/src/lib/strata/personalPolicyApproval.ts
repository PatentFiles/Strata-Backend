import { randomUUID } from "node:crypto";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
  V13_ENTRY_POLICY_VERSION,
} from "@workspace/v13-strategy";
import {
  CANONICAL_FEE_SCHEDULE_URL,
  STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  STANDING_FEE_POLICY_VERSION,
} from "../microLiveFeeArtifact";
import {
  computeV13LiveMoneyPolicyHash,
  V13_MAX_ENTRY_STAKE_CENTS,
  type V13ApprovedLiveMoneyPolicy,
} from "../v13LiveMoneyRisk";
import { REVIEWED_RELEASE } from "./reviewedRelease";
import { parseOwnerFeeSource } from "./ownerFeeSourceStage";

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
      entry_policy_version = $22,
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
    AND version = $23
    AND ($24::uuid IS NULL OR EXISTS (
      SELECT 1 FROM private.strata_fee_source_grants g
      JOIN private.strata_fee_source_owner_consents c
        ON c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id
      JOIN public.strata_fee_operator_release_candidates r
        ON r.release_id=g.release_id
      WHERE g.grant_id=$24::uuid AND g.owner_user_id=$21::uuid
        AND g.revoked_at IS NULL AND g.expires_at>now()
        AND c.revoked_at IS NULL
        AND c.confirmation='CONFIRM_OPERATOR_FEE_SOURCE_ONLY'
        AND r.revoked_at IS NULL AND r.expires_at>now()
        AND g.release_id=c.release_id AND r.content_sha256=g.reviewed_pdf_sha256
        AND g.policy_version=$16 AND g.policy_decision_sha256=
          'f8f7e0920168ab4601c59a3a9343e940d78dd974512c7ec97f7d052bf5fd685e'
        AND g.authorized_stages @> ARRAY['STEP_9']::text[]
        AND $17='strata-operator-attested://kxbtc15m/' || g.grant_id::text || '/' || g.release_id::text
    ))
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
    entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
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

type PolicyQuery = {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

export async function createOwnedPolicyDraft(
  db: PolicyQuery,
  input: { ownerUserId: string; executionAccountId: string; limits: OwnedPolicyLimits | null },
): Promise<{ ok: true; policyId: string; version: number } | { ok: false; reason: string }> {
  if (!input.limits) return { ok: false, reason: "policy_limits_missing" };
  const checked = authorizeOwnedPolicy({
    ownerUserId: input.ownerUserId,
    executionAccountId: input.executionAccountId,
    policyId: "draft-check",
    version: 1,
    confirmation: APPROVE_OWNED_POLICY_CONFIRMATION,
    limits: input.limits,
    fee: {
      policyVersion: STANDING_FEE_POLICY_VERSION,
      sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    },
    champion: {
      reviewId: REVIEWED_RELEASE.commit,
      evidenceHash: V13_CHAMPION_PARAMETER_HASH,
      selectedBy: input.ownerUserId,
      selectedAt: new Date(0),
    },
    approvedAt: new Date(),
  });
  if (!checked.ok) return checked;
  const linked = await db.query(
    `SELECT policy_id FROM v13_production_account
     WHERE id = $1 AND owner_user_id = $2::uuid AND owner_user_id IS NOT NULL`,
    [input.executionAccountId, input.ownerUserId],
  );
  if (linked.rows.length !== 1) return { ok: false, reason: "execution_account_missing" };
  if (linked.rows[0]?.policy_id) return { ok: false, reason: "policy_already_approved" };
  const existing = await db.query(
    `SELECT id, version FROM v13_live_money_policy
     WHERE execution_account_id = $1 AND created_by = $2 AND state = 'DRAFT'
     ORDER BY version DESC LIMIT 1`,
    [input.executionAccountId, input.ownerUserId],
  );
  const limits = input.limits;
  if (existing.rows.length === 1) {
    const updated = await db.query(
      `UPDATE v13_live_money_policy
       SET capital_limit_cents = $3, max_entry_stake_cents = $4, max_entry_all_in_cents = $5,
           max_daily_loss_cents = $6, max_total_loss_cents = $7, max_quote_age_ms = $8,
           max_fee_evidence_age_ms = $9
       WHERE id = $1 AND execution_account_id = $2 AND state = 'DRAFT' AND created_by = $10
       RETURNING id, version`,
      [
        existing.rows[0]?.id, input.executionAccountId, limits.capitalLimitCents, limits.maxEntryStakeCents,
        limits.maxEntryAllInCents, limits.maxDailyLossCents, limits.maxTotalLossCents,
        limits.maxQuoteAgeMs, limits.maxFeeEvidenceAgeMs, input.ownerUserId,
      ],
    );
    if (updated.rows.length !== 1) return { ok: false, reason: "policy_not_stored" };
    return { ok: true, policyId: String(updated.rows[0]?.id), version: Number(updated.rows[0]?.version) };
  }
  const versionRow = await db.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM v13_live_money_policy WHERE execution_account_id = $1`,
    [input.executionAccountId],
  );
  const version = Number(versionRow.rows[0]?.next_version);
  const id = randomUUID();
  const inserted = await db.query(
    `INSERT INTO v13_live_money_policy (
       id, version, state, execution_account_id, created_by,
       capital_limit_cents, max_entry_stake_cents, max_entry_all_in_cents,
       max_open_positions, max_daily_loss_cents, max_total_loss_cents,
       max_quote_age_ms, max_fee_evidence_age_ms
     ) VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,1,$8,$9,$10,$11)
     RETURNING id, version`,
    [
      id, version, input.executionAccountId, input.ownerUserId,
      limits.capitalLimitCents, limits.maxEntryStakeCents, limits.maxEntryAllInCents,
      limits.maxDailyLossCents, limits.maxTotalLossCents, limits.maxQuoteAgeMs, limits.maxFeeEvidenceAgeMs,
    ],
  );
  if (inserted.rows.length !== 1) return { ok: false, reason: "policy_not_stored" };
  return { ok: true, policyId: id, version };
}

export async function persistOwnedPolicyApproval(
  db: PolicyQuery & {
    transaction?<T>(work: (query: PolicyQuery["query"]) => Promise<T>): Promise<T>;
  },
  input: {
    ownerUserId: string;
    executionAccountId: string;
    policy: V13ApprovedLiveMoneyPolicy;
  },
): Promise<{ ok: true; policyId: string } | { ok: false; reason: string }> {
  if (input.policy.state !== "APPROVED" || input.policy.policyHash !== computeV13LiveMoneyPolicyHash(input.policy)) {
    return { ok: false, reason: "policy_hash_mismatch" };
  }
  if (input.policy.entryPolicyVersion !== V13_ENTRY_POLICY_VERSION) {
    return { ok: false, reason: "production_entry_policy_revision_not_approved" };
  }
  if (input.policy.createdBy !== input.ownerUserId) return { ok: false, reason: "policy_not_owned" };
  if (!db.transaction) return { ok: false, reason: "policy_approval_not_transactional" };
  try {
    return await db.transaction(async (query) => approveAndLink(query, input));
  } catch (error) {
    const reason = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "policy_not_approved";
    return { ok: false, reason };
  }
}

async function approveAndLink(
  query: PolicyQuery["query"],
  input: {
    ownerUserId: string;
    executionAccountId: string;
    policy: V13ApprovedLiveMoneyPolicy;
  },
): Promise<{ ok: true; policyId: string }> {
  const approved = await query(APPROVE_SQL, [
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
    input.policy.entryPolicyVersion,
    input.policy.version,
  ]);
  if ((approved.rowCount ?? approved.rows.length) !== 1) throw new Error("policy_not_approved");
  const linked = await query(LINK_SQL, [input.policy.id, input.executionAccountId, input.ownerUserId]);
  if ((linked.rowCount ?? linked.rows.length) !== 1) throw new Error("policy_not_linked");
  return { ok: true, policyId: input.policy.id };
}
