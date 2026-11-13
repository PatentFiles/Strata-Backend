import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const forwardTestEngineTable = pgTable("forward_test_engine", {
  id: text("id").primaryKey(),
  strategyVersion: text("strategy_version").notNull().default("V1.3"),
  enabled: boolean("enabled").notNull().default(false),
  mode: text("mode").notNull().default("PAPER_ONLY"),
  leaseOwner: text("lease_owner"),
  leaseEpoch: integer("lease_epoch").notNull().default(0),
  leaseAcquiredAt: timestamp("lease_acquired_at", { withTimezone: true }),
  leaseRenewedAt: timestamp("lease_renewed_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  workerStartedAt: timestamp("worker_started_at", { withTimezone: true }),
  lastAttemptedCycleAt: timestamp("last_attempted_cycle_at", { withTimezone: true }),
  lastSuccessfulCycleAt: timestamp("last_successful_cycle_at", { withTimezone: true }),
  cycleCount: integer("cycle_count").notNull().default(0),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  lastMarketPollAt: timestamp("last_market_poll_at", { withTimezone: true }),
  lastEvaluationAt: timestamp("last_evaluation_at", { withTimezone: true }),
  marketTicker: text("market_ticker"),
  signal: text("signal"),
  direction: text("direction"),
  signedBuffer: doublePrecision("signed_buffer"),
  btcPrice: doublePrecision("btc_price"),
  target: doublePrecision("target"),
  upOffer: doublePrecision("up_offer"),
  downOffer: doublePrecision("down_offer"),
  currentReason: text("current_reason"),
  lastTriggerType: text("last_trigger_type"),
  lastTriggerAt: timestamp("last_trigger_at", { withTimezone: true }),
  markPrice: doublePrecision("mark_price"),
  unrealizedPnl: doublePrecision("unrealized_pnl"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check("forward_test_engine_version_check", sql`${table.strategyVersion} = 'V1.3'`),
  check("forward_test_engine_mode_check", sql`${table.mode} = 'PAPER_ONLY'`),
  uniqueIndex("forward_test_one_enabled_v13").on(table.strategyVersion).where(sql`${table.enabled} = true`),
]);

export const insertForwardTestEngineSchema = createInsertSchema(forwardTestEngineTable);
export type ForwardTestEngine = typeof forwardTestEngineTable.$inferSelect;
export type InsertForwardTestEngine = z.infer<typeof insertForwardTestEngineSchema>;