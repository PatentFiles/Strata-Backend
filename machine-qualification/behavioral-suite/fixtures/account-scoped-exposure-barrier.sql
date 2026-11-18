-- OFFLINE CANDIDATE ONLY. No account enrolled by this file; not deployed.
-- One explicitly verified account may be enrolled by a separately reviewed step.
CREATE TABLE private.owner_recovery_barrier_scope(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 account_id text UNIQUE NOT NULL REFERENCES public.v13_production_account(id),
 owner_id uuid NOT NULL
);
REVOKE ALL ON private.owner_recovery_barrier_scope FROM PUBLIC;
CREATE FUNCTION private.fence_scoped_recovery_exposure() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old_id text; new_id text; target text; owner uuid; n integer;
BEGIN
 IF TG_OP<>'INSERT' THEN old_id:=to_jsonb(OLD)->>TG_ARGV[0]; END IF;
 IF TG_OP<>'DELETE' THEN new_id:=to_jsonb(NEW)->>TG_ARGV[0]; END IF;
 SELECT s.account_id,s.owner_id INTO target,owner FROM private.owner_recovery_barrier_scope s
 WHERE s.account_id=old_id OR s.account_id=new_id;
 IF target IS NOT NULL THEN
  -- UPDATE takes the same account row lock as recovery and invalidates any
  -- previously issued revision-bound proof, including same-value writes.
  UPDATE public.v13_production_account SET revision=revision+1
  WHERE id=target AND owner_user_id=owner;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'owner_recovery_scope_unverified'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.fence_scoped_recovery_exposure() FROM PUBLIC;
CREATE TRIGGER scoped_recovery_intent_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.v13_production_intent FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_exposure('account_id');
CREATE TRIGGER scoped_recovery_position_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.v13_production_position FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_exposure('account_id');
CREATE TRIGGER scoped_recovery_exit_barrier BEFORE INSERT OR UPDATE OR DELETE ON private.strata_emergency_exit_reservations FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_exposure('execution_account_id');
-- TRUNCATE/DDL/trigger-disable/session_replication_role require denied runtime
-- privileges and separate lifecycle qualification. This file grants none.
