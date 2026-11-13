import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** One irreversible owner-authorized transfer attempt for the dedicated (1, 2) pair. */
export const microLivePairFundingAttemptTable = pgTable("micro_live_pair_funding_attempts", {
  attemptId: uuid("attempt_uuid").primaryKey(),
  sourceSubaccount: integer("source_subaccount").notNull(),
  destinationSubaccount: integer("destination_subaccount").notNull(),
  exchangeIndex: integer("exchange_index").notNull(),
  amountCents: integer("amount_cents").notNull(),
  marketTicker: text("market_ticker").notNull(),
  state: text("state").notNull(),
  sourceScopedBeforeMicros: text("source_scoped_before_micros").notNull(),
  sourceInventoryBeforeMicros: text("source_inventory_before_micros").notNull(),
  cleanBoundaryDigest: text("clean_boundary_digest").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  responseReceivedAt: timestamp("response_received_at", { withTimezone: true }),
  transferId: text("transfer_id"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
}, table => [
  unique("micro_live_pair_funding_target_unique")
    .on(table.destinationSubaccount, table.exchangeIndex),
  check("micro_live_pair_funding_exact_intent_check", sql`
    ${table.sourceSubaccount} = 0 AND ${table.destinationSubaccount} = 1 AND
    ${table.exchangeIndex} = 2 AND ${table.amountCents} = 2500 AND
    ${table.marketTicker} ~ '^KXBTC15M-[A-Za-z0-9-]+$' AND
    ${table.sourceScopedBeforeMicros} ~ '^[0-9]+$' AND
    ${table.sourceInventoryBeforeMicros} ~ '^[0-9]+$' AND
    ${table.cleanBoundaryDigest} ~ '^[0-9a-f]{64}$' AND
    isfinite(${table.attemptedAt}) AND
    ${table.state} IN ('attempted', 'uncertain', 'response_received', 'reconciled') AND
    (${table.transferId} IS NULL OR ${table.transferId} ~ '^[A-Za-z0-9._:-]{1,128}$') AND
    (${table.state} <> 'reconciled' OR
      (${table.transferId} IS NOT NULL AND ${table.reconciledAt} IS NOT NULL))
  `),
]);

export const insertMicroLivePairFundingAttemptSchema =
  createInsertSchema(microLivePairFundingAttemptTable);
export type MicroLivePairFundingAttempt =
  typeof microLivePairFundingAttemptTable.$inferSelect;
export type InsertMicroLivePairFundingAttempt =
  z.infer<typeof insertMicroLivePairFundingAttemptSchema>;