-- Candidate-only; validate before production deployment.
-- The existing execution context requires exactly one Kalshi connection per
-- owner. Enforce this invariant across the old connector and new bootstrap.
-- A duplicate causes the migration to fail; never delete or reassign accounts.
BEGIN;
CREATE UNIQUE INDEX strata_one_kalshi_connection_per_owner
 ON public.financial_accounts (user_id) WHERE provider='kalshi';
COMMIT;
