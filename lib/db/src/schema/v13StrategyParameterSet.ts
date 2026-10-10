import { sql } from "drizzle-orm";
import {
  boolean, check, doublePrecision, integer, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Versioned research-only V13 parameter sets.
 *
 * These rows can alter shadow opportunity classification only. The
 * execution_authority column is database-constrained to false so a research
 * parameter edit cannot become live trading authority by changing row state.
 */
export const v13StrategyParameterSetTable = pgTable("v13_strategy_parameter_set", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  supersedesParameterSetId: text("supersedes_parameter_set_id"),
  label: text("label").notNull(),
  state: text("state").notNull().default("DRAFT"),
  classifierVersion: text("classifier_version").notNull().default("V1.3"),
  scoutMinSeparation: doublePrecision("scout_min_separation").notNull(),
  scoutMaxSeparation: doublePrecision("scout_max_separation").notNull(),
  confirmMinSeparation: doublePrecision("confirm_min_separation").notNull(),
  scoutMaxOffer: doublePrecision("scout_max_offer").notNull(),
  confirmMaxOffer: doublePrecision("confirm_max_offer").notNull(),
  wrongSideRecrossSeparation: doublePrecision("wrong_side_recross_separation").notNull(),
  exitOnMomentumInvalidation: boolean("exit_on_momentum_invalidation").notNull().default(true),
  parameterHash: text("parameter_hash").notNull(),
  executionAuthority: boolean("execution_authority").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedBy: text("activated_by"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("v13_strategy_parameter_set_version_unique").on(table.version),
  check("v13_strategy_parameter_set_version_check", sql`${table.version} > 0`),
  check("v13_strategy_parameter_set_reserved_id_check",
    sql`${table.id} NOT IN ('v13-champion-1','v13-champion-2-c52-confirm53')`),
  check("v13_strategy_parameter_set_state_check",
    sql`${table.state} IN ('DRAFT','SHADOW','RETIRED')`),
  check("v13_strategy_parameter_set_classifier_check",
    sql`${table.classifierVersion} = 'V1.3'`),
  check("v13_strategy_parameter_set_no_execution_authority",
    sql`${table.executionAuthority} = false`),
  check("v13_strategy_parameter_set_hash_check",
    sql`${table.parameterHash} ~ '^[0-9a-f]{64}$'`),
  check("v13_strategy_parameter_set_ranges_check", sql`
    ${table.scoutMinSeparation} >= 0 AND
    ${table.scoutMaxSeparation} >= ${table.scoutMinSeparation} AND
    ${table.confirmMinSeparation} > ${table.scoutMaxSeparation} AND
    ${table.wrongSideRecrossSeparation} >= 0 AND
    ${table.scoutMaxOffer} > 0 AND ${table.scoutMaxOffer} <= 1 AND
    ${table.confirmMaxOffer} > 0 AND ${table.confirmMaxOffer} <= 1
  `),
  check("v13_strategy_parameter_set_shadow_activation_check", sql`
    ${table.state} <> 'SHADOW' OR (
      ${table.activatedAt} IS NOT NULL AND
      ${table.activatedBy} IS NOT NULL AND btrim(${table.activatedBy}) <> ''
    )
  `),
]);

export const insertV13StrategyParameterSetSchema =
  createInsertSchema(v13StrategyParameterSetTable);
export type V13StrategyParameterSetRow =
  typeof v13StrategyParameterSetTable.$inferSelect;
export type InsertV13StrategyParameterSet =
  z.infer<typeof insertV13StrategyParameterSetSchema>;
