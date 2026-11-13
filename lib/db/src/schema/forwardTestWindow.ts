import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const forwardTestWindowTable = pgTable("forward_test_windows", {
  ticker: text("ticker").primaryKey(),
  target: doublePrecision("target").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  previousSide: text("previous_side"),
  currentSide: text("current_side"),
  previousBuffer: doublePrecision("previous_buffer"),
  // No default/backfill: existing windows retain historical/unversioned policy.
  entryPolicyVersion: text("entry_policy_version"),
  firstCrossOccurred: boolean("first_cross_occurred").notNull().default(false),
  crossingConsumed: boolean("crossing_consumed").notNull().default(false),
  crossingKey: text("crossing_key"),
  crossingDirection: text("crossing_direction"),
  crossingAt: timestamp("crossing_at", { withTimezone: true }),
  scoutTriggered: boolean("scout_triggered").notNull().default(false),
  confirmTriggered: boolean("confirm_triggered").notNull().default(false),
  finalized: boolean("finalized").notNull().default(false),
  settlementResult: text("settlement_result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check("forward_test_windows_side_check", sql`(${table.previousSide} IS NULL OR ${table.previousSide} IN ('UP','DOWN','AT')) AND (${table.currentSide} IS NULL OR ${table.currentSide} IN ('UP','DOWN','AT'))`),
  check("forward_test_windows_cross_check", sql`${table.crossingDirection} IS NULL OR ${table.crossingDirection} IN ('UP','DOWN')`),
  check("forward_test_windows_result_check", sql`${table.settlementResult} IS NULL OR ${table.settlementResult} IN ('UP','DOWN','VOID')`),
]);

export const insertForwardTestWindowSchema = createInsertSchema(forwardTestWindowTable);
export type ForwardTestWindow = typeof forwardTestWindowTable.$inferSelect;
export type InsertForwardTestWindow = z.infer<typeof insertForwardTestWindowSchema>;