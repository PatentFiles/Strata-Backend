-- OFFLINE ONLY. No secret values read; no enrollment or grants.
-- Must be tested with the actual Supabase Vault extension and deployment role
-- before migration. Definer/superuser code can disable triggers; this does not
-- claim to defend against a database administrator.
CREATE FUNCTION private.fence_scoped_recovery_vault() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old_id text; new_id text; target text; owner uuid; n integer;
BEGIN
 IF TG_OP<>'INSERT' THEN old_id:=OLD.id::text; END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.id::text; END IF;
 SELECT s.account_id,s.owner_id INTO target,owner
 FROM private.owner_recovery_barrier_scope s
 JOIN public.v13_production_account a ON a.id=s.account_id
 WHERE EXISTS (SELECT 1 FROM private.kalshi_connection_credentials c
   WHERE c.financial_account_id=a.kalshi_connection_id
   AND c.vault_secret_id::text IN(old_id,new_id))
 OR EXISTS (SELECT 1 FROM private.provider_connections p
   WHERE p.financial_account_id=a.kalshi_connection_id
   AND p.vault_secret_id::text IN(old_id,new_id));
 IF target IS NOT NULL THEN
  UPDATE public.v13_production_account SET revision=revision+1
  WHERE id=target AND owner_user_id=owner;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'owner_recovery_scope_unverified'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.fence_scoped_recovery_vault() FROM PUBLIC;
CREATE TRIGGER scoped_recovery_vault BEFORE INSERT OR UPDATE OR DELETE ON vault.secrets FOR EACH ROW EXECUTE FUNCTION private.fence_scoped_recovery_vault();
CREATE TRIGGER scoped_vault_truncate BEFORE TRUNCATE ON vault.secrets EXECUTE FUNCTION private.refuse_scoped_authority_truncate();
