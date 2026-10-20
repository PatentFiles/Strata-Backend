-- STAGED SECURITY MIGRATION. Apply only after independent release review.
-- Creates no approval, changes no live permissions, and cannot submit orders.
BEGIN;
ALTER TABLE private.strata_protective_release_reviews
  ADD COLUMN IF NOT EXISTS review_scope text NOT NULL DEFAULT 'TWO_HOUR';
ALTER TABLE private.strata_protective_release_reviews
  DROP CONSTRAINT IF EXISTS strata_protective_review_scope_check;
ALTER TABLE private.strata_protective_release_reviews
  ADD CONSTRAINT strata_protective_review_scope_check
  CHECK(review_scope IN ('TWO_HOUR','DURABLE_CODE_V1'));

CREATE TABLE IF NOT EXISTS private.strata_durable_code_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  release_commit_sha text NOT NULL CHECK(release_commit_sha ~ '^[a-f0-9]{40}$'),
  independent_reviewer_id uuid NOT NULL REFERENCES auth.users(id),
  owner_approver_id uuid NOT NULL REFERENCES auth.users(id),
  source_review_id uuid NOT NULL UNIQUE REFERENCES private.strata_protective_release_reviews(review_id),
  review_url text NOT NULL CHECK(review_url ~ '^https://github.com/PatentFiles/Strata-Backend/pull/[0-9]+$'),
  review_evidence_digest text NOT NULL CHECK(review_evidence_digest ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT strata_durable_code_distinct_reviewer CHECK(independent_reviewer_id<>owner_approver_id),
  CONSTRAINT strata_durable_code_owner_consent CHECK(owner_user_id=owner_approver_id),
  CONSTRAINT strata_durable_code_revocation_time CHECK(revoked_at IS NULL OR revoked_at>=approved_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_durable_code_active_per_owner_sha
 ON private.strata_durable_code_approvals(owner_user_id,release_commit_sha)
 WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION private.strata_durable_code_approval_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'durable code approval deletion forbidden' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.approval_id,NEW.owner_user_id,NEW.release_commit_sha,
         NEW.independent_reviewer_id,NEW.owner_approver_id,NEW.source_review_id,
         NEW.review_url,NEW.review_evidence_digest,NEW.approved_at)
    IS DISTINCT FROM
     ROW(OLD.approval_id,OLD.owner_user_id,OLD.release_commit_sha,
         OLD.independent_reviewer_id,OLD.owner_approver_id,OLD.source_review_id,
         OLD.review_url,OLD.review_evidence_digest,OLD.approved_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN
    RAISE EXCEPTION 'durable code approval may only be revoked' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $guard$;
DROP TRIGGER IF EXISTS strata_durable_code_approval_guard
 ON private.strata_durable_code_approvals;
CREATE TRIGGER strata_durable_code_approval_guard
 BEFORE UPDATE OR DELETE ON private.strata_durable_code_approvals
 FOR EACH ROW EXECUTE FUNCTION private.strata_durable_code_approval_guard();
ALTER TABLE private.strata_durable_code_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_durable_code_approvals FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.strata_durable_code_approval_guard() FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_durable_code_approvals IS
  'Revocable, owner-specific, independently reviewed exact-SHA code approval; grants no trading permission without operational/readiness and owner controls.';
COMMIT;
