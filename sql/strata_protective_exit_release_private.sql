-- REVIEW REQUIRED. This schema DOES NOT create an approval or enable trading.
-- Privileged operator may insert a release only after a distinct security
-- reviewer has APPROVED the exact deployed commit and exchange evidence exists.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_protective_exit_release (
 release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 release_commit_sha text NOT NULL UNIQUE CHECK(release_commit_sha ~ '^[0-9a-f]{40}$'),
 independent_reviewer_id uuid NOT NULL REFERENCES auth.users(id),
 operator_approver_id uuid NOT NULL REFERENCES auth.users(id),
 review_url text NOT NULL CHECK(review_url ~ '^https://github.com/PatentFiles/Strata-Backend/pull/[0-9]+$'),
 release_evidence_digest text NOT NULL CHECK(release_evidence_digest ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'approved' CHECK(state='approved'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CONSTRAINT protective_exit_segregation_of_duties
   CHECK(independent_reviewer_id <> operator_approver_id),
 CONSTRAINT protective_exit_bounded_release CHECK(expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
 CONSTRAINT protective_exit_revocation_time CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE OR REPLACE FUNCTION private.strata_protective_exit_release_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'protective exit release audit is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
   IF ROW(NEW.release_id,NEW.release_commit_sha,NEW.independent_reviewer_id,
          NEW.operator_approver_id,NEW.review_url,NEW.release_evidence_digest,
          NEW.state,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM
      ROW(OLD.release_id,OLD.release_commit_sha,OLD.independent_reviewer_id,
          OLD.operator_approver_id,OLD.review_url,OLD.release_evidence_digest,
          OLD.state,OLD.created_at,OLD.expires_at)
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
   THEN
     RAISE EXCEPTION 'protective exit release identity immutable; revocation only' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS strata_protective_exit_release_guard
 ON private.strata_protective_exit_release;
CREATE TRIGGER strata_protective_exit_release_guard
 BEFORE UPDATE OR DELETE ON private.strata_protective_exit_release
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_exit_release_guard();
ALTER TABLE private.strata_protective_exit_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_protective_exit_release FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.strata_protective_exit_release_guard() FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_protective_exit_release IS
'Independent approved code-release evidence; empty until external review and operator signoff. No client writes.';
COMMIT;
