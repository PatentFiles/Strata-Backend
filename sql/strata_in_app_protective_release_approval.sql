-- Two-identity audited approval using existing trusted Strata API.
-- NO activation, trading, or fabricated release records are created here.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_protective_release_qualification (
  qualification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[0-9a-f]{40}$'),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes'),
  CONSTRAINT strata_release_qualification_window CHECK (
    expires_at > observed_at AND expires_at <= observed_at+interval '15 minutes')
);
CREATE INDEX IF NOT EXISTS strata_release_qualification_lookup
  ON private.strata_protective_release_qualification
  (owner_user_id,release_commit_sha,observed_at DESC);
CREATE TABLE IF NOT EXISTS private.strata_protective_release_reviews (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id uuid NOT NULL REFERENCES private.strata_protective_release_qualification(qualification_id),
  release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[0-9a-f]{40}$'),
  reviewer_user_id uuid NOT NULL REFERENCES auth.users(id),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  review_url text NOT NULL CHECK (review_url ~ '^https://github.com/PatentFiles/Strata-Backend/pull/[0-9]+$'),
  review_note text NOT NULL CHECK (length(review_note) BETWEEN 120 AND 2500),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes'),
  CONSTRAINT strata_release_review_separate_actor CHECK(reviewer_user_id<>owner_user_id),
  CONSTRAINT strata_release_review_window CHECK (
    expires_at>approved_at AND expires_at<=approved_at+interval '15 minutes'),
  UNIQUE(qualification_id,reviewer_user_id)
);
CREATE INDEX IF NOT EXISTS strata_release_review_lookup
  ON private.strata_protective_release_reviews
  (owner_user_id,release_commit_sha,approved_at DESC);
-- An audit claim cannot be silently edited or removed by API or operator.
CREATE OR REPLACE FUNCTION private.strata_protective_approval_audit_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 RAISE EXCEPTION 'protective approval evidence is immutable' USING ERRCODE='23514';
END $fn$;
DROP TRIGGER IF EXISTS strata_qualification_immutable
  ON private.strata_protective_release_qualification;
CREATE TRIGGER strata_qualification_immutable
 BEFORE UPDATE OR DELETE ON private.strata_protective_release_qualification
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_approval_audit_immutable();
DROP TRIGGER IF EXISTS strata_release_review_immutable
  ON private.strata_protective_release_reviews;
CREATE TRIGGER strata_release_review_immutable
 BEFORE UPDATE OR DELETE ON private.strata_protective_release_reviews
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_approval_audit_immutable();
ALTER TABLE private.strata_protective_release_qualification ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_protective_release_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_protective_release_qualification FROM PUBLIC,anon,authenticated;
REVOKE ALL ON private.strata_protective_release_reviews FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.strata_protective_approval_audit_immutable() FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_protective_release_qualification IS
 'Signed server-side PRODUCTION GET evidence; no POST, no authorization.';
COMMENT ON TABLE private.strata_protective_release_reviews IS
 'Human independent code/safety review bound to authentic fresh production GET evidence.';
COMMIT;
