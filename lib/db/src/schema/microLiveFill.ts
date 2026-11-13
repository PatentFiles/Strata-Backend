import { sql } from "drizzle-orm";
import { bigint, boolean, check, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { microLiveOrderTable } from "./microLiveOrder";

export const microLiveFillTable = pgTable("micro_live_fills", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => microLiveOrderTable.id),
  exchangeFillId: text("exchange_fill_id").notNull(),
  exchangeOrderId: text("exchange_order_id"),
  filledAt: timestamp("filled_at", { withTimezone: true }).notNull(),
  contracts: integer("contracts").notNull(),
  fillPrice: doublePrecision("fill_price").notNull(),
  action: text("action").notNull().default("buy"),
  positionId: text("position_id"),
  costCents: integer("cost_cents").notNull(),
  feeCents: integer("fee_cents").notNull().default(0),
  feeKnown: boolean("fee_known").notNull().default(false),
  // Exchange fill price/count and fee_cost are fixed-point dollars; retain
  // their six-decimal precision instead of rounding each fill to cents.
  tradeMicros: bigint("trade_micros", { mode: "number" }),
  feeMicros: bigint("fee_micros", { mode: "number" }),
  proceedsCents: integer("proceeds_cents"),
  costBasisCents: integer("cost_basis_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("micro_live_fills_exchange_fill_id_unique").on(table.exchangeFillId),
  index("micro_live_fills_order_filled_at").on(table.orderId, table.filledAt),
  check("micro_live_fills_amount_check", sql`
    ${table.contracts} > 0 AND ${table.costCents} >= 0 AND ${table.feeCents} >= 0
  `),
  check("micro_live_fills_action_check", sql`
    ${table.action} IN ('buy','sell') AND
    (${table.proceedsCents} IS NULL OR ${table.proceedsCents} >= 0) AND
    (${table.costBasisCents} IS NULL OR ${table.costBasisCents} >= 0) AND
    (${table.action} <> 'sell' OR (
      ${table.positionId} IS NOT NULL AND ${table.positionId} <> '' AND
      ${table.proceedsCents} IS NOT NULL AND
      ${table.costBasisCents} IS NOT NULL
    ))
  `),
  check("micro_live_fills_price_check", sql`${table.fillPrice} > 0 AND ${table.fillPrice} <= 1`),
  check("micro_live_fills_exact_amount_check", sql`
    (${table.tradeMicros} IS NULL OR ${table.tradeMicros} > 0) AND
    (${table.feeMicros} IS NULL OR ${table.feeMicros} >= 0)
  `),
]);

export const insertMicroLiveFillSchema = createInsertSchema(microLiveFillTable);
export type MicroLiveFill = typeof microLiveFillTable.$inferSelect;
export type InsertMicroLiveFill = z.infer<typeof insertMicroLiveFillSchema>;