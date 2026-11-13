import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { microLiveOrderTable } from "./microLiveOrder";

export const microLiveDecisionTable = pgTable("micro_live_decisions", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  evaluationId: text("evaluation_id"),
  orderId: text("order_id").references(() => microLiveOrderTable.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("micro_live_decisions_latest").on(table.decidedAt),
  index("micro_live_decisions_evaluation_id").on(table.evaluationId),
  index("micro_live_decisions_order_id").on(table.orderId),
  check("micro_live_decisions_status_check", sql`${table.status} IN ('ALLOW','BLOCK','ERROR')`),
]);

export const insertMicroLiveDecisionSchema = createInsertSchema(microLiveDecisionTable);
export type MicroLiveDecision = typeof microLiveDecisionTable.$inferSelect;
export type InsertMicroLiveDecision = z.infer<typeof insertMicroLiveDecisionSchema>;