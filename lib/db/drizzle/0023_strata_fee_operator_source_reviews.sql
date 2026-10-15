-- Additive, fail-closed operator observations of the existing July 2026
-- Kalshi fee PDF. These rows are NOT approved provider captures and cannot
-- authorize any policy, commissioning step, fee calculation or order.
BEGIN;

CREATE TABLE IF NOT EXISTS public.strata_fee_operator_source_reviews (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_sha256 text NOT NULL
    CHECK (content_sha256 = 'c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'),
  storage_bucket text NOT NULL DEFAULT 'strata-official-fee-artifacts'
    CHECK (storage_bucket = 'strata-official-fee-artifacts'),
  storage_object_path text NOT NULL DEFAULT 'operator-pending/kalshi-fee-schedule.pdf'
    CHECK (storage_object_path = 'operator-pending/kalshi-fee-schedule.pdf'),
  canonical_claim_url text NOT NULL DEFAULT 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'
    CHECK (canonical_claim_url = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'),
  effective_date date NOT NULL DEFAULT DATE '2026-07-07'
    CHECK (effective_date = DATE '2026-07-07'),
  reviewer_user_id uuid NOT NULL REFERENCES auth.users(id),
  reviewer_email text NOT NULL CHECK (length(reviewer_email) BETWEEN 4 AND 320),
  source_observed_at timestamptz NOT NULL,
  source_review_note text NOT NULL CHECK (length(source_review_note) BETWEEN 40 AND 1200),
  review_kind text NOT NULL DEFAULT 'human_canonical_source_claim'
    CHECK (review_kind = 'human_canonical_source_claim'),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '2 hours'),
  CONSTRAINT source_review_recent CHECK (
    source_observed_at BETWEEN reviewed_at - INTERVAL '15 minutes'
                           AND reviewed_at + INTERVAL '10 seconds'
  ),
  CONSTRAINT source_review_bounded CHECK (
    expires_at > reviewed_at AND expires_at <= reviewed_at + INTERVAL '2 hours'
  )
);

CREATE INDEX IF NOT EXISTS strata_fee_operator_source_reviews_active_idx
  ON public.strata_fee_operator_source_reviews(content_sha256, expires_at, reviewed_at);

ALTER TABLE public.strata_fee_operator_source_reviews ENABLE ROW LEVEL SECURITY;
-- The table is only a service-owned append-only audit log. There is
-- intentionally no policy granting client reads or writes.
REVOKE ALL ON public.strata_fee_operator_source_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.strata_fee_operator_source_reviews TO service_role;

COMMENT ON TABLE public.strata_fee_operator_source_reviews IS
  'Human review claims only; no verified Kalshi capture, owner policy approval, commissioning or trading authority.';
COMMIT;
