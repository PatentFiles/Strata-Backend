-- #165 V3: independent of V2 human-review records. Evidence-only V3
-- attestations never become grants through a migration or backfill.
-- Backend may create a grant only after fresh, server-verified official
-- monetary source and owner AAL2 consent. No entry-release effect.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_owner_fee_authority_v3 (
 authority_id uuid PRIMARY KEY,
 attestation_id uuid NOT NULL UNIQUE REFERENCES private.strata_owner_fee_evidence_v3(attestation_id),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[a-f0-9]{40}$'),
 official_source_digest text NOT NULL CHECK (official_source_digest ~ '^[a-f0-9]{64}$'),
 official_source_url text NOT NULL CHECK (
   official_source_url = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'),
 policy_version text NOT NULL CHECK (policy_version = 'strata_owner_official_monetary_fee_v3'),
 formula_version text NOT NULL CHECK (formula_version = 'standard-quadratic-0.07-v1'),
 scope text NOT NULL CHECK (scope = 'KXBTC15M:INDEX2:SUBACCOUNT1'),
 authorized_stages text[] NOT NULL CHECK (
   authorized_stages = ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[]),
 confirmation text NOT NULL CHECK (
   confirmation = 'I_APPROVE_MY_OWN_VERIFIED_MONETARY_FEE_GRANT_V3'),
 issued_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revocation_reason text,
 CONSTRAINT v3_authority_ttl CHECK (
   expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
 CONSTRAINT v3_authority_revoke_clock CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX IF NOT EXISTS strata_owner_v3_authority_scope_idx
 ON private.strata_owner_fee_authority_v3(owner_user_id,execution_account_id,release_commit_sha,expires_at DESC)
 WHERE revoked_at IS NULL;
ALTER TABLE private.strata_owner_fee_authority_v3 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_fee_authority_v3
 FROM PUBLIC,anon,authenticated,service_role;
-- SECURITY INVOKER, no PUBLIC EXECUTE. Immutable authority with one revocation.
CREATE OR REPLACE FUNCTION private.strata_owner_v3_authority_mutation_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = '' AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
   RAISE EXCEPTION 'immutable_v3_fee_authority';
 END IF;
 IF TG_OP = 'UPDATE' AND (
   OLD.revoked_at IS NOT NULL OR
   NEW.authority_id IS DISTINCT FROM OLD.authority_id OR
   NEW.attestation_id IS DISTINCT FROM OLD.attestation_id OR
   NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR
   NEW.execution_account_id IS DISTINCT FROM OLD.execution_account_id OR
   NEW.release_commit_sha IS DISTINCT FROM OLD.release_commit_sha OR
   NEW.official_source_digest IS DISTINCT FROM OLD.official_source_digest OR
   NEW.official_source_url IS DISTINCT FROM OLD.official_source_url OR
   NEW.policy_version IS DISTINCT FROM OLD.policy_version OR
   NEW.formula_version IS DISTINCT FROM OLD.formula_version OR
   NEW.scope IS DISTINCT FROM OLD.scope OR
   NEW.authorized_stages IS DISTINCT FROM OLD.authorized_stages OR
   NEW.confirmation IS DISTINCT FROM OLD.confirmation OR
   NEW.issued_at IS DISTINCT FROM OLD.issued_at OR
   NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
   NEW.revoked_at IS NULL OR
   NEW.revocation_reason IS NULL OR btrim(NEW.revocation_reason) = ''
 ) THEN
   RAISE EXCEPTION 'immutable_v3_fee_authority';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_owner_v3_authority_mutation_guard()
 FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS strata_owner_v3_authority_mutation_guard
 ON private.strata_owner_fee_authority_v3;
CREATE TRIGGER strata_owner_v3_authority_mutation_guard
 BEFORE UPDATE OR DELETE ON private.strata_owner_fee_authority_v3
 FOR EACH ROW EXECUTE FUNCTION private.strata_owner_v3_authority_mutation_guard();
COMMIT;
