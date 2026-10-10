import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Standalone MICRO_LIVE risk and execution gates. Monetary values are integer
 * cents; these settings intentionally do not share fields with shadow config.
 */
export const microLiveConfigTable = pgTable("micro_live_config", {
  id: text("id").primaryKey().default("singleton"),
  microLiveProductionEnabled: boolean("micro_live_production_enabled").notNull().default(false),
  liveExecutionEnabled: boolean("live_execution_enabled").notNull().default(false),
  manualKillSwitch: boolean("manual_kill_switch").notNull().default(true),
  maxLiveBankrollCents: integer("max_live_bankroll_cents").notNull().default(2500),
  maxSingleOrderRiskCents: integer("max_single_order_risk_cents").notNull().default(500),
  maxOpenPositions: integer("max_open_positions").notNull().default(1),
  maxCumulativeReservedCents: integer("max_cumulative_reserved_cents").notNull().default(2500),
  maxScoutStakeCents: integer("max_scout_stake_cents").notNull().default(250),
  maxConfirmAdditionalStakeCents: integer("max_confirm_additional_stake_cents").notNull().default(250),
  microLiveRunCapMicros: integer("micro_live_run_cap_micros").notNull().default(1000000),
  microLiveRunId: text("micro_live_run_id"),
  microLiveEntryAttempted: boolean("micro_live_entry_attempted").notNull().default(false),
  microLiveExitAttempted: boolean("micro_live_exit_attempted").notNull().default(false),
  microLiveRunPhase: text("micro_live_run_phase").notNull().default("UNARMED"),
  microLiveRunArmedAt: timestamp("micro_live_run_armed_at", { withTimezone: true }),
  microLiveRunDeadline: timestamp("micro_live_run_deadline", { withTimezone: true }),
  microLiveRunApprovalId: text("micro_live_run_approval_id"),
  microLiveRunApprovalDigest: text("micro_live_run_approval_digest"),
  microLiveRunFreezeReason: text("micro_live_run_freeze_reason"),
  microLiveFeeApprovalId: text("micro_live_fee_approval_id"),
  microLiveFeeApprovalDigest: text("micro_live_fee_approval_digest"),
  microLiveFeeApprovalApproved: boolean("micro_live_fee_approval_approved").notNull().default(false),
  microLiveFeeApprovalInvalidated: boolean("micro_live_fee_approval_invalidated").notNull().default(false),
  microLiveFeeApprovalApprovedAt: timestamp("micro_live_fee_approval_approved_at", { withTimezone: true }),
  microLiveFeePolicyVersion: text("micro_live_fee_policy_version"),
  microLiveFeeApprovalSourceUrl: text("micro_live_fee_approval_source_url"),
  microLiveFeeFormulaVersion: text("micro_live_fee_formula_version"),
  microLiveFeeMaximumExposureMicros: integer("micro_live_fee_maximum_exposure_micros"),
  microLiveFeeApprovedBy: text("micro_live_fee_approved_by"),
  microLiveFeeApprovedRunCapMicros: integer("micro_live_fee_approved_run_cap_micros"),
  microLiveFeeArtifactStatus: text("micro_live_fee_artifact_status").notNull().default("unverified"),
  microLiveFeeArtifactCheckedAt: timestamp("micro_live_fee_artifact_checked_at", { withTimezone: true }),
  microLiveFeeArtifactReason: text("micro_live_fee_artifact_reason"),
  microLiveAccountMode: text("micro_live_account_mode"),
  microLiveSelectedSubaccount: integer("micro_live_selected_subaccount"),
  // Dedicated shard-2 binding is intentionally nullable. Existing exclusive
  // runs have no shard proof and must not be silently reinterpreted as (N, 2).
  microLiveSelectedExchangeIndex: integer("micro_live_selected_exchange_index"),
  microLiveRestrictedApiKeyId: text("micro_live_restricted_api_key_id"),
  microLiveRestrictedKeyFingerprint: text("micro_live_restricted_key_fingerprint"),
  microLiveAccountingUnresolved: boolean("micro_live_accounting_unresolved").notNull().default(false),
  microLiveAccountingUnresolvedReason: text("micro_live_accounting_unresolved_reason"),
  // Durable cash anchor for primary_nonexclusive/subaccount 0. Store exact
  // integer micros as text to avoid SQL/JS floating-point coercion.
  microLivePrimaryCashBaselineMicros: text("micro_live_primary_cash_baseline_micros"),
  microLivePrimaryCashBaselineRunId: text("micro_live_primary_cash_baseline_run_id"),
  microLivePrimaryCashBaselineAt: timestamp("micro_live_primary_cash_baseline_at", { withTimezone: true }),
  microLivePrimaryCashBaselineEvidenceDigest: text("micro_live_primary_cash_baseline_evidence_digest"),
  // Pair-bound funding anchor for a dedicated exchange-shard account.
  microLiveFundingAnchorSubaccount: integer("micro_live_funding_anchor_subaccount"),
  microLiveFundingAnchorExchangeIndex: integer("micro_live_funding_anchor_exchange_index"),
  microLiveFundingAnchorTransferId: text("micro_live_funding_anchor_transfer_id"),
  microLiveFundingAnchorTransferAt: timestamp("micro_live_funding_anchor_transfer_at", { withTimezone: true }),
  microLiveFundingAnchorAmountCents: integer("micro_live_funding_anchor_amount_cents"),
  microLivePairCashBaselineMicros: text("micro_live_pair_cash_baseline_micros"),
  microLivePairCashBaselineRunId: text("micro_live_pair_cash_baseline_run_id"),
  microLivePairCashBaselineAt: timestamp("micro_live_pair_cash_baseline_at", { withTimezone: true }),
  microLivePairCashBaselineEvidenceDigest: text("micro_live_pair_cash_baseline_evidence_digest"),
  // Authenticated primary-account activity cursor/checkpoint. Cursor semantics
  // are supplied by the history reader; callers must fail closed if its history
  // is not complete and exclusive after this cursor.
  microLivePrimaryActivityCheckpointRunId: text("micro_live_primary_activity_checkpoint_run_id"),
  microLivePrimaryActivityCheckpointCursor: text("micro_live_primary_activity_checkpoint_cursor"),
  microLivePrimaryActivityCheckpointAt: timestamp("micro_live_primary_activity_checkpoint_at", { withTimezone: true }),
  microLivePrimaryActivityCheckpointEvidenceDigest: text("micro_live_primary_activity_checkpoint_evidence_digest"),
  // Checkpoint identity is repeated alongside the cursor so it cannot be
  // accidentally reused for a different subaccount or exchange shard.
  microLiveAccountActivityCheckpointRunId: text("micro_live_account_activity_checkpoint_run_id"),
  microLiveAccountActivityCheckpointCursor: text("micro_live_account_activity_checkpoint_cursor"),
  microLiveAccountActivityCheckpointAt: timestamp("micro_live_account_activity_checkpoint_at", { withTimezone: true }),
  microLiveAccountActivityCheckpointEvidenceDigest: text("micro_live_account_activity_checkpoint_evidence_digest"),
  microLiveAccountActivityCheckpointSubaccount: integer("micro_live_account_activity_checkpoint_subaccount"),
  microLiveAccountActivityCheckpointExchangeIndex: integer("micro_live_account_activity_checkpoint_exchange_index"),
  microLiveReservedMicros: integer("micro_live_reserved_micros").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check("micro_live_config_singleton_check", sql`${table.id} = 'singleton'`),
  check("micro_live_config_account_mode_check", sql`
    ${table.microLiveAccountMode} IS NULL OR
    ${table.microLiveAccountMode} IN ('exclusive', 'primary_nonexclusive')
  `),
  check("micro_live_config_selected_subaccount_check", sql`
    ${table.microLiveSelectedSubaccount} IS NULL OR
    ${table.microLiveSelectedSubaccount} BETWEEN 0 AND 63
  `),
  check("micro_live_config_selected_exchange_index_check", sql`
    ${table.microLiveSelectedExchangeIndex} IS NULL OR
    ${table.microLiveSelectedExchangeIndex} = 2
  `),
  check("micro_live_config_selected_pair_check", sql`
    ${table.microLiveSelectedExchangeIndex} IS NULL OR
    (
      ${table.microLiveAccountMode} IS NOT NULL AND
      ${table.microLiveAccountMode} = 'exclusive' AND
      ${table.microLiveSelectedSubaccount} IS NOT NULL AND
      ${table.microLiveSelectedSubaccount} BETWEEN 1 AND 63
    )
  `),
  check("micro_live_config_dedicated_pair_complete_check", sql`
    (
      ${table.microLiveSelectedExchangeIndex} IS NULL AND
      ${table.microLiveRestrictedApiKeyId} IS NULL AND
      ${table.microLiveRestrictedKeyFingerprint} IS NULL AND
      ${table.microLiveFundingAnchorSubaccount} IS NULL AND
      ${table.microLiveFundingAnchorExchangeIndex} IS NULL AND
      ${table.microLiveFundingAnchorTransferId} IS NULL AND
      ${table.microLiveFundingAnchorTransferAt} IS NULL AND
      ${table.microLiveFundingAnchorAmountCents} IS NULL AND
      ${table.microLivePairCashBaselineMicros} IS NULL AND
      ${table.microLivePairCashBaselineRunId} IS NULL AND
      ${table.microLivePairCashBaselineAt} IS NULL AND
      ${table.microLivePairCashBaselineEvidenceDigest} IS NULL AND
      ${table.microLiveAccountActivityCheckpointRunId} IS NULL AND
      ${table.microLiveAccountActivityCheckpointCursor} IS NULL AND
      ${table.microLiveAccountActivityCheckpointAt} IS NULL AND
      ${table.microLiveAccountActivityCheckpointEvidenceDigest} IS NULL AND
      ${table.microLiveAccountActivityCheckpointSubaccount} IS NULL AND
      ${table.microLiveAccountActivityCheckpointExchangeIndex} IS NULL
    ) OR (
      ${table.microLiveSelectedExchangeIndex} = 2 AND
      ${table.microLiveAccountMode} = 'exclusive' AND
      ${table.microLiveSelectedSubaccount} BETWEEN 1 AND 63 AND
      ${table.microLiveRestrictedApiKeyId} IS NOT NULL AND
      btrim(${table.microLiveRestrictedApiKeyId}) <> '' AND
      ${table.microLiveRestrictedKeyFingerprint} ~ '^[0-9a-f]{64}$' AND
      ${table.microLiveFundingAnchorSubaccount} = ${table.microLiveSelectedSubaccount} AND
      ${table.microLiveFundingAnchorExchangeIndex} = 2 AND
      ${table.microLiveFundingAnchorTransferId} IS NOT NULL AND
      btrim(${table.microLiveFundingAnchorTransferId}) <> '' AND
      ${table.microLiveFundingAnchorTransferAt} IS NOT NULL AND
      ${table.microLiveFundingAnchorAmountCents} = 2500 AND
      ${table.microLivePairCashBaselineMicros} = '25000000' AND
      ${table.microLivePairCashBaselineRunId} = ${table.microLiveRunId} AND
      ${table.microLivePairCashBaselineAt} IS NOT NULL AND
      ${table.microLivePairCashBaselineEvidenceDigest} ~ '^[0-9a-f]{64}$' AND
      ${table.microLiveAccountActivityCheckpointRunId} = ${table.microLiveRunId} AND
      ${table.microLiveAccountActivityCheckpointCursor} IS NOT NULL AND
      btrim(${table.microLiveAccountActivityCheckpointCursor}) <> '' AND
      ${table.microLiveAccountActivityCheckpointAt} IS NOT NULL AND
      ${table.microLiveAccountActivityCheckpointEvidenceDigest} ~ '^[0-9a-f]{64}$' AND
      ${table.microLiveAccountActivityCheckpointSubaccount} = ${table.microLiveSelectedSubaccount} AND
      ${table.microLiveAccountActivityCheckpointExchangeIndex} = 2
    )
  `),
  check("micro_live_config_restricted_key_identity_check", sql`
    (
      ${table.microLiveRestrictedApiKeyId} IS NULL AND
      ${table.microLiveRestrictedKeyFingerprint} IS NULL
    ) OR (
      ${table.microLiveSelectedExchangeIndex} IS NOT NULL AND
      ${table.microLiveSelectedExchangeIndex} = 2 AND
      ${table.microLiveRestrictedApiKeyId} IS NOT NULL AND
      btrim(${table.microLiveRestrictedApiKeyId}) <> '' AND
      ${table.microLiveRestrictedKeyFingerprint} IS NOT NULL AND
      ${table.microLiveRestrictedKeyFingerprint} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_config_mode_account_pair_check", sql`
    (${table.microLiveAccountMode} IS NULL AND ${table.microLiveSelectedSubaccount} IS NULL) OR
    (${table.microLiveAccountMode} = 'exclusive' AND ${table.microLiveSelectedSubaccount} BETWEEN 1 AND 63) OR
    (${table.microLiveAccountMode} = 'primary_nonexclusive' AND ${table.microLiveSelectedSubaccount} = 0)
  `),
  check("micro_live_config_primary_cash_baseline_consistency_check", sql`
    (
      ${table.microLivePrimaryCashBaselineMicros} IS NULL AND
      ${table.microLivePrimaryCashBaselineRunId} IS NULL AND
      ${table.microLivePrimaryCashBaselineAt} IS NULL AND
      ${table.microLivePrimaryCashBaselineEvidenceDigest} IS NULL
    ) OR (
      ${table.microLivePrimaryCashBaselineMicros} IS NOT NULL AND
      ${table.microLivePrimaryCashBaselineMicros} ~ '^(0|[1-9][0-9]*)$' AND
      ${table.microLivePrimaryCashBaselineRunId} IS NOT NULL AND
      btrim(${table.microLivePrimaryCashBaselineRunId}) <> '' AND
      ${table.microLivePrimaryCashBaselineAt} IS NOT NULL AND
      ${table.microLivePrimaryCashBaselineEvidenceDigest} IS NOT NULL AND
      ${table.microLivePrimaryCashBaselineEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_config_pair_cash_anchor_consistency_check", sql`
    (
      ${table.microLiveFundingAnchorSubaccount} IS NULL AND
      ${table.microLiveFundingAnchorExchangeIndex} IS NULL AND
      ${table.microLiveFundingAnchorTransferId} IS NULL AND
      ${table.microLiveFundingAnchorTransferAt} IS NULL AND
      ${table.microLiveFundingAnchorAmountCents} IS NULL AND
      ${table.microLivePairCashBaselineMicros} IS NULL AND
      ${table.microLivePairCashBaselineRunId} IS NULL AND
      ${table.microLivePairCashBaselineAt} IS NULL AND
      ${table.microLivePairCashBaselineEvidenceDigest} IS NULL
    ) OR (
      ${table.microLiveSelectedExchangeIndex} IS NOT NULL AND
      ${table.microLiveSelectedExchangeIndex} = 2 AND
      ${table.microLiveSelectedSubaccount} IS NOT NULL AND
      ${table.microLiveFundingAnchorSubaccount} IS NOT NULL AND
      ${table.microLiveFundingAnchorSubaccount} BETWEEN 1 AND 63 AND
      ${table.microLiveFundingAnchorSubaccount} = ${table.microLiveSelectedSubaccount} AND
      ${table.microLiveFundingAnchorExchangeIndex} IS NOT NULL AND
      ${table.microLiveFundingAnchorExchangeIndex} = 2 AND
      ${table.microLiveFundingAnchorExchangeIndex} = ${table.microLiveSelectedExchangeIndex} AND
      ${table.microLiveRestrictedApiKeyId} IS NOT NULL AND
      ${table.microLiveRestrictedKeyFingerprint} IS NOT NULL AND
      ${table.microLiveFundingAnchorTransferId} IS NOT NULL AND
      btrim(${table.microLiveFundingAnchorTransferId}) <> '' AND
      ${table.microLiveFundingAnchorTransferAt} IS NOT NULL AND
      ${table.microLivePairCashBaselineAt} IS NOT NULL AND
      ${table.microLiveFundingAnchorTransferAt} <= ${table.microLivePairCashBaselineAt} AND
      ${table.microLiveFundingAnchorAmountCents} IS NOT NULL AND
      ${table.microLiveFundingAnchorAmountCents} = 2500 AND
      ${table.microLivePairCashBaselineMicros} IS NOT NULL AND
      ${table.microLivePairCashBaselineMicros} = '25000000' AND
      ${table.microLivePairCashBaselineRunId} IS NOT NULL AND
      btrim(${table.microLivePairCashBaselineRunId}) <> '' AND
      ${table.microLiveRunId} IS NOT NULL AND
      ${table.microLivePairCashBaselineRunId} = ${table.microLiveRunId} AND
      ${table.microLivePairCashBaselineAt} IS NOT NULL AND
      ${table.microLivePairCashBaselineEvidenceDigest} IS NOT NULL AND
      ${table.microLivePairCashBaselineEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_config_primary_activity_checkpoint_consistency_check", sql`
    (
      ${table.microLivePrimaryActivityCheckpointRunId} IS NULL AND
      ${table.microLivePrimaryActivityCheckpointCursor} IS NULL AND
      ${table.microLivePrimaryActivityCheckpointAt} IS NULL AND
      ${table.microLivePrimaryActivityCheckpointEvidenceDigest} IS NULL
    ) OR (
      ${table.microLivePrimaryActivityCheckpointRunId} IS NOT NULL AND
      btrim(${table.microLivePrimaryActivityCheckpointRunId}) <> '' AND
      ${table.microLivePrimaryActivityCheckpointCursor} IS NOT NULL AND
      btrim(${table.microLivePrimaryActivityCheckpointCursor}) <> '' AND
      ${table.microLivePrimaryActivityCheckpointAt} IS NOT NULL AND
      ${table.microLivePrimaryActivityCheckpointEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_config_account_activity_checkpoint_consistency_check", sql`
    (
      ${table.microLiveAccountActivityCheckpointRunId} IS NULL AND
      ${table.microLiveAccountActivityCheckpointCursor} IS NULL AND
      ${table.microLiveAccountActivityCheckpointAt} IS NULL AND
      ${table.microLiveAccountActivityCheckpointEvidenceDigest} IS NULL AND
      ${table.microLiveAccountActivityCheckpointSubaccount} IS NULL AND
      ${table.microLiveAccountActivityCheckpointExchangeIndex} IS NULL
    ) OR (
      ${table.microLiveSelectedExchangeIndex} IS NOT NULL AND
      ${table.microLiveSelectedExchangeIndex} = 2 AND
      ${table.microLiveAccountActivityCheckpointRunId} IS NOT NULL AND
      btrim(${table.microLiveAccountActivityCheckpointRunId}) <> '' AND
      ${table.microLiveRunId} IS NOT NULL AND
      ${table.microLiveAccountActivityCheckpointRunId} = ${table.microLiveRunId} AND
      ${table.microLiveAccountActivityCheckpointCursor} IS NOT NULL AND
      btrim(${table.microLiveAccountActivityCheckpointCursor}) <> '' AND
      ${table.microLiveAccountActivityCheckpointAt} IS NOT NULL AND
      ${table.microLivePairCashBaselineAt} IS NOT NULL AND
      ${table.microLiveAccountActivityCheckpointAt} >= ${table.microLivePairCashBaselineAt} AND
      ${table.microLiveAccountActivityCheckpointEvidenceDigest} IS NOT NULL AND
      ${table.microLiveAccountActivityCheckpointEvidenceDigest} ~ '^[0-9a-f]{64}$' AND
      ${table.microLiveAccountActivityCheckpointSubaccount} IS NOT NULL AND
      ${table.microLiveAccountActivityCheckpointSubaccount} =
        ${table.microLiveSelectedSubaccount} AND
      ${table.microLiveAccountActivityCheckpointExchangeIndex} IS NOT NULL AND
      ${table.microLiveAccountActivityCheckpointExchangeIndex} =
        ${table.microLiveSelectedExchangeIndex}
    )
  `),
  check("micro_live_config_micro_budget_check", sql`
    ${table.microLiveRunCapMicros} BETWEEN 1000000 AND 5000000 AND
    ${table.microLiveReservedMicros} >= 0 AND
    ${table.microLiveReservedMicros} <= ${table.microLiveRunCapMicros} AND
    (${table.microLiveEntryAttempted} = false OR ${table.microLiveRunId} IS NOT NULL)
  `),
  // An approved policy locks in its run-cap ceiling: revoke it before any
  // upward cap edit, then obtain a new approval against the new cap.
  check("micro_live_config_fee_approval_consistency_check", sql`
    (
      ${table.microLiveFeeApprovalApproved} = false AND
      ${table.microLiveFeeApprovalId} IS NULL AND
      ${table.microLiveFeeApprovalDigest} IS NULL AND
      ${table.microLiveFeeApprovalApprovedAt} IS NULL AND
      ${table.microLiveFeePolicyVersion} IS NULL AND
      ${table.microLiveFeeMaximumExposureMicros} IS NULL AND
      ${table.microLiveFeeApprovedBy} IS NULL AND
      ${table.microLiveFeeApprovedRunCapMicros} IS NULL
    ) OR (
      ${table.microLiveFeeApprovalId} IS NOT NULL AND
      ${table.microLiveFeeApprovalId} <> '' AND
      ${table.microLiveFeeApprovalDigest} ~ '^[0-9a-f]{64}$' AND
      ${table.microLiveFeeApprovalApprovedAt} IS NOT NULL AND
      ${table.microLiveFeePolicyVersion} IS NOT NULL AND
      ${table.microLiveFeePolicyVersion} <> '' AND
      ${table.microLiveFeeMaximumExposureMicros} BETWEEN 1 AND 5000000 AND
      ${table.microLiveFeeApprovedBy} IS NOT NULL AND
      btrim(${table.microLiveFeeApprovedBy}) <> '' AND
      ${table.microLiveFeeApprovedRunCapMicros} BETWEEN 1000000 AND 5000000 AND
      (
        ${table.microLiveFeeApprovalApproved} = false OR
        (
          ${table.microLiveFeeApprovalInvalidated} = false AND
          ${table.microLiveRunCapMicros} <= ${table.microLiveFeeApprovedRunCapMicros} AND
          ${table.microLiveRunCapMicros} <= ${table.microLiveFeeMaximumExposureMicros} AND
          ${table.microLiveRunCapMicros} <= 5000000
        )
      )
    )
  `),
  // A new approval must pin the official artifact and formula. Historical
  // approvals with no source remain stored but must be revoked/reapproved.
  check("micro_live_config_fee_approval_artifact_identity_check", sql`
    ${table.microLiveFeeApprovalApproved} = false OR
    (
      ${table.microLiveFeePolicyVersion} = 'micro-live-standing-fee-policy-v1' AND
      ${table.microLiveFeeApprovalSourceUrl} = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf' AND
      ${table.microLiveFeeFormulaVersion} = 'standard-quadratic-0.07-v1'
    )
  `),
  check("micro_live_config_fee_artifact_status_check", sql`
    ${table.microLiveFeeArtifactStatus} IN ('unverified', 'verified', 'changed', 'unavailable', 'invalid')
  `),
  check("micro_live_config_run_phase_check", sql`
    ${table.microLiveRunPhase} IN ('UNARMED', 'PREPARING', 'ENTRY_OPEN', 'EXIT_ONLY', 'FROZEN')
  `),
  check("micro_live_config_bankroll_check", sql`
    ${table.maxLiveBankrollCents} >= 0 AND ${table.maxLiveBankrollCents} <= 2500
  `),
  check("micro_live_config_risk_limits_check", sql`
    ${table.maxSingleOrderRiskCents} >= 0 AND ${table.maxSingleOrderRiskCents} <= 500 AND
    ${table.maxOpenPositions} >= 0 AND ${table.maxOpenPositions} <= 1 AND
    ${table.maxCumulativeReservedCents} >= 0 AND
    ${table.maxCumulativeReservedCents} <= ${table.maxLiveBankrollCents} AND
    ${table.maxScoutStakeCents} >= 0 AND ${table.maxScoutStakeCents} <= 500 AND
    ${table.maxConfirmAdditionalStakeCents} >= 0 AND
    ${table.maxConfirmAdditionalStakeCents} <= 500
  `),
]);

export const insertMicroLiveConfigSchema = createInsertSchema(microLiveConfigTable);
export type MicroLiveConfig = typeof microLiveConfigTable.$inferSelect;
export type InsertMicroLiveConfig = z.infer<typeof insertMicroLiveConfigSchema>;