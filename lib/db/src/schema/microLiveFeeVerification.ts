import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Durable, per-approval fee-verification fence. `pending` deliberately has no
 * expiry: a crash during an evidence read cannot silently restore eligibility.
 */
export const microLiveFeeVerificationTable = pgTable("micro_live_fee_verification", {
  approvalId: text("approval_id").primaryKey(),
  approvalDigest: text("approval_digest").notNull(),
  policyVersion: text("policy_version").notNull(),
  sourceUrl: text("source_url").notNull(),
  formulaVersion: text("formula_version").notNull(),
  status: text("status").notNull(),
  attemptId: text("attempt_id"),
  reason: text("reason"),
  feeEvidenceFingerprint: text("fee_evidence_fingerprint"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("micro_live_fee_verification_status_check", sql`
    ${table.status} IN ('pending', 'verified', 'unavailable', 'invalid')
  `),
  check("micro_live_fee_verification_attempt_check", sql`
    (${table.status} = 'pending' AND ${table.attemptId} IS NOT NULL) OR
    (${table.status} <> 'pending' AND ${table.attemptId} IS NULL)
  `),
  check("micro_live_fee_verification_identity_check", sql`
    ${table.approvalDigest} ~ '^[0-9a-f]{64}$' AND
    btrim(${table.approvalId}) <> '' AND
    btrim(${table.policyVersion}) <> '' AND
    btrim(${table.sourceUrl}) <> '' AND
    btrim(${table.formulaVersion}) <> ''
  `),
  check("micro_live_fee_verification_verified_evidence_check", sql`
    ${table.status} <> 'verified' OR (
      ${table.checkedAt} IS NOT NULL AND
      isfinite(${table.checkedAt}) AND
      ${table.feeEvidenceFingerprint} IS NOT NULL AND
      btrim(${table.feeEvidenceFingerprint}) <> ''
    )
  `),
]);

export type MicroLiveFeeVerification =
  typeof microLiveFeeVerificationTable.$inferSelect;