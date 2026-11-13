-- Issue #165, V3 owner fee onboarding: immutable self-consent candidate receipts.
-- THIS TABLE CONFERS NO TRADING AUTHORITY. No V2 reviewer/grant rows are modified.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_owner_fee_evidence_v3 (
 attestation_id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK(release_commit_sha ~ '^[a-f0-9]{40}$'),
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 market_ticker text NOT NULL CHECK(market_ticker ~ '^KXBTC15M-[A-Za-z0-9-]+$'),
 verification_stage text NOT NULL CHECK(verification_stage='STEP_9'),
 source_kind text NOT NULL CHECK(source_kind='official_kalshi_server_verified_v3'),
 owner_confirmation text NOT NULL CHECK(owner_confirmation='I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3'),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revocation_reason text,
 CONSTRAINT owner_fee_v3_expiry_bounded CHECK(expires_at>confirmed_at AND expires_at<=confirmed_at+interval '2 hours'),
 CONSTRAINT owner_fee_v3_revoke_timestamp CHECK(revoked_at IS NULL OR revoked_at>=confirmed_at)
);
CREATE INDEX IF NOT EXISTS owner_fee_v3_active_lookup
 ON private.strata_owner_fee_evidence_v3(owner_user_id,execution_account_id,release_commit_sha,expires_at)
 WHERE revoked_at IS NULL;
-- An operator may revoke, but cannot revise a signature/evidence receipt.
CREATE OR REPLACE FUNCTION private.strata_owner_fee_v3_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'owner_fee_v3_evidence_immutable';
 END IF;
 IF OLD.revoked_at IS NOT NULL
  OR NEW.attestation_id IS DISTINCT FROM OLD.attestation_id
  OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
  OR NEW.execution_account_id IS DISTINCT FROM OLD.execution_account_id
  OR NEW.release_commit_sha IS DISTINCT FROM OLD.release_commit_sha
  OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
  OR NEW.market_ticker IS DISTINCT FROM OLD.market_ticker
  OR NEW.verification_stage IS DISTINCT FROM OLD.verification_stage
  OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
  OR NEW.owner_confirmation IS DISTINCT FROM OLD.owner_confirmation
  OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
  OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
 THEN RAISE EXCEPTION 'owner_fee_v3_evidence_immutable'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS strata_owner_fee_v3_immutable_guard ON private.strata_owner_fee_evidence_v3;
CREATE TRIGGER strata_owner_fee_v3_immutable_guard
 BEFORE UPDATE OR DELETE ON private.strata_owner_fee_evidence_v3
 FOR EACH ROW EXECUTE FUNCTION private.strata_owner_fee_v3_immutable_guard();
ALTER TABLE private.strata_owner_fee_evidence_v3 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_fee_evidence_v3 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
