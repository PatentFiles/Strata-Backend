-- Candidate schema: explicit revocable same-binary owner standing authorization.
-- REVIEW/DEPLOY SEPARATELY. Creating this table does not authorize trading.
-- Enrollment must originate from a new authenticated AAL2 owner action after
-- an independent reviewer and an unexpired exact-SHA protective release.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_continuous_owner_authorizations (
 authorization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK(release_commit_sha ~ '^[0-9a-f]{40}$'),
 approved_policy_hash text NOT NULL CHECK(approved_policy_hash ~ '^[0-9a-f]{64}$'),
 approved_stake_cents integer NOT NULL CHECK(approved_stake_cents >= 500),
 approved_all_in_cents integer NOT NULL CHECK(approved_all_in_cents >= approved_stake_cents),
 source_release_id uuid NOT NULL REFERENCES private.strata_protective_exit_release(release_id),
 source_review_id uuid NOT NULL REFERENCES private.strata_protective_release_reviews(review_id),
 source_owner_approval_id uuid NOT NULL REFERENCES private.strata_owner_sha_approvals(approval_id),
 independent_reviewer_id uuid NOT NULL REFERENCES auth.users(id),
 confirmation text NOT NULL CHECK(confirmation='I_EXPLICITLY_AUTHORIZE_REVOCABLE_SAME_SHA_CONTINUOUS_EXECUTION_V1'),
 approved_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoked_reason text,
 CONSTRAINT strata_continuous_independent_reviewer CHECK (owner_user_id<>independent_reviewer_id),
 CONSTRAINT strata_continuous_revocation_time CHECK (revoked_at IS NULL OR revoked_at >= approved_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_continuous_one_active_owner
 ON private.strata_continuous_owner_authorizations(owner_user_id,execution_account_id,release_commit_sha)
 WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS strata_continuous_account_read
 ON private.strata_continuous_owner_authorizations(execution_account_id,release_commit_sha);
CREATE OR REPLACE FUNCTION private.strata_continuous_owner_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'continuous authorization audit cannot be deleted' USING ERRCODE='23514';
 END IF;
 IF ROW(NEW.authorization_id,NEW.owner_user_id,NEW.execution_account_id,
   NEW.release_commit_sha,NEW.approved_policy_hash,NEW.approved_stake_cents,
   NEW.approved_all_in_cents,NEW.source_release_id,NEW.source_review_id,
   NEW.source_owner_approval_id,NEW.independent_reviewer_id,
   NEW.confirmation,NEW.approved_at)
 IS DISTINCT FROM
 ROW(OLD.authorization_id,OLD.owner_user_id,OLD.execution_account_id,
   OLD.release_commit_sha,OLD.approved_policy_hash,OLD.approved_stake_cents,
   OLD.approved_all_in_cents,OLD.source_release_id,OLD.source_review_id,
   OLD.source_owner_approval_id,OLD.independent_reviewer_id,
   OLD.confirmation,OLD.approved_at)
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 THEN
  RAISE EXCEPTION 'continuous grant identity immutable; revocation only' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS strata_continuous_owner_immutable
 ON private.strata_continuous_owner_authorizations;
CREATE TRIGGER strata_continuous_owner_immutable
 BEFORE UPDATE OR DELETE ON private.strata_continuous_owner_authorizations
 FOR EACH ROW EXECUTE FUNCTION private.strata_continuous_owner_immutable_guard();
ALTER TABLE private.strata_continuous_owner_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_continuous_owner_authorizations FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.strata_continuous_owner_immutable_guard() FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_continuous_owner_authorizations IS
 'Candidate immutable, owner-AAL2-authorized and independently reviewed continuous permission. Never authenticates an order by itself; safe enrollment and dispatch fencing must be implemented before activation.';
COMMIT;
