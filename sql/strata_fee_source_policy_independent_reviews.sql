-- Additive private two-administrator approval of an explicit alternative fee-source policy.
-- Schema installation creates ZERO approvals, consents, orders, or trading authority.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_fee_source_policy_reviews (
  review_id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES public.strata_fee_operator_release_candidates(release_id),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  reviewer_user_id uuid NOT NULL REFERENCES auth.users(id),
  policy_decision_sha256 text NOT NULL
    CHECK (policy_decision_sha256='f8f7e0920168ab4601c59a3a9343e940d78dd974512c7ec97f7d052bf5fd685e'),
  reviewed_pdf_sha256 text NOT NULL
    CHECK (reviewed_pdf_sha256='c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'),
  confirmation text NOT NULL
    CHECK (confirmation='I_APPROVE_STRATA_OPERATOR_FEE_SOURCE_POLICY_V1'),
  review_note text NOT NULL CHECK (char_length(review_note) BETWEEN 100 AND 1600),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  UNIQUE(release_id,owner_user_id,reviewer_user_id,policy_decision_sha256),
  CHECK (expires_at > reviewed_at AND expires_at <= reviewed_at + interval '15 minutes'),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);
ALTER TABLE private.strata_fee_source_policy_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_fee_source_policy_reviews FROM PUBLIC,anon,authenticated;
CREATE INDEX IF NOT EXISTS strata_fee_policy_reviews_scope_idx
  ON private.strata_fee_source_policy_reviews(owner_user_id,release_id,expires_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS strata_fee_source_grant_one_per_release_owner
  ON private.strata_fee_source_grants(owner_user_id,release_id);
DROP TRIGGER IF EXISTS strata_fee_policy_reviews_append_only
  ON private.strata_fee_source_policy_reviews;
CREATE TRIGGER strata_fee_policy_reviews_append_only
BEFORE UPDATE OR DELETE ON private.strata_fee_source_policy_reviews
FOR EACH ROW EXECUTE FUNCTION private.strata_fee_source_prevent_evidence_mutation();

-- Defense in depth: a service or SQL caller cannot mint a source grant unless
-- the exact policy statement was independently signed by two CURRENT admins,
-- the release is still valid, and the actor who issues the grant is an admin.
CREATE OR REPLACE FUNCTION private.strata_require_two_fee_policy_reviews()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE eligible_reviews integer;
BEGIN
  IF NEW.policy_decision_sha256 <>
       'f8f7e0920168ab4601c59a3a9343e940d78dd974512c7ec97f7d052bf5fd685e'
    OR NEW.reviewed_pdf_sha256 <>
       'c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'
    OR NEW.authorized_stages <> ARRAY['STEP_6','STEP_9','STEP_11','ORDER_ENTRY']::text[]
    THEN RAISE EXCEPTION 'fee_policy_scope_not_reviewed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.strata_fee_operator_release_candidates c
    WHERE c.release_id=NEW.release_id AND c.revoked_at IS NULL
      AND c.expires_at>now() AND NEW.expires_at<=c.expires_at
      AND c.content_sha256=NEW.reviewed_pdf_sha256
      AND c.evidence_kind='operator_attested_commissioning_candidate'
  ) THEN RAISE EXCEPTION 'fee_policy_release_inactive'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u JOIN private.role_assignments role
      ON lower(btrim(u.email))=lower(btrim(role.email))
    WHERE u.id=NEW.approved_by_admin_id AND u.email_confirmed_at IS NOT NULL
      AND role.role='ADMIN'
  ) THEN RAISE EXCEPTION 'fee_policy_issuer_not_admin'; END IF;
  SELECT count(DISTINCT review.reviewer_user_id) INTO eligible_reviews
    FROM private.strata_fee_source_policy_reviews review
    JOIN auth.users u ON u.id=review.reviewer_user_id
    JOIN private.role_assignments role
      ON lower(btrim(u.email))=lower(btrim(role.email))
    WHERE review.release_id=NEW.release_id
      AND review.owner_user_id=NEW.owner_user_id
      AND review.policy_decision_sha256=NEW.policy_decision_sha256
      AND review.reviewed_pdf_sha256=NEW.reviewed_pdf_sha256
      AND review.revoked_at IS NULL AND review.expires_at>now()
      AND u.email_confirmed_at IS NOT NULL AND role.role='ADMIN';
  IF eligible_reviews < 2 THEN RAISE EXCEPTION 'two_independent_fee_policy_admins_required'; END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS strata_fee_grant_require_policy_reviews
  ON private.strata_fee_source_grants;
CREATE TRIGGER strata_fee_grant_require_policy_reviews
BEFORE INSERT ON private.strata_fee_source_grants
FOR EACH ROW EXECUTE FUNCTION private.strata_require_two_fee_policy_reviews();
COMMENT ON TABLE private.strata_fee_source_policy_reviews IS
  'Private, append-only signed alternative provenance policy reviews; source reviews alone do not authorize grants or trading.';
COMMIT;
