import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Append-only application audit of a frozen, unused bounded run when a new
 * development run slot is explicitly prepared. Prior run identity, $1/$5 cap,
 * attempt claims, approval evidence, and risk limits remain queryable.
 */
export const microLiveRunArchiveTable = pgTable("micro_live_run_archive", {
  priorRunId: text("prior_run_id").primaryKey(),
  successorRunId: text("successor_run_id").notNull().unique(),
  phase: text("phase").notNull(),
  armedAt: timestamp("armed_at", { withTimezone: true }).notNull(),
  // Historical timed runs keep their deadline; standing runs have none.
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  approvalId: text("approval_id").notNull(),
  approvalDigest: text("approval_digest").notNull(),
  approvalSourceUrl: text("approval_source_url"),
  approvalFormulaVersion: text("approval_formula_version"),
  approvalApprover: text("approval_approver"),
  freezeReason: text("freeze_reason").notNull(),
  capMicros: integer("cap_micros").notNull(),
  reservedMicros: integer("reserved_micros").notNull(),
  entryAttempted: boolean("entry_attempted").notNull(),
  exitAttempted: boolean("exit_attempted").notNull(),
  accountMode: text("account_mode").notNull(),
  selectedSubaccount: integer("selected_subaccount").notNull(),
  // Nullable for legacy archives. New dedicated-shard bindings are preserved
  // as an audit snapshot rather than inferred from a successor run.
  selectedExchangeIndex: integer("selected_exchange_index"),
  restrictedApiKeyId: text("restricted_api_key_id"),
  restrictedKeyFingerprint: text("restricted_key_fingerprint"),
  fundingAnchorSubaccount: integer("funding_anchor_subaccount"),
  fundingAnchorExchangeIndex: integer("funding_anchor_exchange_index"),
  fundingAnchorTransferId: text("funding_anchor_transfer_id"),
  fundingAnchorTransferAt: timestamp("funding_anchor_transfer_at", { withTimezone: true }),
  fundingAnchorAmountCents: integer("funding_anchor_amount_cents"),
  pairCashBaselineMicros: text("pair_cash_baseline_micros"),
  pairCashBaselineRunId: text("pair_cash_baseline_run_id"),
  pairCashBaselineAt: timestamp("pair_cash_baseline_at", { withTimezone: true }),
  pairCashBaselineEvidenceDigest: text("pair_cash_baseline_evidence_digest"),
  accountActivityCheckpointSubaccount: integer("account_activity_checkpoint_subaccount"),
  accountActivityCheckpointExchangeIndex: integer("account_activity_checkpoint_exchange_index"),
  accountActivityCheckpointRunId: text("account_activity_checkpoint_run_id"),
  accountActivityCheckpointCursor: text("account_activity_checkpoint_cursor"),
  accountActivityCheckpointAt: timestamp("account_activity_checkpoint_at", { withTimezone: true }),
  accountActivityCheckpointEvidenceDigest: text("account_activity_checkpoint_evidence_digest"),
  maxLiveBankrollCents: integer("max_live_bankroll_cents").notNull(),
  maxSingleOrderRiskCents: integer("max_single_order_risk_cents").notNull(),
  maxCumulativeReservedCents: integer("max_cumulative_reserved_cents").notNull(),
  maxScoutStakeCents: integer("max_scout_stake_cents").notNull(),
  maxConfirmAdditionalStakeCents: integer("max_confirm_additional_stake_cents").notNull(),
  actorId: text("actor_id").notNull(),
  transitionReason: text("transition_reason").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("micro_live_run_archive_archived_at").on(table.archivedAt),
  check("micro_live_run_archive_unused_frozen_v2_check", sql`
    ${table.phase} = 'FROZEN' AND ${table.capMicros} IN (1000000, 5000000) AND
    ${table.reservedMicros} = 0 AND
    ${table.entryAttempted} = false AND ${table.exitAttempted} = false AND
    ${table.freezeReason} IN (
      'entry_expired_without_proven_terminal_position',
      'operator_froze_unused_run_for_reviewed_transition'
    )
  `),
  check("micro_live_run_archive_fee_provenance_check", sql`
    (
      ${table.approvalSourceUrl} IS NULL AND
      ${table.approvalFormulaVersion} IS NULL AND
      ${table.approvalApprover} IS NULL
    ) OR (
      ${table.approvalSourceUrl} = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf' AND
      ${table.approvalFormulaVersion} = 'standard-quadratic-0.07-v1' AND
      btrim(${table.approvalApprover}) <> ''
    )
  `),
  check("micro_live_run_archive_account_identity_check", sql`
    (
      ${table.selectedExchangeIndex} IS NULL AND
      ${table.restrictedApiKeyId} IS NULL AND
      ${table.restrictedKeyFingerprint} IS NULL
    ) OR (
      ${table.selectedExchangeIndex} IS NOT NULL AND
      ${table.selectedExchangeIndex} = 2 AND
      ${table.accountMode} = 'exclusive' AND
      ${table.selectedSubaccount} BETWEEN 1 AND 63 AND
      ${table.restrictedApiKeyId} IS NOT NULL AND
      btrim(${table.restrictedApiKeyId}) <> '' AND
      ${table.restrictedKeyFingerprint} IS NOT NULL AND
      ${table.restrictedKeyFingerprint} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_run_archive_funding_anchor_check", sql`
    (
      ${table.fundingAnchorSubaccount} IS NULL AND
      ${table.fundingAnchorExchangeIndex} IS NULL AND
      ${table.fundingAnchorTransferId} IS NULL AND
      ${table.fundingAnchorTransferAt} IS NULL AND
      ${table.fundingAnchorAmountCents} IS NULL AND
      ${table.pairCashBaselineMicros} IS NULL AND
      ${table.pairCashBaselineRunId} IS NULL AND
      ${table.pairCashBaselineAt} IS NULL AND
      ${table.pairCashBaselineEvidenceDigest} IS NULL
    ) OR (
      ${table.selectedExchangeIndex} IS NOT NULL AND
      ${table.selectedExchangeIndex} = 2 AND
      ${table.fundingAnchorSubaccount} IS NOT NULL AND
      ${table.fundingAnchorSubaccount} = ${table.selectedSubaccount} AND
      ${table.fundingAnchorExchangeIndex} IS NOT NULL AND
      ${table.fundingAnchorExchangeIndex} = ${table.selectedExchangeIndex} AND
      ${table.restrictedApiKeyId} IS NOT NULL AND
      ${table.restrictedKeyFingerprint} IS NOT NULL AND
      ${table.fundingAnchorTransferId} IS NOT NULL AND
      btrim(${table.fundingAnchorTransferId}) <> '' AND
      ${table.fundingAnchorTransferAt} IS NOT NULL AND
      ${table.pairCashBaselineAt} IS NOT NULL AND
      ${table.fundingAnchorTransferAt} <= ${table.pairCashBaselineAt} AND
      ${table.fundingAnchorAmountCents} IS NOT NULL AND
      ${table.fundingAnchorAmountCents} = 2500 AND
      ${table.pairCashBaselineMicros} IS NOT NULL AND
      ${table.pairCashBaselineMicros} = '25000000' AND
      ${table.pairCashBaselineRunId} IS NOT NULL AND
      btrim(${table.pairCashBaselineRunId}) <> '' AND
      ${table.pairCashBaselineRunId} = ${table.priorRunId} AND
      ${table.pairCashBaselineAt} IS NOT NULL AND
      ${table.pairCashBaselineEvidenceDigest} IS NOT NULL AND
      ${table.pairCashBaselineEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_run_archive_activity_checkpoint_identity_check", sql`
    (
      ${table.accountActivityCheckpointSubaccount} IS NULL AND
      ${table.accountActivityCheckpointExchangeIndex} IS NULL AND
      ${table.accountActivityCheckpointRunId} IS NULL AND
      ${table.accountActivityCheckpointCursor} IS NULL AND
      ${table.accountActivityCheckpointAt} IS NULL AND
      ${table.accountActivityCheckpointEvidenceDigest} IS NULL
    ) OR (
      ${table.selectedExchangeIndex} IS NOT NULL AND
      ${table.selectedExchangeIndex} = 2 AND
      ${table.accountActivityCheckpointSubaccount} IS NOT NULL AND
      ${table.accountActivityCheckpointSubaccount} = ${table.selectedSubaccount} AND
      ${table.accountActivityCheckpointExchangeIndex} IS NOT NULL AND
      ${table.accountActivityCheckpointExchangeIndex} = ${table.selectedExchangeIndex} AND
      ${table.accountActivityCheckpointRunId} IS NOT NULL AND
      btrim(${table.accountActivityCheckpointRunId}) <> '' AND
      ${table.accountActivityCheckpointCursor} IS NOT NULL AND
      btrim(${table.accountActivityCheckpointCursor}) <> '' AND
      ${table.accountActivityCheckpointAt} IS NOT NULL AND
      ${table.pairCashBaselineAt} IS NOT NULL AND
      ${table.accountActivityCheckpointAt} >= ${table.pairCashBaselineAt} AND
      ${table.accountActivityCheckpointEvidenceDigest} IS NOT NULL AND
      ${table.accountActivityCheckpointEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_run_archive_dedicated_pair_complete_check", sql`
    (
      ${table.selectedExchangeIndex} IS NULL AND
      ${table.restrictedApiKeyId} IS NULL AND
      ${table.restrictedKeyFingerprint} IS NULL AND
      ${table.fundingAnchorSubaccount} IS NULL AND
      ${table.fundingAnchorExchangeIndex} IS NULL AND
      ${table.fundingAnchorTransferId} IS NULL AND
      ${table.fundingAnchorTransferAt} IS NULL AND
      ${table.fundingAnchorAmountCents} IS NULL AND
      ${table.pairCashBaselineMicros} IS NULL AND
      ${table.pairCashBaselineRunId} IS NULL AND
      ${table.pairCashBaselineAt} IS NULL AND
      ${table.pairCashBaselineEvidenceDigest} IS NULL AND
      ${table.accountActivityCheckpointSubaccount} IS NULL AND
      ${table.accountActivityCheckpointExchangeIndex} IS NULL AND
      ${table.accountActivityCheckpointRunId} IS NULL AND
      ${table.accountActivityCheckpointCursor} IS NULL AND
      ${table.accountActivityCheckpointAt} IS NULL AND
      ${table.accountActivityCheckpointEvidenceDigest} IS NULL
    ) OR (
      ${table.selectedExchangeIndex} = 2 AND
      ${table.accountMode} = 'exclusive' AND
      ${table.selectedSubaccount} BETWEEN 1 AND 63 AND
      ${table.restrictedApiKeyId} IS NOT NULL AND
      btrim(${table.restrictedApiKeyId}) <> '' AND
      ${table.restrictedKeyFingerprint} ~ '^[0-9a-f]{64}$' AND
      ${table.fundingAnchorSubaccount} = ${table.selectedSubaccount} AND
      ${table.fundingAnchorExchangeIndex} = 2 AND
      ${table.fundingAnchorTransferId} IS NOT NULL AND
      btrim(${table.fundingAnchorTransferId}) <> '' AND
      ${table.fundingAnchorTransferAt} IS NOT NULL AND
      ${table.fundingAnchorAmountCents} = 2500 AND
      ${table.pairCashBaselineMicros} = '25000000' AND
      ${table.pairCashBaselineRunId} = ${table.priorRunId} AND
      ${table.pairCashBaselineAt} IS NOT NULL AND
      ${table.fundingAnchorTransferAt} <= ${table.pairCashBaselineAt} AND
      ${table.pairCashBaselineEvidenceDigest} ~ '^[0-9a-f]{64}$' AND
      ${table.accountActivityCheckpointSubaccount} = ${table.selectedSubaccount} AND
      ${table.accountActivityCheckpointExchangeIndex} = 2 AND
      ${table.accountActivityCheckpointRunId} = ${table.priorRunId} AND
      ${table.accountActivityCheckpointCursor} IS NOT NULL AND
      btrim(${table.accountActivityCheckpointCursor}) <> '' AND
      ${table.accountActivityCheckpointAt} >= ${table.pairCashBaselineAt} AND
      ${table.accountActivityCheckpointEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
]);

export const insertMicroLiveRunArchiveSchema = createInsertSchema(microLiveRunArchiveTable);
export type MicroLiveRunArchive = typeof microLiveRunArchiveTable.$inferSelect;
export type InsertMicroLiveRunArchive = z.infer<typeof insertMicroLiveRunArchiveSchema>;