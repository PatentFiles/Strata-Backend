-- Inactive candidate: prevent enrolled identity/generation rewind by any SQL
-- caller. Does not enroll accounts, grant roles, or grant release authority.
-- Keep reconciliation financial revision semantics: same-value/control writes
-- are serialized by the account lock and their existing lease/control epochs.
CREATE FUNCTION private.protect_scoped_account_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scoped_owner uuid;
BEGIN
 SELECT owner_id INTO scoped_owner FROM private.owner_recovery_barrier_scope
 WHERE account_id=OLD.id;
 IF scoped_owner IS NOT NULL THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'enrolled_account_delete_refused'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM scoped_owner
   OR OLD.owner_user_id IS DISTINCT FROM scoped_owner THEN
   RAISE EXCEPTION 'enrolled_account_identity_change_refused';
  END IF;
  IF NEW.revision IS NULL OR NEW.revision<OLD.revision THEN
   RAISE EXCEPTION 'enrolled_account_revision_rewind_refused';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.protect_scoped_account_generation() FROM PUBLIC;
CREATE TRIGGER scoped_recovery_account_generation BEFORE UPDATE OR DELETE ON public.v13_production_account
 FOR EACH ROW EXECUTE FUNCTION private.protect_scoped_account_generation();
CREATE TRIGGER scoped_recovery_account_truncate BEFORE TRUNCATE ON public.v13_production_account
 EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
