import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Separate from the historical singleton's fee authorization. Approval alone
// cannot authorize arming or execution and cannot change the funded boundary.
export const microLivePairFeeApprovalTable = pgTable("micro_live_pair_fee_approval", {
  subaccountNumber: integer("subaccount_number").primaryKey(),
  exchangeIndex: integer("exchange_index").notNull(),
  priorRunId: text("prior_run_id").notNull(),
  restrictedApiKeyId: text("restricted_api_key_id").notNull(),
  restrictedKeyFingerprint: text("restricted_key_fingerprint").notNull(),
  fundingTransferId: text("funding_transfer_id").notNull(),
  fundingEvidenceDigest: text("funding_evidence_digest").notNull(),
  allInCapMicros: integer("all_in_cap_micros").notNull(),
  state: text("state").notNull().default("pending"),
  reviewId: text("review_id"),
  pdfDigest: text("pdf_digest"),
  reviewSource: text("review_source"),
  sourceAttestedBy: text("source_attested_by"),
  sourceAttestedAt: timestamp("source_attested_at", { withTimezone: true }),
  reviewExpiresAt: timestamp("review_expires_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("micro_live_pair_fee_approval_scope_check", sql`
    ${table.subaccountNumber} = 1 AND ${table.exchangeIndex} = 2 AND
    ${table.allInCapMicros} = 1000000 AND
    ${table.restrictedKeyFingerprint} ~ '^[0-9a-f]{64}$' AND
    ${table.fundingEvidenceDigest} ~ '^[0-9a-f]{64}$' AND
    ${table.state} IN ('pending', 'reviewed', 'approved') AND
    (${table.reviewSource} IS NULL OR ${table.reviewSource} IN
      ('server_fetched', 'owner_attested_http_429_2026_09_27')) AND
    ((${table.reviewSource} = 'server_fetched' AND
      ${table.sourceAttestedBy} IS NULL AND ${table.sourceAttestedAt} IS NULL) OR
     (${table.reviewSource} = 'owner_attested_http_429_2026_09_27' AND
      ${table.sourceAttestedBy} IS NOT NULL AND ${table.sourceAttestedAt} IS NOT NULL) OR
     (${table.reviewSource} IS NULL AND
      ${table.sourceAttestedBy} IS NULL AND ${table.sourceAttestedAt} IS NULL)) AND
    ((${table.state} = 'pending' AND ${table.reviewId} IS NULL AND
      ${table.pdfDigest} IS NULL AND ${table.reviewSource} IS NULL AND
      ${table.reviewExpiresAt} IS NULL AND
      ${table.approvedBy} IS NULL AND ${table.approvedAt} IS NULL) OR
     (${table.state} = 'reviewed' AND ${table.reviewId} IS NOT NULL AND
      ${table.pdfDigest} ~ '^[0-9a-f]{64}$' AND
       ${table.reviewSource} IS NOT NULL AND
      ${table.reviewExpiresAt} IS NOT NULL AND ${table.approvedBy} IS NULL AND
      ${table.approvedAt} IS NULL) OR
     (${table.state} = 'approved' AND ${table.reviewId} IS NOT NULL AND
      ${table.pdfDigest} ~ '^[0-9a-f]{64}$' AND
       ${table.reviewSource} IS NOT NULL AND
      ${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL))
  `),
]);

export const insertMicroLivePairFeeApprovalSchema = createInsertSchema(microLivePairFeeApprovalTable);
export type MicroLivePairFeeApproval = typeof microLivePairFeeApprovalTable.$inferSelect;
export type InsertMicroLivePairFeeApproval = z.infer<typeof insertMicroLivePairFeeApprovalSchema>;