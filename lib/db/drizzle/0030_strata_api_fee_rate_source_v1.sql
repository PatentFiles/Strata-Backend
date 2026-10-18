-- Strata KXBTC15M API-only rate-policy V1: schema only, NO backfill or approvals.
-- IMPORTANT: install only after independent audit of fee-rate model and runtime DB identity.
-- Service-only records, separate from existing PDF and operator-attested source tables.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_api_fee_rate_reviews (
 review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 reviewer_user_id uuid NOT NULL REFERENCES auth.users(id),
 rate_decision_digest text NOT NULL CHECK(rate_decision_digest ~ '^[0-9a-f]{64}$'),
 fee_model_version text NOT NULL
   CHECK(fee_model_version='kalshi_quadratic_007_whole_cent_conservative_reference_v1'),
 scope text NOT NULL DEFAULT 'KXBTC15M:INDEX2' CHECK(scope='KXBTC15M:INDEX2'),
 confirmation text NOT NULL CHECK(confirmation='I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1'),
 signed_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(reviewer_user_id<>owner_user_id),
 CHECK(expires_at>signed_at AND expires_at<=signed_at+interval '2 hours')
);
CREATE INDEX IF NOT EXISTS strata_api_fee_reviews_scope_idx
 ON private.strata_api_fee_rate_reviews(owner_user_id,rate_decision_digest,expires_at);
CREATE TABLE IF NOT EXISTS private.strata_api_fee_source_grants (
 grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 issuer_admin_id uuid NOT NULL REFERENCES auth.users(id),
 rate_decision_digest text NOT NULL CHECK(rate_decision_digest ~ '^[0-9a-f]{64}$'),
 fee_model_version text NOT NULL
   CHECK(fee_model_version='kalshi_quadratic_007_whole_cent_conservative_reference_v1'),
 policy_version text NOT NULL DEFAULT 'strata_api_fee_source_signed_review_v1'
   CHECK(policy_version='strata_api_fee_source_signed_review_v1'),
 scope text NOT NULL DEFAULT 'KXBTC15M:INDEX2' CHECK(scope='KXBTC15M:INDEX2'),
 authorized_stages text[] NOT NULL
   CHECK(authorized_stages @> ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[]
    AND authorized_stages <@ ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[]),
 confirmation text NOT NULL CHECK(confirmation='ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1'),
 issued_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(issuer_admin_id<>owner_user_id),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '15 minutes')
);
CREATE INDEX IF NOT EXISTS strata_api_fee_grants_owner_idx
 ON private.strata_api_fee_source_grants(owner_user_id,expires_at);
CREATE TABLE IF NOT EXISTS private.strata_api_fee_owner_consents (
 consent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 grant_id uuid NOT NULL REFERENCES private.strata_api_fee_source_grants(grant_id),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 confirmation text NOT NULL CHECK(confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 UNIQUE(grant_id,owner_user_id)
);
-- No anonymous or authenticated client writes, and no client selects.
ALTER TABLE private.strata_api_fee_rate_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_api_fee_source_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_api_fee_owner_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.strata_api_fee_rate_reviews,
 private.strata_api_fee_source_grants,private.strata_api_fee_owner_consents
 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE private.strata_api_fee_rate_reviews,
 private.strata_api_fee_source_grants,private.strata_api_fee_owner_consents TO service_role;
COMMENT ON TABLE private.strata_api_fee_source_grants IS
 'No grant created by this migration. Source grants are not live execution approval; runtime rechecks owner, admin roles, explicit consent, price/fee model and exchange order';
COMMIT;