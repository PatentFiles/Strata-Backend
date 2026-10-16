-- Incident-scoped signed release of operator-attested KXBTC15M fee evidence.
-- This is NOT a Kalshi-authenticated PDF capture, not an owner policy approval,
-- and not permission to place orders. It is one input to later independent gates.
BEGIN;
CREATE TABLE IF NOT EXISTS public.strata_fee_operator_approved_releases (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL UNIQUE
    REFERENCES public.strata_fee_operator_release_candidates(release_id),
  content_sha256 text NOT NULL
    CHECK (content_sha256 = 'c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'),
  evidence_kind text NOT NULL DEFAULT 'operator_attested_fee_source_release'
    CHECK (evidence_kind = 'operator_attested_fee_source_release'),
  series_ticker text NOT NULL DEFAULT 'KXBTC15M' CHECK (series_ticker = 'KXBTC15M'),
  released_by uuid NOT NULL REFERENCES auth.users(id),
  reviewed_risks text NOT NULL CHECK (char_length(reviewed_risks) BETWEEN 100 AND 1600),
  release_confirmation text NOT NULL
    CHECK (release_confirmation = 'AUTHORIZE_OPERATOR_ATTESTED_FEE_SOURCE_WITH_LIVE_API_GUARD'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  CONSTRAINT operator_fee_release_ttl CHECK (
    expires_at > approved_at AND expires_at <= approved_at + INTERVAL '24 hours'
  ),
  CONSTRAINT operator_fee_release_revocation CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND char_length(COALESCE(revocation_reason, '')) BETWEEN 10 AND 300)
  )
);
CREATE INDEX IF NOT EXISTS strata_fee_approved_release_validity_idx
 ON public.strata_fee_operator_approved_releases (expires_at, revoked_at);
ALTER TABLE public.strata_fee_operator_approved_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.strata_fee_operator_approved_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.strata_fee_operator_approved_releases TO service_role;
COMMENT ON TABLE public.strata_fee_operator_approved_releases IS
  'Separate signed operator-attested fee-source release; no official PDF provenance, owner approval, commissioning or trading authority.';
COMMIT;
