import { sql } from "drizzle-orm";
import {
  boolean, check, integer, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Versioned V13 production risk policy.
 *
 * This table is intentionally separate from the micro-live commissioning
 * harness. A row describes authority limits; it does not enable exchange
 * mutation by itself.
 */
export const v13LiveMoneyPolicyTable = pgTable("v13_live_money_policy", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  supersedesPolicyId: text("supersedes_policy_id"),
  state: text("state").notNull().default("DRAFT"),
  strategyVersion: text("strategy_version").notNull().default("V1.3"),
  strategyParameterSetId: text("strategy_parameter_set_id").notNull()
    .default("v13-champion-2-c52-confirm53"),
  strategyParameterHash: text("strategy_parameter_hash").notNull()
    .default("314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161"),
  championSelectionReviewId: text("champion_selection_review_id"),
  championSelectionEvidenceHash: text("champion_selection_evidence_hash"),
  championSelectedBy: text("champion_selected_by"),
  championSelectedAt: timestamp("champion_selected_at", { withTimezone: true }),
  capitalLimitCents: integer("capital_limit_cents").notNull().default(0),
  maxEntryStakeCents: integer("max_entry_stake_cents").notNull().default(0),
  maxEntryAllInCents: integer("max_entry_all_in_cents").notNull().default(0),
  maxOpenPositions: integer("max_open_positions").notNull().default(1),
  maxDailyLossCents: integer("max_daily_loss_cents").notNull().default(0),
  maxTotalLossCents: integer("max_total_loss_cents").notNull().default(0),
  maxQuoteAgeMs: integer("max_quote_age_ms").notNull().default(0),
  maxFeeEvidenceAgeMs: integer("max_fee_evidence_age_ms").notNull().default(0),
  feePolicyVersion: text("fee_policy_version"),
  feeSourceUrl: text("fee_source_url"),
  feeFormulaVersion: text("fee_formula_version"),
  requireFullDepth: boolean("require_full_depth").notNull().default(true),
  entryTimeInForce: text("entry_time_in_force").notNull().default("IOC"),
  entryLimitSource: text("entry_limit_source").notNull().default("SIGNAL_REFERENCE_OFFER"),
  policyHash: text("policy_hash"),
  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("v13_live_money_policy_version_unique").on(table.version),
  uniqueIndex("v13_live_money_policy_one_approved").on(table.state).where(sql`${table.state}='APPROVED'`),
  check("v13_live_money_policy_version_check", sql`${table.version} > 0`),
  check("v13_live_money_policy_state_check",
    sql`${table.state} IN ('DRAFT','APPROVED','REVOKED')`),
  check("v13_live_money_policy_strategy_check", sql`
    ${table.strategyVersion} = 'V1.3' AND (
      (
        ${table.strategyParameterSetId} = 'v13-champion-1' AND
        ${table.strategyParameterHash} =
          '4e7359265d7f6100f3f395658fff005260ee18075adfb8942d6020c20ba7d65f'
      ) OR (
        ${table.strategyParameterSetId} = 'v13-champion-2-c52-confirm53' AND
        ${table.strategyParameterHash} =
          '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161'
      )
    )
  `),
  check("v13_live_money_policy_entry_mode_check", sql`
    ${table.entryTimeInForce} = 'IOC' AND
    ${table.entryLimitSource} = 'SIGNAL_REFERENCE_OFFER'
  `),
  check("v13_live_money_policy_limits_check", sql`
    ${table.capitalLimitCents} >= 0 AND ${table.capitalLimitCents} <= 2000000000 AND
    ${table.maxEntryStakeCents} >= 0 AND ${table.maxEntryStakeCents} <= 500000 AND
    ${table.maxEntryAllInCents} >= 0 AND ${table.maxEntryAllInCents} <= 2000000000 AND
    ${table.maxOpenPositions} >= 0 AND ${table.maxOpenPositions} <= 1 AND
    ${table.maxDailyLossCents} >= 0 AND ${table.maxDailyLossCents} <= 2000000000 AND
    ${table.maxTotalLossCents} >= 0 AND ${table.maxTotalLossCents} <= 2000000000 AND
    ${table.maxQuoteAgeMs} >= 0 AND ${table.maxQuoteAgeMs} <= 15000 AND
    ${table.maxFeeEvidenceAgeMs} >= 0 AND ${table.maxFeeEvidenceAgeMs} <= 15000
  `),
  check("v13_live_money_policy_approval_check", sql`
    ${table.state} <> 'APPROVED' OR (
      ${table.strategyParameterSetId} = 'v13-champion-2-c52-confirm53' AND
      ${table.strategyParameterHash} =
        '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161' AND
      ${table.championSelectionReviewId} IS NOT NULL AND
      btrim(${table.championSelectionReviewId}) <> '' AND
      ${table.championSelectionEvidenceHash} IS NOT NULL AND
      ${table.championSelectionEvidenceHash} ~ '^[0-9a-f]{64}$' AND
      ${table.championSelectedBy} IS NOT NULL AND
      btrim(${table.championSelectedBy}) <> '' AND
      ${table.championSelectedAt} IS NOT NULL AND
      ${table.capitalLimitCents} > 0 AND
      ${table.maxEntryStakeCents} > 0 AND
      ${table.maxEntryStakeCents} <= ${table.maxEntryAllInCents} AND
      ${table.maxEntryAllInCents} <= ${table.capitalLimitCents} AND
      ${table.maxOpenPositions} = 1 AND
      ${table.maxDailyLossCents} > 0 AND
      ${table.maxDailyLossCents} <= ${table.capitalLimitCents} AND
      ${table.maxTotalLossCents} > 0 AND
      ${table.maxTotalLossCents} <= ${table.capitalLimitCents} AND
      ${table.maxQuoteAgeMs} > 0 AND
      ${table.maxFeeEvidenceAgeMs} > 0 AND
      ${table.feePolicyVersion} IS NOT NULL AND btrim(${table.feePolicyVersion}) <> '' AND
      ${table.feeSourceUrl} IS NOT NULL AND btrim(${table.feeSourceUrl}) <> '' AND
      ${table.feeFormulaVersion} IS NOT NULL AND btrim(${table.feeFormulaVersion}) <> '' AND
      ${table.requireFullDepth} = true AND
      ${table.approvedBy} IS NOT NULL AND btrim(${table.approvedBy}) <> '' AND
      ${table.approvedAt} IS NOT NULL AND
      ${table.championSelectedAt} <= ${table.approvedAt} AND
      ${table.policyHash} IS NOT NULL AND
      ${table.policyHash} ~ '^[0-9a-f]{64}$'
    )
  `),
]);

export const insertV13LiveMoneyPolicySchema =
  createInsertSchema(v13LiveMoneyPolicyTable);
export type V13LiveMoneyPolicy =
  typeof v13LiveMoneyPolicyTable.$inferSelect;
export type InsertV13LiveMoneyPolicy =
  z.infer<typeof insertV13LiveMoneyPolicySchema>;
