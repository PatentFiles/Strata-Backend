import { sql } from "drizzle-orm";
import {
  boolean, check, doublePrecision, index, integer, pgTable, text, timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Research-only opportunity classifications evaluated against the exact same
 * public BTC/Kalshi observation as the champion paper evaluation.
 *
 * This table is deliberately not a source accepted by micro-live execution.
 */
export const v13StrategyShadowEvaluationTable = pgTable(
  "v13_strategy_shadow_evaluation",
  {
    id: text("id").primaryKey(),
    sourceEvaluationId: text("source_evaluation_id").notNull(),
    parameterSetId: text("parameter_set_id").notNull(),
    parameterHash: text("parameter_hash").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    marketTicker: text("market_ticker").notNull(),
    btcPrice: doublePrecision("btc_price").notNull(),
    target: doublePrecision("target").notNull(),
    previousBuffer: doublePrecision("previous_buffer"),
    signedBuffer: doublePrecision("signed_buffer").notNull(),
    absoluteBuffer: doublePrecision("absolute_buffer").notNull(),
    velocity: doublePrecision("velocity"),
    upBid: doublePrecision("up_bid"),
    upOffer: doublePrecision("up_offer"),
    downBid: doublePrecision("down_bid"),
    downOffer: doublePrecision("down_offer"),
    secondsRemaining: integer("seconds_remaining"),
    firstCross: boolean("first_cross").notNull(),
    signal: text("signal").notNull(),
    direction: text("direction").notNull(),
    qualifyingTrigger: boolean("qualifying_trigger").notNull(),
    wouldEnter: boolean("would_enter").notNull(),
    entryOffer: doublePrecision("entry_offer"),
    reason: text("reason").notNull(),
    executionAuthority: boolean("execution_authority").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("v13_strategy_shadow_eval_source_parameter_unique")
      .on(table.sourceEvaluationId, table.parameterSetId),
    index("v13_strategy_shadow_eval_parameter_chronological")
      .on(table.parameterSetId, table.evaluatedAt, table.id),
    check("v13_strategy_shadow_eval_hash_check",
      sql`${table.parameterHash} ~ '^[0-9a-f]{64}$'`),
    check("v13_strategy_shadow_eval_signal_check",
      sql`${table.signal} IN ('PASS','WATCH','SCOUT','CONFIRM','EXIT')`),
    check("v13_strategy_shadow_eval_direction_check",
      sql`${table.direction} IN ('UP','DOWN','NONE')`),
    check("v13_strategy_shadow_eval_no_execution_authority",
      sql`${table.executionAuthority} = false`),
    check("v13_strategy_shadow_eval_entry_check", sql`
      ${table.wouldEnter} = false OR (
        ${table.firstCross} = true AND
        ${table.qualifyingTrigger} = true AND
        ${table.signal} IN ('SCOUT','CONFIRM') AND
        ${table.direction} IN ('UP','DOWN') AND
        ${table.entryOffer} IS NOT NULL
      )
    `),
  ],
);

export const insertV13StrategyShadowEvaluationSchema =
  createInsertSchema(v13StrategyShadowEvaluationTable);
export type V13StrategyShadowEvaluation =
  typeof v13StrategyShadowEvaluationTable.$inferSelect;
export type InsertV13StrategyShadowEvaluation =
  z.infer<typeof insertV13StrategyShadowEvaluationSchema>;
