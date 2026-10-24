-- #165 Wallets-only V4 dynamic Kalshi fee evidence and bounded owner authorization.
-- These records do NOT enable the trading worker and do NOT replace V1/V2/V3.
-- Only privileged audited server code may insert; all browser roles denied.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_wallet_v4_fee_evidence (
 evidence_id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 deployed_sha text NOT NULL CHECK (deployed_sha ~ '^[a-f0-9]{40}$'),
 market_ticker text NOT NULL CHECK (market_ticker ~ '^KXBTC15M-[A-Za-z0-9-]+$'),
 model_digest text NOT NULL CHECK (model_digest ~ '^[a-f0-9]{64}$'),
 official_source_digest text NOT NULL CHECK (official_source_digest ~ '^[a-f0-9]{64}$'),
 market_metadata_digest text NOT NULL CHECK (market_metadata_digest ~ '^[a-f0-9]{64}$'),
 effective_at timestamptz NOT NULL,
 fee_type text NOT NULL CHECK (fee_type IN ('quadratic','flat')),
 taker_coefficient_ppm integer NOT NULL CHECK (taker_coefficient_ppm BETWEEN 0 AND 1000000),
 observed_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CONSTRAINT wallet_v4_evidence_bound CHECK (expires_at>observed_at AND expires_at<=observed_at+interval '15 minutes'),
 CONSTRAINT wallet_v4_effective CHECK (effective_at<=observed_at),
 CONSTRAINT wallet_v4_revoke_clock CHECK (revoked_at IS NULL OR revoked_at>=observed_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_v4_fee_proof_tuple ON
 private.strata_wallet_v4_fee_evidence(evidence_id,owner_user_id,execution_account_id,deployed_sha,model_digest);
CREATE INDEX IF NOT EXISTS wallet_v4_evidence_owner_active ON
 private.strata_wallet_v4_fee_evidence(owner_user_id,execution_account_id,deployed_sha,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS private.strata_wallet_v4_fee_authority (
 authority_id uuid PRIMARY KEY,
 evidence_id uuid NOT NULL UNIQUE,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 deployed_sha text NOT NULL CHECK (deployed_sha ~ '^[a-f0-9]{40}$'),
 model_digest text NOT NULL CHECK (model_digest ~ '^[a-f0-9]{64}$'),
 policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
 policy_version text NOT NULL CHECK (policy_version='strata_owner_provider_dynamic_fee_v4'),
 confirmation text NOT NULL CHECK (confirmation='I_APPROVE_MY_WALLET_DYNAMIC_FEE_MODEL_V4'),
 aal2_verified_at timestamptz NOT NULL,
 authorized_stages text[] NOT NULL CHECK (authorized_stages=ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[]),
 approved_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revocation_reason text,
 CONSTRAINT wallet_v4_authority_scoped_fk FOREIGN KEY
  (evidence_id,owner_user_id,execution_account_id,deployed_sha,model_digest)
  REFERENCES private.strata_wallet_v4_fee_evidence
  (evidence_id,owner_user_id,execution_account_id,deployed_sha,model_digest),
 CONSTRAINT wallet_v4_authority_bounded CHECK (expires_at>approved_at AND expires_at<=approved_at+interval '15 minutes'),
 CONSTRAINT wallet_v4_aal2_recent CHECK (aal2_verified_at<=approved_at AND aal2_verified_at>=approved_at-interval '5 minutes'),
 CONSTRAINT wallet_v4_authority_revoke_clock CHECK (revoked_at IS NULL OR revoked_at>=approved_at)
);
CREATE INDEX IF NOT EXISTS wallet_v4_authority_owner_active ON
 private.strata_wallet_v4_fee_authority(owner_user_id,execution_account_id,deployed_sha,expires_at) WHERE revoked_at IS NULL;
-- Immutable immutable provenance/consent, with one-way revocation only.
CREATE OR REPLACE FUNCTION private.strata_wallet_v4_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'wallet_v4_fee_record_immutable'; END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
    NEW.revoked_at < clock_timestamp()-interval '24 hours' THEN
  RAISE EXCEPTION 'wallet_v4_fee_record_immutable';
 END IF;
 IF to_jsonb(NEW)-'revoked_at'-'revocation_reason'
    IS DISTINCT FROM to_jsonb(OLD)-'revoked_at'-'revocation_reason' THEN
  RAISE EXCEPTION 'wallet_v4_fee_record_immutable';
 END IF;
 IF TG_TABLE_NAME='strata_wallet_v4_fee_authority' AND
    (NEW.revocation_reason IS NULL OR btrim(NEW.revocation_reason)='') THEN
  RAISE EXCEPTION 'wallet_v4_fee_revocation_reason_required';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_wallet_v4_immutable_guard()
 FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS wallet_v4_evidence_immutable ON private.strata_wallet_v4_fee_evidence;
CREATE TRIGGER wallet_v4_evidence_immutable BEFORE UPDATE OR DELETE ON
 private.strata_wallet_v4_fee_evidence FOR EACH ROW EXECUTE FUNCTION private.strata_wallet_v4_immutable_guard();
DROP TRIGGER IF EXISTS wallet_v4_authority_immutable ON private.strata_wallet_v4_fee_authority;
CREATE TRIGGER wallet_v4_authority_immutable BEFORE UPDATE OR DELETE ON
 private.strata_wallet_v4_fee_authority FOR EACH ROW EXECUTE FUNCTION private.strata_wallet_v4_immutable_guard();
ALTER TABLE private.strata_wallet_v4_fee_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_wallet_v4_fee_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_wallet_v4_fee_evidence FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON private.strata_wallet_v4_fee_authority FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
