import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const forwardTestEvaluationTable = pgTable("forward_test_evaluations", {
  id: text("id").primaryKey(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
  strategyVersion: text("strategy_version").notNull().default("V1.3"),
  // Unknown historical identity stays NULL. Only new evaluations supply it.
  strategyParameterSetId: text("strategy_parameter_set_id"),
  strategyParameterHash: text("strategy_parameter_hash"),
  entryPolicyVersion: text("entry_policy_version"),
  marketTicker: text("market_ticker").notNull(),
  btcPrice: doublePrecision("btc_price").notNull(),
  target: doublePrecision("target").notNull(),
  signedBuffer: doublePrecision("signed_buffer").notNull(),
  absoluteBuffer: doublePrecision("absolute_buffer").notNull(),
  velocity: doublePrecision("velocity"),
  upBid: doublePrecision("up_bid"),
  upOffer: doublePrecision("up_offer"),
  downBid: doublePrecision("down_bid"),
  downOffer: doublePrecision("down_offer"),
  upSpread: doublePrecision("up_spread"),
  downSpread: doublePrecision("down_spread"),
  btcProviderAgeMs: doublePrecision("btc_provider_age_ms"),
  btcReceiveAgeMs: doublePrecision("btc_receive_age_ms"),
  marketAgeMs: doublePrecision("market_age_ms"),
  secondsRemaining: integer("seconds_remaining"),
  feedFreshness: text("feed_freshness").notNull(),
  previousSide: text("previous_side"),
  currentSide: text("current_side"),
  freshCross: boolean("fresh_cross").notNull(),
  crossingConsumed: boolean("crossing_consumed").notNull(),
  crossingKey: text("crossing_key"),
  signal: text("signal").notNull(),
  direction: text("direction").notNull(),
  qualifyingTrigger: boolean("qualifying_trigger").notNull(),
  reason: text("reason").notNull(),
  entryOffer: doublePrecision("entry_offer"),
  positionWasOpen: boolean("position_was_open").notNull(),
  evaluationSource: text("evaluation_source").notNull().default("paper"),
  livePositionId: text("live_position_id"),
  sourcePaperEvaluationId: text("source_paper_evaluation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("forward_test_evaluations_chronological").on(table.evaluatedAt, table.id),
  check("forward_test_evaluations_version_check", sql`${table.strategyVersion} = 'V1.3'`),
  check("forward_test_evaluations_parameter_identity_check", sql`
    (${table.strategyParameterSetId} IS NULL AND ${table.strategyParameterHash} IS NULL) OR
    (${table.strategyParameterSetId} IS NOT NULL AND ${table.strategyParameterHash} IS NOT NULL AND (
      (
        ${table.strategyParameterSetId} = 'v13-champion-1' AND
        ${table.strategyParameterHash} =
          '4e7359265d7f6100f3f395658fff005260ee18075adfb8942d6020c20ba7d65f'
      ) OR (
        ${table.strategyParameterSetId} = 'v13-champion-2-c52-confirm53' AND
        ${table.strategyParameterHash} =
          '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161'
      )
    ))
  `),
  check("forward_test_evaluations_direction_check", sql`${table.direction} IN ('UP','DOWN','NONE')`),
  check("forward_test_evaluations_signal_check", sql`${table.signal} IN ('PASS','WATCH','SCOUT','CONFIRM','EXIT')`),
  check("forward_test_evaluations_quality_check", sql`
    (${table.upSpread} IS NULL OR (${table.upSpread} >= 0 AND ${table.upSpread} <= 1)) AND
    (${table.downSpread} IS NULL OR (${table.downSpread} >= 0 AND ${table.downSpread} <= 1)) AND
    (${table.btcProviderAgeMs} IS NULL OR ${table.btcProviderAgeMs} >= 0) AND
    (${table.btcReceiveAgeMs} IS NULL OR ${table.btcReceiveAgeMs} >= 0) AND
    (${table.marketAgeMs} IS NULL OR ${table.marketAgeMs} >= 0)
  `),
  check("forward_test_evaluations_live_source_check", sql`
    (${table.evaluationSource} = 'paper' AND ${table.livePositionId} IS NULL AND
      ${table.sourcePaperEvaluationId} IS NULL) OR
    (${table.evaluationSource} = 'micro_live' AND ${table.positionWasOpen} = true AND
      ${table.livePositionId} IS NOT NULL AND ${table.livePositionId} <> '' AND
      ${table.sourcePaperEvaluationId} IS NOT NULL AND ${table.sourcePaperEvaluationId} <> '')
  `),
]);

export const insertForwardTestEvaluationSchema = createInsertSchema(forwardTestEvaluationTable);
export type ForwardTestEvaluation = typeof forwardTestEvaluationTable.$inferSelect;
export type InsertForwardTestEvaluation = z.infer<typeof insertForwardTestEvaluationSchema>;