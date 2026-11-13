import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const liveProposedOrderTable = pgTable("live_proposed_orders", {
  id: text("id").primaryKey(),
  marketTicker: text("market_ticker").notNull(),
  crossingKey: text("crossing_key").notNull(),
  triggerType: text("trigger_type").notNull(),
  direction: text("direction").notNull(),
  sourceEvaluationId: text("source_evaluation_id").notNull(),
  quotePrice: doublePrecision("quote_price"),
  proposedLimitPrice: doublePrecision("proposed_limit_price"),
  contracts: integer("contracts").notNull().default(0),
  intendedStake: doublePrecision("intended_stake").notNull().default(0),
  simulatedRemainingCapital: doublePrecision("simulated_remaining_capital"),
  status: text("status").notNull(),
  riskVerdict: text("risk_verdict").notNull(),
  riskReason: text("risk_reason").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("live_proposed_orders_action_key").on(table.marketTicker, table.crossingKey, table.triggerType),
  index("live_proposed_orders_recorded_at").on(table.recordedAt),
  check("live_proposed_orders_trigger_check", sql`${table.triggerType} IN ('SCOUT','CONFIRM')`),
  check("live_proposed_orders_direction_check", sql`${table.direction} IN ('UP','DOWN')`),
  check("live_proposed_orders_status_check", sql`${table.status} IN ('PROPOSED','BLOCKED')`),
  check("live_proposed_orders_risk_check", sql`${table.riskVerdict} IN ('ALLOW','BLOCK')`),
  check("live_proposed_orders_amount_check", sql`${table.contracts} >= 0 AND ${table.intendedStake} >= 0 AND (${table.quotePrice} IS NULL OR (${table.quotePrice} > 0 AND ${table.quotePrice} <= 1)) AND (${table.proposedLimitPrice} IS NULL OR (${table.proposedLimitPrice} > 0 AND ${table.proposedLimitPrice} <= 1)) AND (${table.simulatedRemainingCapital} IS NULL OR ${table.simulatedRemainingCapital} >= 0)`),
]);

export const insertLiveProposedOrderSchema = createInsertSchema(liveProposedOrderTable);
export type LiveProposedOrder = typeof liveProposedOrderTable.$inferSelect;
export type InsertLiveProposedOrder = z.infer<typeof insertLiveProposedOrderSchema>;