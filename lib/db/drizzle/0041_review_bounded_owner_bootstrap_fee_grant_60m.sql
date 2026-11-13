-- Issue #165: bounded bootstrap authorization window.
-- Owner-specific grants remain genuine technical ADMIN actions, distinct from
-- the owner consent and the exact policy migration. No consent/grant is created,
-- extended, backdated, revoked or used to authorize execution by this DDL.
-- Fresh official exchange fee observations, signed cash, revocations, live
-- protected exits, independent reviewers and owner MFA remain enforced.
-- Deliberately capped at 60m AND at issuer's current 2h review expiration.
-- A separate existing standing authorization path handles ongoing 15m refreshes.
BEGIN;
SET LOCAL lock_timeout = '3000ms';
SET LOCAL statement_timeout = '15000ms';
ALTER TABLE private.strata_api_fee_source_grants
  DROP CONSTRAINT IF EXISTS strata_api_fee_source_grants_check1;
ALTER TABLE private.strata_api_fee_source_grants
  ADD CONSTRAINT strata_api_fee_source_grants_bounded_bootstrap_ttl
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '60 minutes');
COMMIT;
