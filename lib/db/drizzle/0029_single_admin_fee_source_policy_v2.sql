-- Version 2 one-administrator fee-source policy. Preserve historical V1 records.
-- A signed uploaded PDF remains operator-attested, never provider-authenticated.
-- This schema creates no approvals, consents, orders, policy changes or transfers.
BEGIN;

ALTER TABLE public.strata_fee_operator_release_candidates
  ALTER COLUMN reviewer_2 DROP NOT NULL;
ALTER TABLE public.strata_fee_operator_release_candidates
  DROP CONSTRAINT IF EXISTS different_claims;
ALTER TABLE public.strata_fee_operator_release_candidates
  ADD CONSTRAINT different_claims
  CHECK (reviewer_2 IS NULL OR reviewer_1 <> reviewer_2);

-- Legacy two-administrator records and their original validation remain intact.
CREATE OR REPLACE FUNCTION public.strata_one_operator_fee_review_valid(
  first_review uuid, expected_digest text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $fn$
  SELECT first_review IS NOT NULL
    AND expected_digest='c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'
    AND EXISTS (
      SELECT 1 FROM public.strata_fee_operator_source_reviews r
      JOIN auth.users u ON u.id=r.reviewer_user_id
      JOIN private.role_assignments ra
        ON lower(btrim(ra.email))=lower(btrim(u.email)) AND ra.role='ADMIN'
      WHERE r.review_id=first_review AND r.content_sha256=expected_digest
        AND r.expires_at>now() AND r.review_kind='human_canonical_source_claim'
        AND u.email_confirmed_at IS NOT NULL
    );
$fn$;
REVOKE ALL ON FUNCTION public.strata_one_operator_fee_review_valid(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.strata_one_operator_fee_review_valid(uuid,text)
  TO service_role;

ALTER TABLE private.strata_fee_source_policy_reviews
  DROP CONSTRAINT IF EXISTS strata_fee_source_policy_reviews_confirmation_check;
ALTER TABLE private.strata_fee_source_policy_reviews
  ADD CONSTRAINT strata_fee_source_policy_reviews_confirmation_check
    CHECK (confirmation IN (
      'I_APPROVE_STRATA_OPERATOR_FEE_SOURCE_POLICY_V1',
      'I_APPROVE_STRATA_OPERATOR_FEE_SOURCE_POLICY_V2'
    ));
ALTER TABLE private.strata_fee_source_policy_reviews
  DROP CONSTRAINT IF EXISTS strata_fee_source_policy_reviews_policy_decision_sha256_check;
ALTER TABLE private.strata_fee_source_policy_reviews
  ADD CONSTRAINT strata_fee_source_policy_reviews_policy_decision_sha256_check
    CHECK (
      (policy_decision_sha256='f8f7e0920168ab4601c59a3a9343e940d78dd974512c7ec97f7d052bf5fd685e'
        AND confirmation='I_APPROVE_STRATA_OPERATOR_FEE_SOURCE_POLICY_V1')
      OR
      (policy_decision_sha256='0e5d3cdaeba8c26bf54cb7c159ac14c9032180e24078c262ebe3290d8228918c'
        AND confirmation='I_APPROVE_STRATA_OPERATOR_FEE_SOURCE_POLICY_V2')
    );
ALTER TABLE private.strata_fee_source_grants
  DROP CONSTRAINT IF EXISTS strata_fee_source_grants_policy_version_check;
ALTER TABLE private.strata_fee_source_grants
  ADD CONSTRAINT strata_fee_source_grants_policy_version_check
  CHECK (policy_version IN ('operator_attested_fee_source_v1',
    'operator_attested_fee_source_v2'));

-- Existing trigger name retained to preserve deployed wiring and audit history.
CREATE OR REPLACE FUNCTION private.strata_require_two_fee_policy_reviews()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE eligible_reviews integer;
DECLARE required_reviews integer;
BEGIN
  IF NEW.reviewed_pdf_sha256 <>
    'c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'
    OR NEW.authorized_stages <> ARRAY['STEP_6','STEP_9','STEP_11','ORDER_ENTRY']::text[]
  THEN RAISE EXCEPTION 'fee_policy_scope_not_reviewed'; END IF;
  IF NEW.policy_version='operator_attested_fee_source_v2'
     AND NEW.policy_decision_sha256='0e5d3cdaeba8c26bf54cb7c159ac14c9032180e24078c262ebe3290d8228918c'
  THEN required_reviews:=1;
  ELSIF NEW.policy_version='operator_attested_fee_source_v1'
     AND NEW.policy_decision_sha256='f8f7e0920168ab4601c59a3a9343e940d78dd974512c7ec97f7d052bf5fd685e'
  THEN required_reviews:=2;
  ELSE RAISE EXCEPTION 'fee_policy_version_digest_mismatch'; END IF;

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
    WHERE u.id=NEW.approved_by_admin_id
      AND u.email_confirmed_at IS NOT NULL AND role.role='ADMIN'
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
  IF eligible_reviews<required_reviews
    THEN RAISE EXCEPTION 'fee_policy_admin_review_missing'; END IF;
  RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION private.strata_require_two_fee_policy_reviews()
  IS 'V1 legacy requires two reviews; immutable V2 requires one authenticated administrator review plus scoped grant, owner consent and fresh fee evidence.';
COMMIT;
