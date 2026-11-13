import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Shared configuration template. It is not an account, a policy approval, or execution state. */
export const v13SharedPresetTable = pgTable("v13_shared_preset", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  creatorUserId: uuid("creator_user_id").notNull(),
  creatorDisplayName: text("creator_display_name"),
  capitalLimitCents: integer("capital_limit_cents").notNull(),
  maxEntryStakeCents: integer("max_entry_stake_cents").notNull(),
  maxEntryAllInCents: integer("max_entry_all_in_cents").notNull(),
  maxDailyLossCents: integer("max_daily_loss_cents").notNull(),
  maxTotalLossCents: integer("max_total_loss_cents").notNull(),
  maxQuoteAgeMs: integer("max_quote_age_ms").notNull(),
  maxFeeEvidenceAgeMs: integer("max_fee_evidence_age_ms").notNull(),
  minimumExitMicros: integer("minimum_exit_micros").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("v13_shared_preset_name", sql`char_length(${t.name}) BETWEEN 1 AND 80`),
  check("v13_shared_preset_limits", sql`
    ${t.capitalLimitCents} > 0 AND
    ${t.maxEntryStakeCents} >= 1 AND ${t.maxEntryStakeCents} <= 2500000 AND
    ${t.maxEntryAllInCents} >= ${t.maxEntryStakeCents} AND
    ${t.maxEntryAllInCents} <= ${t.capitalLimitCents} AND
    ${t.maxDailyLossCents} >= 1 AND ${t.maxDailyLossCents} <= ${t.capitalLimitCents} AND
    ${t.maxTotalLossCents} >= 1 AND ${t.maxTotalLossCents} <= ${t.capitalLimitCents} AND
    ${t.maxQuoteAgeMs} BETWEEN 1 AND 15000 AND
    ${t.maxFeeEvidenceAgeMs} BETWEEN 1 AND 15000 AND
    ${t.minimumExitMicros} BETWEEN 1 AND 999999 AND
    ${t.revision} >= 1
  `),
]);
