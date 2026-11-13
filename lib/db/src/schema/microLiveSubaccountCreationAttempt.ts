import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Durable, development-only one-shot coordination for creating the (N, 2)
 * subaccount. The unique target index prevents a second attempt from being
 * created even after an API process restart.
 */
export const microLiveSubaccountCreationAttemptTable = pgTable(
  "micro_live_subaccount_creation_attempts",
  {
    attemptId: uuid("attempt_uuid").primaryKey(),
    targetExchangeIndex: integer("target_exchange_index").notNull(),
    prePostInventoryDigest: text("pre_post_inventory_digest").notNull(),
    prePostInventory: jsonb("pre_post_inventory").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    state: text("state").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    responseReceivedAt: timestamp("response_received_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    subaccountNumber: integer("subaccount_number"),
    responseStatus: integer("response_status"),
    responseMetadata: jsonb("response_metadata"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("micro_live_subaccount_creation_target_unique")
      .on(table.targetExchangeIndex),
    check("micro_live_subaccount_creation_target_check",
      sql`${table.targetExchangeIndex} = 2`),
    check("micro_live_subaccount_creation_digest_check",
      sql`${table.prePostInventoryDigest} ~ '^[0-9a-f]{64}$'`),
    check("micro_live_subaccount_creation_state_check",
      sql`${table.state} IN ('reserved', 'attempted', 'response_received', 'verified', 'uncertain')`),
    check("micro_live_subaccount_creation_subaccount_check",
      sql`${table.subaccountNumber} IS NULL OR ${table.subaccountNumber} BETWEEN 1 AND 63`),
    check("micro_live_subaccount_creation_timestamps_check", sql`
      (${table.state} = 'reserved' AND ${table.attemptedAt} IS NULL AND
        ${table.responseReceivedAt} IS NULL AND ${table.verifiedAt} IS NULL AND
        ${table.subaccountNumber} IS NULL AND ${table.responseStatus} IS NULL) OR
      (${table.state} = 'attempted' AND ${table.attemptedAt} IS NOT NULL AND
        ${table.responseReceivedAt} IS NULL AND ${table.verifiedAt} IS NULL AND
        ${table.subaccountNumber} IS NULL AND ${table.responseStatus} IS NULL) OR
      (${table.state} = 'uncertain' AND ${table.attemptedAt} IS NOT NULL AND
        ${table.verifiedAt} IS NULL) OR
      (${table.state} = 'response_received' AND ${table.attemptedAt} IS NOT NULL AND
        ${table.responseReceivedAt} IS NOT NULL AND ${table.subaccountNumber} IS NOT NULL AND
        ${table.responseStatus} = 201 AND ${table.verifiedAt} IS NULL) OR
      (${table.state} = 'verified' AND ${table.attemptedAt} IS NOT NULL AND
        ${table.verifiedAt} IS NOT NULL AND ${table.subaccountNumber} IS NOT NULL)
    `),
  ],
);

export const insertMicroLiveSubaccountCreationAttemptSchema =
  createInsertSchema(microLiveSubaccountCreationAttemptTable);
export type MicroLiveSubaccountCreationAttempt =
  typeof microLiveSubaccountCreationAttemptTable.$inferSelect;
export type InsertMicroLiveSubaccountCreationAttempt =
  z.infer<typeof insertMicroLiveSubaccountCreationAttemptSchema>;