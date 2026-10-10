import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  doublePrecision,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const paperHistoryTable = pgTable(
  "paper_history",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull(),
    openedAt: doublePrecision("opened_at").notNull(),
    closedAt: doublePrecision("closed_at"),
    entryPrice: doublePrecision("entry_price").notNull(),
    exitPrice: doublePrecision("exit_price"),
    stake: doublePrecision("stake").notNull(),
    pnl: doublePrecision("pnl"),
    reason: text("reason"),
    ticker: text("ticker").notNull(),
    target: doublePrecision("target"),
    entrySignal: text("entry_signal"),
    entryTime: doublePrecision("entry_time").notNull(),
    entryBtcPrice: doublePrecision("entry_btc_price"),
    entryKalshiPrice: doublePrecision("entry_kalshi_price").notNull(),
    entryBuffer: doublePrecision("entry_buffer"),
    entryVelocity: doublePrecision("entry_velocity"),
    outcome: text("outcome"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })],
);

export const liveTradesTable = pgTable(
  "live_trades",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    ticker: text("ticker").notNull(),
    direction: text("direction").notNull(),
    scoutStake: doublePrecision("scout_stake").notNull(),
    scoutEntryPrice: doublePrecision("scout_entry_price").notNull(),
    addStake: doublePrecision("add_stake").notNull(),
    addEntryPrice: doublePrecision("add_entry_price"),
    exitPrice: doublePrecision("exit_price"),
    fees: doublePrecision("fees").notNull(),
    pnl: doublePrecision("pnl"),
    status: text("status").notNull(),
    openedAt: doublePrecision("opened_at").notNull(),
    closedAt: doublePrecision("closed_at"),
    closeReason: text("close_reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    uniqueIndex("live_trades_one_open_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'open'`),
  ],
);

export const liveEventsTable = pgTable(
  "live_events",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    action: text("action").notNull(),
    ticker: text("ticker").notNull(),
    direction: text("direction"),
    signal: text("signal").notNull(),
    createdAt: doublePrecision("created_at").notNull(),
    note: text("note").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })],
);

export const insertPaperHistorySchema = createInsertSchema(paperHistoryTable);
export const insertLiveTradeSchema = createInsertSchema(liveTradesTable);
export const insertLiveEventSchema = createInsertSchema(liveEventsTable);

export type InsertPaperHistory = z.infer<typeof insertPaperHistorySchema>;
export type PaperHistory = typeof paperHistoryTable.$inferSelect;
export type InsertLiveTrade = z.infer<typeof insertLiveTradeSchema>;
export type LiveTradeRecord = typeof liveTradesTable.$inferSelect;
export type InsertLiveEvent = z.infer<typeof insertLiveEventSchema>;
export type LiveEventRecord = typeof liveEventsTable.$inferSelect;