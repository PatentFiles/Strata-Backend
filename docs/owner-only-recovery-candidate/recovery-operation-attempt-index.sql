-- Offline candidate prerequisite for bounded account-scoped pending work reads.
-- Not applied to production. Deployment must use an approved online migration.
CREATE INDEX IF NOT EXISTS kalshi_operation_unresolved_financial_idx
ON private.kalshi_account_operation_attempts(financial_account_id)
WHERE state IS NULL OR state NOT IN ('completed','cancelled');
