import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Operator entry target. The approved policy maximum remains the hard ceiling. */
export const strataConfiguredStakeTable = pgTable("strata_configured_stake", {
  id: text("id").primaryKey(),
  configuredStakeCents: integer("configured_stake_cents").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
  check("strata_configured_stake_singleton", sql`${t.id} = 'production'`),
  check("strata_configured_stake_cents", sql`${t.configuredStakeCents} >= 1`),
  check("strata_configured_stake_revision", sql`${t.revision} >= 1`),
]);
