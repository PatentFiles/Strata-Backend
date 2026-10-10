import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// An append-only copy: the historical singleton and its ledger are never rewritten.
export const microLiveCommissioningArchiveTable = pgTable("micro_live_commissioning_archive", {
  priorRunId: text("prior_run_id").primaryKey(),
  phase: text("phase").notNull(),
  capMicros: integer("cap_micros").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  snapshotDigest: text("snapshot_digest").notNull(),
  archivedBy: text("archived_by").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("micro_live_commissioning_archive_frozen_check", sql`
    ${table.phase} = 'FROZEN' AND ${table.capMicros} = 1000000 AND
    ${table.snapshotDigest} ~ '^[0-9a-f]{64}$'
  `),
]);

export const insertMicroLiveCommissioningArchiveSchema =
  createInsertSchema(microLiveCommissioningArchiveTable);
export type MicroLiveCommissioningArchive = typeof microLiveCommissioningArchiveTable.$inferSelect;
export type InsertMicroLiveCommissioningArchive = z.infer<typeof insertMicroLiveCommissioningArchiveSchema>;