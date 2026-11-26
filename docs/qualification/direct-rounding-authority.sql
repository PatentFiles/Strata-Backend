-- REVIEW CANDIDATE ONLY. Not applied. No approval rows inserted.
-- Access must be server-owned only; no client grants or approval endpoint.
CREATE TABLE private.strata_direct_rounding_authority (
 account_id text NOT NULL CHECK(length(account_id) BETWEEN 1 AND 200),
 owner_user_id uuid NOT NULL,
 scope_generation bigint NOT NULL CHECK(scope_generation > 0),
 documentation_policy_digest text NOT NULL CHECK(documentation_policy_digest ~ '^[a-f0-9]{64}$'),
 execution_fingerprint text NOT NULL CHECK(execution_fingerprint ~ '^[a-f0-9]{64}$'),
 verification_fingerprint text NOT NULL CHECK(verification_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(state IN ('PENDING_REVIEW','APPROVED','REVOKED')),
 review_record_digest text,
 reviewed_by_user_id uuid,
 issued_at timestamptz,
 expires_at timestamptz,
 revoked_at timestamptz,
 PRIMARY KEY(account_id,scope_generation),
 CHECK(execution_fingerprint <> verification_fingerprint),
 CHECK(state <> 'APPROVED' OR (review_record_digest ~ '^[a-f0-9]{64}$' AND review_record_digest IS NOT NULL AND reviewed_by_user_id IS NOT NULL AND issued_at IS NOT NULL AND expires_at > issued_at AND expires_at IS NOT NULL AND revoked_at IS NULL))
);
ALTER TABLE private.strata_direct_rounding_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_direct_rounding_authority FROM PUBLIC, anon, authenticated;
CREATE UNIQUE INDEX strata_direct_rounding_one_current ON private.strata_direct_rounding_authority(account_id) WHERE state='APPROVED' AND revoked_at IS NULL;

-- Authority writers serialize on the SAME account row held by final execution.
-- SECURITY INVOKER: dedicated review writers need account SELECT/UPDATE lock
-- privilege; this function does not grant rights or bypass RLS.
CREATE FUNCTION private.serialize_direct_rounding_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, private AS $$
DECLARE target_account text; target_owner uuid;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'rounding authority writes require READ COMMITTED';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.scope_generation IS DISTINCT FROM OLD.scope_generation) THEN
  RAISE EXCEPTION 'rounding authority identity is immutable';
 END IF;
 IF TG_OP='DELETE' THEN target_account:=OLD.account_id;target_owner:=OLD.owner_user_id;
 ELSE target_account:=NEW.account_id;target_owner:=NEW.owner_user_id; END IF;
 PERFORM 1 FROM public.v13_production_account
 WHERE id=target_account AND owner_user_id=target_owner
 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'rounding authority account owner mismatch'; END IF;
 -- Retain the generation tombstone: deleting a later row could revive an old
 -- approval through the registry's NOT EXISTS latest-generation predicate.
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'rounding authority history cannot be deleted; revoke instead'; END IF;
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM private.strata_direct_rounding_authority WHERE account_id=NEW.account_id AND scope_generation>=NEW.scope_generation) THEN
  RAISE EXCEPTION 'rounding authority generation must increase';
 END IF;
 IF TG_OP='UPDATE' AND OLD.state='REVOKED' THEN
  RAISE EXCEPTION 'revoked rounding authority is immutable';
 END IF;
 IF TG_OP='UPDATE' AND OLD.state='APPROVED' THEN
  IF NEW.state<>'REVOKED' OR NEW.revoked_at IS NULL OR
   NEW.documentation_policy_digest IS DISTINCT FROM OLD.documentation_policy_digest OR
   NEW.execution_fingerprint IS DISTINCT FROM OLD.execution_fingerprint OR
   NEW.verification_fingerprint IS DISTINCT FROM OLD.verification_fingerprint OR
   NEW.review_record_digest IS DISTINCT FROM OLD.review_record_digest OR
   NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id OR
   NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'approved rounding authority may only be revoked; create new generation for changes';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.serialize_direct_rounding_authority() FROM PUBLIC;
CREATE TRIGGER serialize_direct_rounding_authority
BEFORE INSERT OR UPDATE OR DELETE ON private.strata_direct_rounding_authority
FOR EACH ROW EXECUTE FUNCTION private.serialize_direct_rounding_authority();
CREATE FUNCTION private.reject_direct_rounding_truncate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'rounding authority history cannot be truncated'; END;
$$;
REVOKE ALL ON FUNCTION private.reject_direct_rounding_truncate() FROM PUBLIC;
CREATE TRIGGER reject_direct_rounding_truncate
BEFORE TRUNCATE ON private.strata_direct_rounding_authority
FOR EACH STATEMENT EXECUTE FUNCTION private.reject_direct_rounding_truncate();
