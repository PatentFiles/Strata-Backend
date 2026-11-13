import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** One exchange aggregate settlement per locally owned market/position. */
export const microLiveSettlementTable = pgTable("micro_live_settlements", {
  positionId: text("position_id").primaryKey(),
  marketTicker: text("market_ticker").notNull(),
  side: text("side").notNull(),
  marketResult: text("market_result").notNull(),
  contracts: integer("contracts").notNull(),
  payoutMicros: bigint("payout_micros", { mode: "number" }).notNull(),
  feeMicros: bigint("fee_micros", { mode: "number" }),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
  evidenceDigest: text("evidence_digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("micro_live_settlements_ticker_unique").on(table.marketTicker),
  check("micro_live_settlements_values_check", sql`
    ${table.side} IN ('UP','DOWN') AND ${table.marketResult} IN ('yes','no') AND
    ${table.contracts} > 0 AND ${table.payoutMicros} >= 0 AND
    (${table.feeMicros} IS NULL OR ${table.feeMicros} >= 0)
  `),
]);

export const insertMicroLiveSettlementSchema = createInsertSchema(microLiveSettlementTable);
export type MicroLiveSettlement = typeof microLiveSettlementTable.$inferSelect;
export type InsertMicroLiveSettlement = z.infer<typeof insertMicroLiveSettlementSchema>;