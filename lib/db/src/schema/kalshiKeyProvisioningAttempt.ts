import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Only non-secret one-shot coordination data belongs in this table.
export const kalshiKeyProvisioningAttemptTable = pgTable("kalshi_key_provisioning_attempts", {
  attemptId: uuid("attempt_uuid").primaryKey(),
  keyName: text("key_name").notNull(),
  subaccount: integer("subaccount").notNull(),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  state: text("state").notNull(),
  recoveryConfirmedAt: timestamp("recovery_confirmed_at", { withTimezone: true }),
  recoveryReason: text("recovery_reason"),
}, (table) => [
  unique("kalshi_key_provisioning_name_unique").on(table.keyName),
  check("kalshi_key_provisioning_state_check",
    sql`${table.state} IN ('prepared', 'attempted', 'response_received', 'handoff_confirmed', 'handoff_recovered_verified', 'uncertain')`),
  check("kalshi_key_provisioning_recovery_check",
    sql`(${table.state} = 'handoff_recovered_verified') = (${table.recoveryConfirmedAt} IS NOT NULL AND ${table.recoveryReason} IS NOT NULL)`),
]);

export const insertKalshiKeyProvisioningAttemptSchema =
  createInsertSchema(kalshiKeyProvisioningAttemptTable);
export type KalshiKeyProvisioningAttempt =
  typeof kalshiKeyProvisioningAttemptTable.$inferSelect;
export type InsertKalshiKeyProvisioningAttempt =
  z.infer<typeof insertKalshiKeyProvisioningAttemptSchema>;