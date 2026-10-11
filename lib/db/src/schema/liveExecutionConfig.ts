import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const liveExecutionConfigTable = pgTable("live_execution_config", {
  id: text("id").primaryKey().default("singleton"),
  mode: text("mode").notNull().default("SHADOW_LIVE"),
  liveExecutionEnabled: boolean("live_execution_enabled").notNull().default(false),
  liveCapitalLimit: doublePrecision("live_capital_limit").notNull().default(0),
  liveCapitalRemaining: doublePrecision("live_capital_remaining").notNull().default(0),
  maxStakePerTrade: doublePrecision("max_stake_per_trade").notNull().default(0),
  maxDailyLoss: doublePrecision("max_daily_loss").notNull().default(0),
  maxTotalExperimentLoss: doublePrecision("max_total_experiment_loss").notNull().default(0),
  maxOpenPositions: integer("max_open_positions").notNull().default(0),
  maxEntryPrice: doublePrecision("max_entry_price").notNull().default(0),
  maxSlippage: doublePrecision("max_slippage").notNull().default(0),
  shadowCapitalLimit: doublePrecision("shadow_capital_limit").notNull().default(0),
  shadowCapitalRemaining: doublePrecision("shadow_capital_remaining").notNull().default(0),
  shadowMaxStakePerTrade: doublePrecision("shadow_max_stake_per_trade").notNull().default(0),
  shadowMaxOpenPositions: integer("shadow_max_open_positions").notNull().default(0),
  shadowMaxTotalLoss: doublePrecision("shadow_max_total_loss").notNull().default(0),
  manualKillSwitch: boolean("manual_kill_switch").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check("live_execution_config_singleton_check", sql`${table.id} = 'singleton'`),
  check("live_execution_config_mode_check", sql`${table.mode} IN ('PAPER_ONLY','SHADOW_LIVE','V13_PRODUCTION')`),
  check("live_execution_config_mode_execution_check", sql`
    (${table.mode} IN ('PAPER_ONLY','SHADOW_LIVE') AND ${table.liveExecutionEnabled} = false)
    OR ${table.mode} = 'V13_PRODUCTION'
  `),
  check("live_execution_config_execution_requires_kill_off_check", sql`
    ${table.liveExecutionEnabled} = false OR ${table.manualKillSwitch} = false
  `),
  check("live_execution_config_nonnegative_limits_check", sql`
    ${table.liveCapitalLimit} >= 0 AND ${table.liveCapitalRemaining} >= 0 AND
    ${table.maxStakePerTrade} >= 0 AND ${table.maxDailyLoss} >= 0 AND
    ${table.maxTotalExperimentLoss} >= 0 AND ${table.maxOpenPositions} >= 0 AND
    ${table.maxEntryPrice} >= 0 AND ${table.maxEntryPrice} <= 1 AND ${table.maxSlippage} >= 0
  `),
  check("live_execution_config_shadow_limits_check", sql`
    ${table.shadowCapitalLimit} >= 0 AND
    ${table.shadowCapitalRemaining} >= 0 AND ${table.shadowCapitalRemaining} <= ${table.shadowCapitalLimit} AND
    ${table.shadowMaxStakePerTrade} >= 0 AND ${table.shadowMaxStakePerTrade} <= ${table.shadowCapitalLimit} AND
    ${table.shadowMaxOpenPositions} >= 0 AND ${table.shadowMaxOpenPositions} <= 100 AND
    ${table.shadowMaxTotalLoss} >= 0
  `),
]);

export const insertLiveExecutionConfigSchema = createInsertSchema(liveExecutionConfigTable);
export type LiveExecutionConfig = typeof liveExecutionConfigTable.$inferSelect;
export type InsertLiveExecutionConfig = z.infer<typeof insertLiveExecutionConfigSchema>;