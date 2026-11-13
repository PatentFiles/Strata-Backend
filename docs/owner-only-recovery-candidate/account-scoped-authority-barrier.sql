-- OFFLINE CANDIDATE ONLY. Requires existing singleton scope; enrolls nobody.
-- Invoker privileges intentionally fail closed; runtime privilege qualification
-- and SECURITY DEFINER/DDL/external-writer review remain separate prerequisites.
CREATE FUNCTION private.fence_scoped_recovery_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old_key text; new_key text; target text; owner uuid; n integer;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_key := to_jsonb(OLD)->>TG_ARGV[1]; END IF;
 IF TG_OP <> 'DELETE' THEN new_key := to_jsonb(NEW)->>TG_ARGV[1]; END IF;
 SELECT s.account_id,s.owner_id INTO target,owner
 FROM private.owner_recovery_barrier_scope s
 JOIN public.v13_production_account a ON a.id=s.account_id
 WHERE TG_ARGV[0]='global'
 OR (TG_ARGV[0]='connection' AND a.kalshi_connection_id::text IN (old_key,new_key))
 OR (TG_ARGV[0]='policy' AND a.policy_id IN (old_key,new_key));
 IF target IS NOT NULL THEN
  UPDATE public.v13_production_account SET revision=revision+1
  WHERE id=target AND owner_user_id=owner;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'owner_recovery_scope_unverified'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.fence_scoped_recovery_authority() FROM PUBLIC;
CREATE FUNCTION private.refuse_scoped_authority_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM private.owner_recovery_barrier_scope) THEN
  RAISE EXCEPTION 'owner_recovery_authority_truncate_refused';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION private.refuse_scoped_authority_truncate() FROM PUBLIC;
CREATE TRIGGER scoped_recovery_credentials BEFORE INSERT OR UPDATE OR DELETE ON private.kalshi_connection_credentials FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_authority('connection','financial_account_id');
CREATE TRIGGER scoped_recovery_provider BEFORE INSERT OR UPDATE OR DELETE ON private.provider_connections FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_authority('connection','financial_account_id');
CREATE TRIGGER scoped_recovery_financial BEFORE INSERT OR UPDATE OR DELETE ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_authority('connection','id');
CREATE TRIGGER scoped_recovery_policy BEFORE INSERT OR UPDATE OR DELETE ON public.v13_live_money_policy FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_authority('policy','id');
CREATE TRIGGER scoped_recovery_master BEFORE INSERT OR UPDATE OR DELETE ON public.live_execution_config FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_authority('global','id');
CREATE TRIGGER scoped_credentials_truncate BEFORE TRUNCATE ON private.kalshi_connection_credentials EXECUTE FUNCTION private.refuse_scoped_authority_truncate();
CREATE TRIGGER scoped_provider_truncate BEFORE TRUNCATE ON private.provider_connections EXECUTE FUNCTION private.refuse_scoped_authority_truncate();
CREATE TRIGGER scoped_financial_truncate BEFORE TRUNCATE ON public.financial_accounts EXECUTE FUNCTION private.refuse_scoped_authority_truncate();
CREATE TRIGGER scoped_policy_truncate BEFORE TRUNCATE ON public.v13_live_money_policy EXECUTE FUNCTION private.refuse_scoped_authority_truncate();
CREATE TRIGGER scoped_master_truncate BEFORE TRUNCATE ON public.live_execution_config EXECUTE FUNCTION private.refuse_scoped_authority_truncate();
