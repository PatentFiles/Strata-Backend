BEGIN;
-- Isolated candidate only. Requires coordinated deployment of all five revokers.
CREATE TABLE private.strata_owner_consent_heads (
 owner_user_id uuid NOT NULL,
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 generation bigint NOT NULL CHECK(generation>=0),
 PRIMARY KEY(owner_user_id,execution_account_id)
);
CREATE TABLE private.strata_owner_consent_bindings (
 qualification_id uuid PRIMARY KEY REFERENCES private.strata_protective_release_qualification(qualification_id),
 owner_user_id uuid NOT NULL,
 execution_account_id text NOT NULL,
 release_commit_sha text NOT NULL CHECK(release_commit_sha ~ '^[a-f0-9]{40}$'),
 generation bigint NOT NULL CHECK(generation>=0),
 mode text NOT NULL CHECK(mode IN ('STANDARD','DISABLED_KILLED_APPROVAL_ONLY')),
 policy_id text NOT NULL,
 policy_hash text NOT NULL,
 credential_fingerprint text NOT NULL,
 account_xmin text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.strata_owner_consent_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_owner_consent_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_consent_heads,private.strata_owner_consent_bindings FROM PUBLIC;
-- All inspected insertion callers already lock account first. Trigger extends
-- generation enforcement to both insertion paths, not just the new UI mode.
CREATE FUNCTION private.strata_guard_owner_approval_consent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_generation bigint; account_revision text;
BEGIN
 SELECT xmin::text INTO account_revision FROM public.v13_production_account
 WHERE id=NEW.execution_account_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'owner_renewal_consent_account_missing'; END IF;
 INSERT INTO private.strata_owner_consent_heads VALUES(NEW.owner_user_id,NEW.execution_account_id,0)
 ON CONFLICT DO NOTHING;
 SELECT generation INTO current_generation FROM private.strata_owner_consent_heads
 WHERE owner_user_id=NEW.owner_user_id AND execution_account_id=NEW.execution_account_id FOR UPDATE;
 IF current_generation>0 AND NOT EXISTS (
 SELECT 1 FROM private.strata_owner_consent_bindings b
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=b.qualification_id
 JOIN public.v13_production_account a ON a.id=b.execution_account_id AND a.owner_user_id=b.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE b.qualification_id=NEW.qualification_id AND b.owner_user_id=NEW.owner_user_id
 AND b.execution_account_id=NEW.execution_account_id AND b.release_commit_sha=NEW.release_commit_sha
 AND b.generation=current_generation AND (b.mode='STANDARD' OR b.account_xmin=account_revision)
 AND b.policy_id=a.policy_id::text AND b.policy_hash=p.policy_hash AND b.credential_fingerprint=a.key_fingerprint
 AND q.owner_user_id=b.owner_user_id AND q.execution_account_id=b.execution_account_id
 AND q.release_commit_sha=b.release_commit_sha AND q.evidence_digest=NEW.qualification_digest
 AND clock_timestamp() BETWEEN q.observed_at AND q.expires_at
 ) THEN RAISE EXCEPTION 'owner_renewal_fresh_consent_binding_required'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_guard_owner_approval_consent() FROM PUBLIC;
CREATE TRIGGER strata_owner_approval_consent BEFORE INSERT ON private.strata_owner_sha_approvals
 FOR EACH ROW EXECUTE FUNCTION private.strata_guard_owner_approval_consent();
-- Migration epoch, not a fabricated owner revocation. Existing accounts need
-- a fresh post-cutover qualification; pre-cutover unbound receipts cannot insert.
INSERT INTO private.strata_owner_consent_heads(owner_user_id,execution_account_id,generation)
 SELECT owner_user_id,id,1 FROM public.v13_production_account WHERE owner_user_id IS NOT NULL
 ON CONFLICT DO NOTHING;
CREATE FUNCTION private.strata_guard_owner_approval_revocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM private.strata_owner_consent_heads h
  WHERE h.owner_user_id=OLD.owner_user_id AND h.execution_account_id=OLD.execution_account_id
  AND h.generation>0 AND h.xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text
 ) THEN RAISE EXCEPTION 'owner_renewal_revocation_generation_advance_required'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_guard_owner_approval_revocation() FROM PUBLIC;
CREATE TRIGGER strata_owner_approval_revocation BEFORE UPDATE OF revoked_at ON private.strata_owner_sha_approvals
 FOR EACH ROW EXECUTE FUNCTION private.strata_guard_owner_approval_revocation();
-- Installed after migration seeding. Runtime initialization is generation0;
-- an UPDATE is an exact single advance, never an identity change or no-op.
CREATE FUNCTION private.strata_guard_consent_head_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.generation<>0 THEN RAISE EXCEPTION 'owner_renewal_head_initial_generation_invalid'; END IF;
 ELSE
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
   OR NEW.execution_account_id IS DISTINCT FROM OLD.execution_account_id
   OR NEW.generation IS DISTINCT FROM OLD.generation+1
  THEN RAISE EXCEPTION 'owner_renewal_head_transition_invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_guard_consent_head_transition() FROM PUBLIC;
CREATE TRIGGER strata_consent_head_transition BEFORE INSERT OR UPDATE ON private.strata_owner_consent_heads
 FOR EACH ROW EXECUTE FUNCTION private.strata_guard_consent_head_transition();

COMMIT;
