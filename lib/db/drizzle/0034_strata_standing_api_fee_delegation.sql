-- Issue #154. Review before applying via managed Supabase migration.
-- Creates no approvals, trades or implicit trading authority.
-- All existing PDF/V2 grant/consent rows remain unchanged.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_api_fee_standing_models (
 model_id uuid PRIMARY KEY,
 reviewer_admin_id uuid NOT NULL REFERENCES auth.users(id),
 rate_decision_digest text NOT NULL,
 fee_model_version text NOT NULL,
 scope text NOT NULL CHECK(scope='KXBTC15M:INDEX2'),
 release_commit_sha text NOT NULL CHECK(release_commit_sha ~ '^[0-9a-f]{40}$'),
 evidence_url text NOT NULL,
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_note text NOT NULL CHECK(length(evidence_note) BETWEEN 120 AND 1800),
 signed_at timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz NOT NULL,
 revoked_at timestamptz,
 revocation_reason text,
 CONSTRAINT standing_model_bounded CHECK(valid_until>signed_at AND valid_until<=signed_at+interval '30 days')
);
CREATE TABLE IF NOT EXISTS private.strata_api_fee_standing_delegations (
 delegation_id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 model_id uuid NOT NULL REFERENCES private.strata_api_fee_standing_models(model_id),
 grant_id uuid NOT NULL REFERENCES private.strata_api_fee_source_grants(grant_id),
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
 release_commit_sha text NOT NULL CHECK(release_commit_sha ~ '^[0-9a-f]{40}$'),
 confirmation text NOT NULL CHECK(confirmation='I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1'),
 granted_at timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz NOT NULL,
 lease_expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revocation_reason text,
 CONSTRAINT owner_fee_delegation_bounded CHECK(
  valid_until>granted_at AND valid_until<=granted_at+interval '30 days'
  AND lease_expires_at<=valid_until
 ),
 CONSTRAINT owner_fee_delegation_scope_unique UNIQUE(owner_user_id,grant_id)
);
CREATE INDEX IF NOT EXISTS strata_standing_models_active_idx
 ON private.strata_api_fee_standing_models(rate_decision_digest,release_commit_sha,valid_until)
 WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS strata_standing_delegations_active_idx
 ON private.strata_api_fee_standing_delegations(owner_user_id,model_id,grant_id,valid_until)
 WHERE revoked_at IS NULL;
ALTER TABLE private.strata_api_fee_standing_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_api_fee_standing_delegations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_api_fee_standing_models FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON private.strata_api_fee_standing_delegations FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
