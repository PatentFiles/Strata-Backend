import { sql } from "drizzle-orm";
import {
  check, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * One-shot coordination for the dedicated MICRO_LIVE (1, 2) restricted key.
 * This is intentionally separate from the historical subaccount-1 key record.
 * It stores no private-key material.
 */
export const microLivePairKeyProvisioningAttemptTable = pgTable(
  "micro_live_pair_key_provisioning_attempts",
  {
    attemptId: uuid("attempt_uuid").primaryKey(),
    keyName: text("key_name").notNull(),
    subaccount: integer("subaccount").notNull(),
    exchangeIndex: integer("exchange_index").notNull(),
    scopes: text("scopes").array().notNull(),
    creationAttemptId: text("creation_attempt_id").notNull(),
    cleanBoundaryEvidenceDigest: text("clean_boundary_evidence_digest").notNull(),
    keyId: text("key_id"),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    responseReceivedAt: timestamp("response_received_at", { withTimezone: true }),
    metadataVerifiedAt: timestamp("metadata_verified_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("micro_live_pair_key_attempt_pair_unique")
      .on(table.subaccount, table.exchangeIndex),
    uniqueIndex("micro_live_pair_key_attempt_name_unique").on(table.keyName),
    uniqueIndex("micro_live_pair_key_attempt_key_id_unique").on(table.keyId),
    check("micro_live_pair_key_attempt_identity_check", sql`
      ${table.keyName} = 'MICRO_LIVE_INDEX2_SUBACCOUNT_1' AND
      ${table.subaccount} = 1 AND ${table.exchangeIndex} = 2 AND
      ${table.scopes} = ARRAY['read', 'write::trade']::text[] AND
      btrim(${table.creationAttemptId}) <> '' AND
      ${table.cleanBoundaryEvidenceDigest} ~ '^[0-9a-f]{64}$' AND
      (${table.keyId} IS NULL OR
        (btrim(${table.keyId}) <> '' AND length(${table.keyId}) <= 256))
    `),
    check("micro_live_pair_key_attempt_state_check", sql`
      ${table.state} IN (
        'prepared', 'attempted', 'response_received', 'metadata_verified',
        'handoff_confirmed', 'uncertain'
      )
    `),
    check("micro_live_pair_key_attempt_transitions_check", sql`
      (
        ${table.state} = 'prepared' AND
        ${table.attemptedAt} IS NULL AND
        ${table.responseReceivedAt} IS NULL AND
        ${table.metadataVerifiedAt} IS NULL AND
        ${table.confirmedAt} IS NULL AND ${table.keyId} IS NULL
      ) OR (
        ${table.state} = 'attempted' AND
        ${table.attemptedAt} IS NOT NULL AND
        ${table.responseReceivedAt} IS NULL AND
        ${table.metadataVerifiedAt} IS NULL AND
        ${table.confirmedAt} IS NULL AND ${table.keyId} IS NULL
      ) OR (
        ${table.state} = 'uncertain' AND
        ${table.attemptedAt} IS NOT NULL AND
        ${table.responseReceivedAt} IS NULL AND
        ${table.metadataVerifiedAt} IS NULL AND
        ${table.confirmedAt} IS NULL AND ${table.keyId} IS NULL
      ) OR (
        ${table.state} = 'response_received' AND
        ${table.attemptedAt} IS NOT NULL AND
        ${table.responseReceivedAt} IS NOT NULL AND
        ${table.metadataVerifiedAt} IS NULL AND
        ${table.confirmedAt} IS NULL AND ${table.keyId} IS NOT NULL
      ) OR (
        ${table.state} = 'metadata_verified' AND
        ${table.attemptedAt} IS NOT NULL AND
        ${table.responseReceivedAt} IS NOT NULL AND
        ${table.metadataVerifiedAt} IS NOT NULL AND
        ${table.confirmedAt} IS NULL AND ${table.keyId} IS NOT NULL
      ) OR (
        ${table.state} = 'handoff_confirmed' AND
        ${table.attemptedAt} IS NOT NULL AND
        ${table.responseReceivedAt} IS NOT NULL AND
        ${table.confirmedAt} IS NOT NULL AND ${table.keyId} IS NOT NULL
      )
    `),
  ],
);

export const insertMicroLivePairKeyProvisioningAttemptSchema =
  createInsertSchema(microLivePairKeyProvisioningAttemptTable);
export type MicroLivePairKeyProvisioningAttempt =
  typeof microLivePairKeyProvisioningAttemptTable.$inferSelect;
export type InsertMicroLivePairKeyProvisioningAttempt =
  z.infer<typeof insertMicroLivePairKeyProvisioningAttemptSchema>;