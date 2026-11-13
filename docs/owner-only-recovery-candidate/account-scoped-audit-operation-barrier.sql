-- Inactive supplemental candidate. Requires exposure/lifecycle barriers first.
-- No enrollment, grants or automatic production installation.
CREATE TRIGGER scoped_recovery_event_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.v13_production_event
 FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_exposure('account_id');
CREATE TRIGGER scoped_recovery_control_head_barrier BEFORE INSERT OR UPDATE OR DELETE ON private.strata_owner_control_heads
 FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_exposure('execution_account_id');
CREATE FUNCTION private.fence_scoped_recovery_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old_id text;new_id text;target text;owner uuid;n integer;
BEGIN
 IF TG_OP<>'INSERT' THEN old_id:=OLD.financial_account_id::text; END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.financial_account_id::text; END IF;
 SELECT s.account_id,s.owner_id INTO target,owner FROM private.owner_recovery_barrier_scope s
 JOIN public.v13_production_account a ON a.id=s.account_id AND a.owner_user_id=s.owner_id
 WHERE a.kalshi_connection_id::text IN(old_id,new_id);
 IF target IS NOT NULL THEN
  UPDATE public.v13_production_account SET revision=revision+1 WHERE id=target AND owner_user_id=owner;
  GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'owner_recovery_scope_unverified'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.fence_scoped_recovery_attempt() FROM PUBLIC;
CREATE TRIGGER scoped_recovery_operation_barrier BEFORE INSERT OR UPDATE OR DELETE ON private.kalshi_account_operation_attempts
 FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_attempt();
-- Audit receipts do not change the financial revision they attest. Serialize
-- their writes without a revision increment, avoiding a self-invalidating receipt.
CREATE FUNCTION private.lock_scoped_recovery_observation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old_id text;new_id text;
BEGIN
 IF TG_OP<>'INSERT' THEN old_id:=OLD.account_id; END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.account_id; END IF;
 PERFORM a.id FROM public.v13_production_account a JOIN private.owner_recovery_barrier_scope s ON s.account_id=a.id AND s.owner_id=a.owner_user_id
 WHERE a.id IN(old_id,new_id) FOR UPDATE OF a;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.lock_scoped_recovery_observation() FROM PUBLIC;
CREATE TRIGGER scoped_recovery_observation_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.v13_production_observation
 FOR EACH ROW EXECUTE FUNCTION private.lock_scoped_recovery_observation();
CREATE TRIGGER scoped_recovery_event_truncate BEFORE TRUNCATE ON public.v13_production_event EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
CREATE TRIGGER scoped_recovery_observation_truncate BEFORE TRUNCATE ON public.v13_production_observation EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
CREATE TRIGGER scoped_recovery_attempt_truncate BEFORE TRUNCATE ON private.kalshi_account_operation_attempts EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
CREATE TRIGGER scoped_recovery_control_truncate BEFORE TRUNCATE ON private.strata_owner_control_heads EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
CREATE TRIGGER scoped_recovery_intent_truncate BEFORE TRUNCATE ON public.v13_production_intent EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
CREATE TRIGGER scoped_recovery_position_truncate BEFORE TRUNCATE ON public.v13_production_position EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
CREATE TRIGGER scoped_recovery_exit_truncate BEFORE TRUNCATE ON private.strata_emergency_exit_reservations EXECUTE FUNCTION private.refuse_enrolled_recovery_truncate();
