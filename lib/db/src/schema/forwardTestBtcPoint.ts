import { index, pgTable, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// The browser retains its velocity ticks for 120 seconds; these samples
// preserve the same 30-second velocity input across worker restarts.
export const forwardTestBtcPointTable = pgTable("forward_test_btc_points", {
  id: text("id").primaryKey(),
  engineId: text("engine_id").notNull(),
  price: doublePrecision("price").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("forward_test_btc_points_time").on(table.engineId, table.observedAt),
]);

export const insertForwardTestBtcPointSchema = createInsertSchema(forwardTestBtcPointTable);
export type ForwardTestBtcPoint = typeof forwardTestBtcPointTable.$inferSelect;
export type InsertForwardTestBtcPoint = z.infer<typeof insertForwardTestBtcPointSchema>;