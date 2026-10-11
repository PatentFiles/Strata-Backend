import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Operator entry target. The approved policy maximum remains the hard ceiling. */
export const strataConfiguredStakeTable = pgTable("strata_configured_stake", {
  id: text("id").primaryKey(),
  executionAccountId: text("execution_account_id"),
  configuredStakeCents: integer("configured_stake_cents").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("strata_configured_stake_account").on(t.executionAccountId).where(sql`${t.executionAccountId} IS NOT NULL`),
  check("strata_configured_stake_cents", sql`${t.configuredStakeCents} >= 1`),
  check("strata_configured_stake_revision", sql`${t.revision} >= 1`),
]);
