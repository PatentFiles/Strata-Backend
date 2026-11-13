import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Operator entry target. The approved policy maximum remains the hard ceiling. */
export const strataConfiguredStakeTable = pgTable("strata_configured_stake", {
  id: text("id").primaryKey(),
  executionAccountId: text("execution_account_id"),
  configuredStakeCents: integer("configured_stake_cents").notNull(),
  /** Selected immutable-in-history ratio template; null for legacy accounts. */
  riskPresetId: text("risk_preset_id"),
  riskPresetRevision: integer("risk_preset_revision"),
  riskCapitalCents: integer("risk_capital_cents"),
  revision: integer("revision").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("strata_configured_stake_account").on(t.executionAccountId).where(sql`${t.executionAccountId} IS NOT NULL`),
  check("strata_configured_stake_cents", sql`${t.configuredStakeCents} >= 1`),
  check("strata_configured_stake_revision", sql`${t.revision} >= 1`),
  check("strata_stake_risk_preset_all_or_none", sql`
    (${t.riskPresetId} IS NULL AND ${t.riskPresetRevision} IS NULL AND ${t.riskCapitalCents} IS NULL)
    OR
    (length(${t.riskPresetId}) BETWEEN 1 AND 120 AND
     ${t.riskPresetRevision} >= 1 AND ${t.riskCapitalCents} >= 150)
  `),
]);
