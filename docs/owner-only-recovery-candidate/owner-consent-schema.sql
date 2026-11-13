-- Offline candidate only. Depends on proposed owner control-head protocol, not deployed.
CREATE TABLE private.strata_owner_recovery_consent_challenge(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,account_id text NOT NULL,
 action text NOT NULL CHECK(action='OWNER_RECOVERY'),release_sha text NOT NULL,
 control_sequence bigint NOT NULL,worker_fence bigint NOT NULL CHECK(worker_fence>=0),lease_consent_epoch bigint NOT NULL CHECK(lease_consent_epoch>=0),credential_fingerprint text NOT NULL,policy_hash text NOT NULL,
 machine_evidence_digest text NOT NULL,consent_digest text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 revoked_at timestamptz,consumed_request_id uuid UNIQUE,consumed_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),
 CHECK((consumed_request_id IS NULL)=(consumed_at IS NULL)));
CREATE TABLE private.strata_owner_recovery_consent_receipt(
 request_id uuid PRIMARY KEY,challenge_id uuid UNIQUE NOT NULL REFERENCES private.strata_owner_recovery_consent_challenge(id),
 owner_id uuid NOT NULL,account_id text NOT NULL,consent_digest text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON private.strata_owner_recovery_consent_challenge,private.strata_owner_recovery_consent_receipt FROM PUBLIC;
CREATE FUNCTION private.owner_consent_challenge_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'challenge_immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['consumed_request_id','consumed_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_request_id','consumed_at','revoked_at'])
 OR (OLD.consumed_request_id IS NOT NULL AND (NEW.consumed_request_id IS DISTINCT FROM OLD.consumed_request_id OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at))
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 THEN RAISE EXCEPTION 'challenge_immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER owner_consent_challenge_immutable BEFORE UPDATE OR DELETE ON private.strata_owner_recovery_consent_challenge FOR EACH ROW EXECUTE FUNCTION private.owner_consent_challenge_immutable();
CREATE FUNCTION private.owner_consent_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt_immutable'; END $$;
CREATE TRIGGER owner_consent_receipt_immutable BEFORE UPDATE OR DELETE ON private.strata_owner_recovery_consent_receipt FOR EACH ROW EXECUTE FUNCTION private.owner_consent_receipt_immutable();
REVOKE ALL ON FUNCTION private.owner_consent_challenge_immutable(),private.owner_consent_receipt_immutable() FROM PUBLIC;
CREATE INDEX strata_owner_consent_active_scope ON private.strata_owner_recovery_consent_challenge(owner_id,account_id,issued_at DESC) WHERE consumed_request_id IS NULL AND revoked_at IS NULL;
CREATE INDEX strata_owner_consent_receipt_scope ON private.strata_owner_recovery_consent_receipt(owner_id,account_id,request_id);
