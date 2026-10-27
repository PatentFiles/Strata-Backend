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
-- These new columns are part of the immutable approval identity. The legacy
-- release_guard trigger predates these columns, so protect them explicitly.
CREATE OR REPLACE FUNCTION private.strata_standing_release_scope_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF ROW(NEW.standing_execution_account_id,NEW.standing_policy_hash,NEW.standing_stake_cents)
    IS DISTINCT FROM
    ROW(OLD.standing_execution_account_id,OLD.standing_policy_hash,OLD.standing_stake_cents)
 THEN
  RAISE EXCEPTION 'standing release scope is immutable; revoke instead'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS strata_standing_release_scope_guard
 ON private.strata_protective_exit_release;
CREATE TRIGGER strata_standing_release_scope_guard
 BEFORE UPDATE OF standing_execution_account_id,standing_policy_hash,standing_stake_cents
 ON private.strata_protective_exit_release FOR EACH ROW
 EXECUTE FUNCTION private.strata_standing_release_scope_immutable();
REVOKE ALL ON FUNCTION private.strata_standing_release_scope_immutable()
 FROM PUBLIC,anon,authenticated;

COMMIT;
