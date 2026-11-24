-- REVIEW ONLY. Records explicit, owner-scoped technical plan approval at the
-- existing prepared -> attempted claim. No transfer, key, account, or order.
-- Existing journal rows and separately reviewed operation routes remain valid.
BEGIN;
ALTER TABLE private.kalshi_account_operation_attempts
 ADD COLUMN owner_technical_plan_digest text,
 ADD COLUMN owner_technical_authorized_at timestamptz,
 ADD CONSTRAINT kalshi_account_operation_owner_technical_approval_check CHECK (
  (owner_technical_plan_digest IS NULL AND owner_technical_authorized_at IS NULL)
  OR (owner_technical_plan_digest ~ '^[a-f0-9]{64}$' AND owner_technical_authorized_at IS NOT NULL)
 );
COMMIT;
