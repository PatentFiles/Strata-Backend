-- Disposable candidate schema only; not approved migration or issuer implementation.
CREATE TABLE private.strata_owner_admission_evidence(
 evidence_id text PRIMARY KEY,challenge_id text NOT NULL,owner_user_id uuid NOT NULL,execution_account_id text NOT NULL,
 release_sha text NOT NULL,policy_hash text NOT NULL,credential_fingerprint text NOT NULL,
 secret_id uuid NOT NULL,provider_id uuid NOT NULL,financial_id uuid NOT NULL,
 control_sequence bigint NOT NULL,consent_generation bigint NOT NULL,expected_fence bigint NOT NULL,
 expires_at timestamptz NOT NULL,revoked_at timestamptz);
CREATE TABLE private.strata_owner_admission_outcomes(
 request_id text PRIMARY KEY,evidence_id text UNIQUE NOT NULL REFERENCES private.strata_owner_admission_evidence(evidence_id),
 owner_user_id uuid NOT NULL,execution_account_id text NOT NULL,scope jsonb NOT NULL,
 fencing_token bigint NOT NULL,committed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION private.offline_evidence_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'admission_evidence_immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON private.strata_owner_admission_evidence FOR EACH ROW EXECUTE FUNCTION private.offline_evidence_identity_immutable();
CREATE FUNCTION private.offline_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'admission_outcome_immutable'; END $$;
CREATE TRIGGER immutable_outcome BEFORE UPDATE OR DELETE ON private.strata_owner_admission_outcomes FOR EACH ROW EXECUTE FUNCTION private.offline_outcome_immutable();
REVOKE ALL ON private.strata_owner_admission_evidence,private.strata_owner_admission_outcomes FROM PUBLIC;
