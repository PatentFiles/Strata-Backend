-- Additive, incident-scoped operator review release records.
-- IMPORTANT: This table is NOT the official Kalshi source capture ledger.
-- No row grants policy, commissioning, activation or trading authority.
BEGIN;
CREATE TABLE IF NOT EXISTS public.strata_fee_operator_release_candidates (
  release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_sha256 text NOT NULL
    CHECK (content_sha256 = 'c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'),
  storage_bucket text NOT NULL DEFAULT 'strata-official-fee-artifacts'
    CHECK (storage_bucket = 'strata-official-fee-artifacts'),
  storage_object_path text NOT NULL DEFAULT 'operator-pending/kalshi-fee-schedule.pdf'
    CHECK (storage_object_path = 'operator-pending/kalshi-fee-schedule.pdf'),
  evidence_kind text NOT NULL DEFAULT 'operator_attested_commissioning_candidate'
    CHECK (evidence_kind = 'operator_attested_commissioning_candidate'),
  source_url text NOT NULL DEFAULT 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'
    CHECK (source_url = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'),
  source_effective_date date NOT NULL DEFAULT DATE '2026-07-07'
    CHECK (source_effective_date = DATE '2026-07-07'),
  reviewer_1 uuid NOT NULL REFERENCES public.strata_fee_operator_source_reviews(review_id),
  reviewer_2 uuid NOT NULL REFERENCES public.strata_fee_operator_source_reviews(review_id),
  released_by uuid NOT NULL REFERENCES auth.users(id),
  reviewer_note text NOT NULL CHECK (char_length(reviewer_note) BETWEEN 80 AND 1600),
  release_confirmation text NOT NULL
    CHECK (release_confirmation = 'REVIEW_OPERATOR_ATTESTED_COMMISSIONING_ONLY'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  CONSTRAINT different_claims CHECK (reviewer_1 <> reviewer_2),
  CONSTRAINT release_time_bounded CHECK (
    expires_at > recorded_at AND expires_at <= recorded_at + INTERVAL '15 minutes'
  ),
  CONSTRAINT revocation_consistent CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND char_length(COALESCE(revocation_reason,'')) BETWEEN 10 AND 300)
  ),
  CONSTRAINT unique_claim_pair UNIQUE (content_sha256, reviewer_1, reviewer_2)
);
CREATE INDEX IF NOT EXISTS strata_fee_release_candidate_expiry_idx
  ON public.strata_fee_operator_release_candidates (content_sha256, expires_at, revoked_at);
ALTER TABLE public.strata_fee_operator_release_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.strata_fee_operator_release_candidates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.strata_fee_operator_release_candidates TO service_role;
COMMENT ON TABLE public.strata_fee_operator_release_candidates IS
  'Signed operator release CANDIDATES only; never official-source captures or authority to approve policies, commission accounts or trade.';

-- Service-only validation of two DIFFERENT, still-authorized verified administrators.
-- Re-checks role revocation and expiration at the release decision boundary.
CREATE OR REPLACE FUNCTION public.strata_two_operator_fee_reviews_valid(
  first_review uuid, second_review uuid, expected_digest text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fee_guard$
 SELECT first_review IS NOT NULL AND second_review IS NOT NULL
    AND first_review <> second_review
    AND expected_digest = 'c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'
    AND (
      SELECT count(DISTINCT r.reviewer_user_id) = 2
      FROM public.strata_fee_operator_source_reviews r
      JOIN auth.users u ON u.id = r.reviewer_user_id
      JOIN private.role_assignments ra
        ON lower(btrim(ra.email)) = lower(btrim(u.email)) AND ra.role = 'ADMIN'
      WHERE r.review_id IN (first_review, second_review)
        AND r.content_sha256 = expected_digest
        AND r.expires_at > now()
        AND r.review_kind = 'human_canonical_source_claim'
        AND u.email_confirmed_at IS NOT NULL
    );
$fee_guard$;
REVOKE ALL ON FUNCTION public.strata_two_operator_fee_reviews_valid(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.strata_two_operator_fee_reviews_valid(uuid,uuid,text)
  TO service_role;
COMMIT;
