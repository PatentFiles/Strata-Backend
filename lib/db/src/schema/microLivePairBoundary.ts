import { sql } from "drizzle-orm";
import {
  boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Prospective clean boundary for one dedicated Kalshi (N, 2) pair.
 *
 * The first insert records an authoritative, creation-attempt-proven $0
 * snapshot. Restricted-key binding is a separate, independently verified
 * transition. Services must lock this row before transitions and must never
 * clear freeze evidence.
 */
export const microLivePairBoundaryTable = pgTable("micro_live_pair_boundary", {
  // Exchange index is constrained to 2, so N uniquely keys one pair.
  subaccountNumber: integer("subaccount_number").primaryKey(),
  exchangeIndex: integer("exchange_index").notNull().default(2),
  restrictedApiKeyId: text("restricted_api_key_id"),
  restrictedKeyFingerprint: text("restricted_key_fingerprint"),

  cleanBalanceMicros: text("clean_balance_micros").notNull(),
  cleanBalanceSemantics: text("clean_balance_semantics").notNull(),
  cleanSnapshotAuthenticated: boolean("clean_snapshot_authenticated").notNull(),
  cleanOrderCount: integer("clean_order_count").notNull(),
  cleanFillCount: integer("clean_fill_count").notNull(),
  cleanPositionCount: integer("clean_position_count").notNull(),
  cleanSettlementCount: integer("clean_settlement_count").notNull(),
  cleanBoundaryAt: timestamp("clean_boundary_at", { withTimezone: true }).notNull(),
  cleanBoundaryEvidenceDigest: text("clean_boundary_evidence_digest").notNull(),
  creationAttemptId: text("creation_attempt_id"),
  creationInventoryDigest: text("creation_inventory_digest"),
  keyBoundAt: timestamp("key_bound_at", { withTimezone: true }),
  keyBindingEvidenceDigest: text("key_binding_evidence_digest"),

  state: text("state").notNull().default("CREATED_CLEAN"),

  // Funding and its post-transfer balance are written together by one
  // locked transaction. Dollars are represented as exact integer micros.
  fundingTransferId: text("funding_transfer_id"),
  fundingAmountCents: integer("funding_amount_cents"),
  fundingTransferredAt: timestamp("funding_transferred_at", { withTimezone: true }),
  postFundingBalanceMicros: text("post_funding_balance_micros"),
  postFundingBalanceSemantics: text("post_funding_balance_semantics"),
  postFundingSnapshotAuthenticated: boolean("post_funding_snapshot_authenticated"),
  postFundingSnapshotAt: timestamp("post_funding_snapshot_at", { withTimezone: true }),
  postFundingEvidenceDigest: text("post_funding_evidence_digest"),

  initializedRunId: text("initialized_run_id"),
  initializedAt: timestamp("initialized_at", { withTimezone: true }),

  activityCheckpointCursor: text("activity_checkpoint_cursor"),
  activityCheckpointAt: timestamp("activity_checkpoint_at", { withTimezone: true }),
  activityCheckpointDigest: text("activity_checkpoint_digest"),

  ambiguityFrozenAt: timestamp("ambiguity_frozen_at", { withTimezone: true }),
  ambiguityFreezeReason: text("ambiguity_freeze_reason"),
  ambiguityEvidenceDigest: text("ambiguity_evidence_digest"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("micro_live_pair_boundary_funding_transfer_id_unique")
    .on(table.fundingTransferId),
  uniqueIndex("micro_live_pair_boundary_initialized_run_id_unique")
    .on(table.initializedRunId),
  index("micro_live_pair_boundary_state_idx").on(table.state),
  check("micro_live_pair_boundary_identity_check", sql`
    ${table.subaccountNumber} BETWEEN 1 AND 63 AND
    ${table.exchangeIndex} = 2 AND
    (
      (${table.restrictedApiKeyId} IS NULL AND ${table.restrictedKeyFingerprint} IS NULL) OR
      (btrim(${table.restrictedApiKeyId}) <> '' AND
       ${table.restrictedKeyFingerprint} ~ '^[0-9a-f]{64}$')
    )
  `),
  check("micro_live_pair_boundary_clean_snapshot_check", sql`
    ${table.cleanBalanceMicros} = '0' AND
    ${table.cleanBalanceSemantics} = 'available_cash' AND
    ${table.cleanSnapshotAuthenticated} = true AND
    ${table.cleanOrderCount} = 0 AND
    ${table.cleanFillCount} = 0 AND
    ${table.cleanPositionCount} = 0 AND
    ${table.cleanSettlementCount} = 0 AND
    isfinite(${table.cleanBoundaryAt}) AND
    ${table.cleanBoundaryEvidenceDigest} ~ '^[0-9a-f]{64}$'
  `),
  check("micro_live_pair_boundary_creation_provenance_check", sql`
    (
      ${table.creationAttemptId} IS NULL AND
      ${table.state} NOT IN ('CREATED_CLEAN', 'KEY_BOUND_VERIFIED') AND
      ${table.creationInventoryDigest} IS NULL AND
      ${table.keyBoundAt} IS NULL AND
      ${table.keyBindingEvidenceDigest} IS NULL
    ) OR (
      ${table.state} <> 'clean_boundary' AND
      ${table.creationAttemptId} IS NOT NULL AND
      btrim(${table.creationAttemptId}) <> '' AND
      ${table.creationInventoryDigest} IS NOT NULL AND
      ${table.creationInventoryDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_pair_boundary_key_binding_atomic_check", sql`
    (
      ${table.creationAttemptId} IS NULL AND
      ${table.keyBoundAt} IS NULL AND
      ${table.keyBindingEvidenceDigest} IS NULL
    ) OR (
      ${table.state} IN ('CREATED_CLEAN', 'clean_boundary') AND
      ${table.keyBoundAt} IS NULL AND
      ${table.keyBindingEvidenceDigest} IS NULL
    ) OR (
      ${table.state} IN ('KEY_BOUND_VERIFIED', 'funded', 'initialized', 'frozen') AND
      ${table.restrictedApiKeyId} IS NOT NULL AND
      btrim(${table.restrictedApiKeyId}) <> '' AND
      ${table.restrictedKeyFingerprint} IS NOT NULL AND
      ${table.restrictedKeyFingerprint} ~ '^[0-9a-f]{64}$' AND
      ${table.keyBoundAt} IS NOT NULL AND isfinite(${table.keyBoundAt}) AND
      ${table.keyBindingEvidenceDigest} IS NOT NULL AND
      ${table.keyBindingEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_pair_boundary_funding_atomic_check", sql`
    (
      ${table.fundingTransferId} IS NULL AND
      ${table.fundingAmountCents} IS NULL AND
      ${table.fundingTransferredAt} IS NULL AND
      ${table.postFundingBalanceMicros} IS NULL AND
      ${table.postFundingBalanceSemantics} IS NULL AND
      ${table.postFundingSnapshotAuthenticated} IS NULL AND
      ${table.postFundingSnapshotAt} IS NULL AND
      ${table.postFundingEvidenceDigest} IS NULL
    ) OR (
      ${table.fundingTransferId} IS NOT NULL AND
      ${table.fundingTransferId} ~ '^[A-Za-z0-9._:-]{1,128}$' AND
      ${table.fundingAmountCents} IS NOT NULL AND
      ${table.fundingAmountCents} = 2500 AND
      ${table.fundingTransferredAt} IS NOT NULL AND
      isfinite(${table.fundingTransferredAt}) AND
      ${table.fundingTransferredAt} >= ${table.cleanBoundaryAt} AND
      ${table.postFundingBalanceMicros} IS NOT NULL AND
      ${table.postFundingBalanceMicros} = '25000000' AND
      ${table.postFundingBalanceSemantics} = 'available_cash' AND
      ${table.postFundingSnapshotAuthenticated} = true AND
      ${table.postFundingSnapshotAt} IS NOT NULL AND
      isfinite(${table.postFundingSnapshotAt}) AND
      ${table.postFundingSnapshotAt} >= ${table.fundingTransferredAt} AND
      ${table.postFundingEvidenceDigest} IS NOT NULL AND
      ${table.postFundingEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_pair_boundary_initialized_atomic_check", sql`
    (
      ${table.initializedRunId} IS NULL AND
      ${table.initializedAt} IS NULL
    ) OR (
      ${table.fundingTransferId} IS NOT NULL AND
      ${table.postFundingEvidenceDigest} IS NOT NULL AND
      ${table.initializedRunId} IS NOT NULL AND
      btrim(${table.initializedRunId}) <> '' AND
      ${table.initializedAt} IS NOT NULL AND
      isfinite(${table.initializedAt}) AND
      ${table.initializedAt} >= ${table.postFundingSnapshotAt}
    )
  `),
  check("micro_live_pair_boundary_checkpoint_atomic_check", sql`
    (
      ${table.activityCheckpointCursor} IS NULL AND
      ${table.activityCheckpointAt} IS NULL AND
      ${table.activityCheckpointDigest} IS NULL
    ) OR (
      ${table.activityCheckpointCursor} IS NOT NULL AND
      btrim(${table.activityCheckpointCursor}) <> '' AND
      length(${table.activityCheckpointCursor}) <= 4096 AND
      ${table.activityCheckpointAt} IS NOT NULL AND
      isfinite(${table.activityCheckpointAt}) AND
      ${table.activityCheckpointAt} >= ${table.cleanBoundaryAt} AND
      ${table.activityCheckpointDigest} IS NOT NULL AND
      ${table.activityCheckpointDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_pair_boundary_ambiguity_freeze_atomic_check", sql`
    (
      ${table.ambiguityFrozenAt} IS NULL AND
      ${table.ambiguityFreezeReason} IS NULL AND
      ${table.ambiguityEvidenceDigest} IS NULL
    ) OR (
      ${table.state} = 'frozen' AND
      ${table.ambiguityFrozenAt} IS NOT NULL AND
      isfinite(${table.ambiguityFrozenAt}) AND
      ${table.ambiguityFreezeReason} IS NOT NULL AND
      btrim(${table.ambiguityFreezeReason}) <> '' AND
      ${table.ambiguityEvidenceDigest} IS NOT NULL AND
      ${table.ambiguityEvidenceDigest} ~ '^[0-9a-f]{64}$'
    )
  `),
  check("micro_live_pair_boundary_state_check", sql`
    (
      ${table.state} IN ('clean_boundary', 'CREATED_CLEAN', 'KEY_BOUND_VERIFIED') AND
      ${table.fundingTransferId} IS NULL AND
      ${table.initializedRunId} IS NULL AND
      ${table.ambiguityFrozenAt} IS NULL
    ) OR (
      ${table.state} = 'funded' AND
      ${table.fundingTransferId} IS NOT NULL AND
      ${table.initializedRunId} IS NULL AND
      ${table.ambiguityFrozenAt} IS NULL AND
      (${table.creationAttemptId} IS NULL OR ${table.keyBoundAt} IS NOT NULL)
    ) OR (
      ${table.state} = 'initialized' AND
      ${table.fundingTransferId} IS NOT NULL AND
      ${table.initializedRunId} IS NOT NULL AND
      ${table.ambiguityFrozenAt} IS NULL AND
      (${table.creationAttemptId} IS NULL OR ${table.keyBoundAt} IS NOT NULL)
    ) OR (
      ${table.state} = 'frozen' AND
      ${table.ambiguityFrozenAt} IS NOT NULL AND
      (${table.creationAttemptId} IS NULL OR ${table.keyBoundAt} IS NOT NULL)
    )
  `),
]);

export const insertMicroLivePairBoundarySchema = createInsertSchema(microLivePairBoundaryTable);
export type MicroLivePairBoundary = typeof microLivePairBoundaryTable.$inferSelect;
export type InsertMicroLivePairBoundary = z.infer<typeof insertMicroLivePairBoundarySchema>;