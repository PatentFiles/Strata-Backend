import { sql } from "drizzle-orm";
import { check, doublePrecision, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const forwardTestPositionTable = pgTable("forward_test_positions", {
  id: text("id").primaryKey(),
  engineId: text("engine_id").notNull(),
  marketTicker: text("market_ticker").notNull(),
  crossingKey: text("crossing_key").notNull(),
  strategyVersion: text("strategy_version").notNull().default("V1.3"),
  // Never relabel old positions as the new champion during a schema upgrade.
  strategyParameterSetId: text("strategy_parameter_set_id"),
  strategyParameterHash: text("strategy_parameter_hash"),
  entryPolicyVersion: text("entry_policy_version"),
  direction: text("direction").notNull(),
  triggerType: text("trigger_type").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
  entryOffer: doublePrecision("entry_offer").notNull(),
  entryBid: doublePrecision("entry_bid"),
  entrySpread: doublePrecision("entry_spread"),
  entrySecondsRemaining: doublePrecision("entry_seconds_remaining"),
  entryBtcProviderAgeMs: doublePrecision("entry_btc_provider_age_ms"),
  entryBtcReceiveAgeMs: doublePrecision("entry_btc_receive_age_ms"),
  entryMarketAgeMs: doublePrecision("entry_market_age_ms"),
  stake: doublePrecision("stake").notNull(),
  contracts: doublePrecision("contracts").notNull(),
  target: doublePrecision("target").notNull(),
  entryBtcPrice: doublePrecision("entry_btc_price").notNull(),
  entryBuffer: doublePrecision("entry_buffer").notNull(),
  entryVelocity: doublePrecision("entry_velocity"),
  status: text("status").notNull().default("OPEN"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  exitPrice: doublePrecision("exit_price"),
  closeReason: text("close_reason"),
  settlementResult: text("settlement_result"),
  payout: doublePrecision("payout"),
  pnl: doublePrecision("pnl"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("forward_test_one_action_per_cross").on(table.marketTicker, table.crossingKey, table.triggerType),
  uniqueIndex("forward_test_one_open_per_engine").on(table.engineId).where(sql`${table.status} = 'OPEN'`),
  check("forward_test_positions_version_check", sql`${table.strategyVersion} = 'V1.3'`),
  check("forward_test_positions_parameter_identity_check", sql`
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
  check("forward_test_positions_direction_check", sql`${table.direction} IN ('UP','DOWN')`),
  check("forward_test_positions_trigger_check", sql`${table.triggerType} IN ('SCOUT','CONFIRM')`),
  check("forward_test_positions_status_check", sql`${table.status} IN ('OPEN','SETTLED','CLOSED')`),
  check("forward_test_positions_amount_check", sql`
    ${table.entryOffer} > 0 AND ${table.entryOffer} <= 1 AND
    (${table.entryBid} IS NULL OR (${table.entryBid} >= 0 AND ${table.entryBid} <= 1)) AND
    (${table.entrySpread} IS NULL OR (${table.entrySpread} >= 0 AND ${table.entrySpread} <= 1)) AND
    (${table.entrySecondsRemaining} IS NULL OR ${table.entrySecondsRemaining} >= 0) AND
    (${table.entryBtcProviderAgeMs} IS NULL OR ${table.entryBtcProviderAgeMs} >= 0) AND
    (${table.entryBtcReceiveAgeMs} IS NULL OR ${table.entryBtcReceiveAgeMs} >= 0) AND
    (${table.entryMarketAgeMs} IS NULL OR ${table.entryMarketAgeMs} >= 0) AND
    ${table.stake} > 0 AND ${table.contracts} > 0
  `),
]);

export const insertForwardTestPositionSchema = createInsertSchema(forwardTestPositionTable);
export type ForwardTestPosition = typeof forwardTestPositionTable.$inferSelect;
export type InsertForwardTestPosition = z.infer<typeof insertForwardTestPositionSchema>;