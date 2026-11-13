-- OFFLINE CANDIDATE. Requires owner_recovery_barrier_scope singleton table.
-- Does not enroll anyone. Refuse identity reset/ABA while recovery is enrolled;
-- administrative migration/removal is deliberately outside runtime authority.
CREATE FUNCTION private.protect_scoped_recovery_lease_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE enrolled boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM private.owner_recovery_barrier_scope s
  WHERE s.account_id=OLD.execution_account_id OR (TG_OP='UPDATE' AND s.account_id=NEW.execution_account_id)) INTO enrolled;
 IF enrolled THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'enrolled_recovery_lease_delete_refused'; END IF;
  IF NEW.execution_account_id IS DISTINCT FROM OLD.execution_account_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
   OR NEW.fencing_token<OLD.fencing_token OR NEW.consent_epoch<OLD.consent_epoch
  THEN RAISE EXCEPTION 'enrolled_recovery_lease_identity_or_generation_reset'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER zz_scoped_recovery_lease_lifecycle BEFORE UPDATE OR DELETE ON private.kalshi_account_worker_lease FOR EACH ROW EXECUTE FUNCTION private.protect_scoped_recovery_lease_lifecycle();
CREATE FUNCTION private.refuse_enrolled_recovery_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM private.owner_recovery_barrier_scope) THEN RAISE EXCEPTION 'enrolled_recovery_truncate_refused'; END IF;RETURN NULL;
END $$;
CREATE TRIGGER scoped_recovery_lease_truncate BEFORE TRUNCATE ON private.kalshi_account_worker_lease FOR EACH STATEMENT EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
CREATE FUNCTION private.protect_recovery_scope_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'recovery_scope_runtime_removal_refused';END $$;
CREATE TRIGGER scoped_recovery_scope_immutable BEFORE UPDATE OR DELETE ON private.owner_recovery_barrier_scope FOR EACH ROW EXECUTE FUNCTION private.protect_recovery_scope_lifecycle();
CREATE TRIGGER scoped_recovery_scope_truncate BEFORE TRUNCATE ON private.owner_recovery_barrier_scope FOR EACH STATEMENT EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
REVOKE ALL ON FUNCTION private.protect_scoped_recovery_lease_lifecycle(),private.refuse_enrolled_recovery_truncate(),private.protect_recovery_scope_lifecycle() FROM PUBLIC;
-- DDL owners/superusers can bypass triggers: roles and all other credential,
-- policy/control writer tables still need separate qualification.
