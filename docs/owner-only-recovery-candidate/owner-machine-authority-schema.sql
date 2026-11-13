-- LOCAL INACTIVE CANDIDATE. No issuer, role grant, enrollment or production apply.
CREATE TABLE private.strata_owner_machine_authority(
 request_id uuid PRIMARY KEY,
 owner_id uuid NOT NULL,account_id text NOT NULL,
 release_sha text NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40}$'),
 machine_digest text NOT NULL CHECK(machine_digest ~ '^[0-9a-f]{64}$'),
 policy_hash text NOT NULL,credential_fingerprint text NOT NULL,
 revision bigint NOT NULL CHECK(revision>=0),control_sequence bigint NOT NULL CHECK(control_sequence>=0),
 worker_fence bigint NOT NULL CHECK(worker_fence>=0),consent_epoch bigint NOT NULL CHECK(consent_epoch>=0),
 issuer_repository_id bigint NOT NULL CHECK(issuer_repository_id>0),
 issuer_workflow_id bigint NOT NULL CHECK(issuer_workflow_id>0),
 issuer_run_id bigint NOT NULL CHECK(issuer_run_id>0),issuer_run_attempt integer NOT NULL CHECK(issuer_run_attempt>0),
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),
 CHECK(consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
);
REVOKE ALL ON private.strata_owner_machine_authority FROM PUBLIC;
CREATE FUNCTION private.owner_machine_authority_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'machine_authority_immutable'; END IF;
 IF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
 OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN RAISE EXCEPTION 'machine_authority_immutable'; END IF;
 NEW.consumed_at:=clock_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.owner_machine_authority_immutable() FROM PUBLIC;
CREATE TRIGGER machine_authority_immutable BEFORE UPDATE OR DELETE ON private.strata_owner_machine_authority FOR EACH ROW EXECUTE FUNCTION private.owner_machine_authority_immutable();

CREATE FUNCTION private.owner_machine_authority_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'machine_authority_immutable'; END $$;
REVOKE ALL ON FUNCTION private.owner_machine_authority_no_truncate() FROM PUBLIC;
CREATE TRIGGER machine_authority_no_truncate BEFORE TRUNCATE ON private.strata_owner_machine_authority EXECUTE FUNCTION private.owner_machine_authority_no_truncate();
