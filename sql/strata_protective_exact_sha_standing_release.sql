-- Staged migration for explicit until-revoked exact-SHA owner+independent releases.
-- Does not insert a release, refresh an approval, alter worker state or trade.
-- Install only during a reviewed flat-account code rotation, before new backend.
BEGIN;
ALTER TABLE private.strata_protective_exit_release
  ADD COLUMN IF NOT EXISTS standing_execution_account_id text
    REFERENCES public.v13_production_account(id),
  ADD COLUMN IF NOT EXISTS standing_policy_hash text,
  ADD COLUMN IF NOT EXISTS standing_stake_cents integer;
ALTER TABLE private.strata_protective_exit_release
  DROP CONSTRAINT IF EXISTS protective_exit_bounded_release;
ALTER TABLE private.strata_protective_exit_release
  ADD CONSTRAINT protective_exit_bounded_release CHECK (
    (expires_at > created_at AND expires_at <= created_at + interval '24 hours'
      AND standing_execution_account_id IS NULL
      AND standing_policy_hash IS NULL
      AND standing_stake_cents IS NULL)
    OR
    (expires_at = 'infinity'::timestamptz
      AND standing_execution_account_id IS NOT NULL
      AND standing_policy_hash ~ '^[0-9a-f]{64}$'
      AND standing_stake_cents BETWEEN 1 AND 100000)
  );
COMMENT ON COLUMN private.strata_protective_exit_release.standing_policy_hash
IS 'Present only after fresh independently reviewed exact-SHA release and explicit AAL2 opt-in; revocation, SHA/policy/stake change fail closed on every signed snapshot.';
COMMIT;
