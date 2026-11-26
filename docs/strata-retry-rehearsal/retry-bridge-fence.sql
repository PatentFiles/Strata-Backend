-- Dormant review artifact. Install only in an orders-off activated rehearsal.
BEGIN;
ALTER TABLE private.strata_direct_retry_release
 ADD COLUMN replacement_enabled boolean NOT NULL DEFAULT false;

-- Receipt and replacement are separate switches. Both change under the same
-- account lock serialized with receipt issuance, observations and PREPARE.
CREATE FUNCTION private.strata_stop_worker_direct_retry(a text)
RETURNS boolean SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM 1 FROM public.v13_production_account WHERE id=a FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE private.strata_direct_retry_release SET receipt_enabled=false,replacement_enabled=false WHERE account_id=a;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION private.strata_stop_worker_direct_retry(text) FROM PUBLIC;

CREATE FUNCTION private.strata_fence_direct_retry_replacement() RETURNS trigger
SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE enabled boolean;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'retry_fence_requires_read_committed';
 END IF;
 PERFORM 1 FROM public.v13_production_account WHERE id=NEW.account_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.strata_direct_entry_current c
   WHERE c.account_id=NEW.account_id AND c.crossing_key=NEW.crossing_key)
 THEN
  SELECT r.replacement_enabled INTO enabled
   FROM private.strata_direct_retry_release r WHERE r.account_id=NEW.account_id FOR SHARE;
  IF enabled IS DISTINCT FROM true THEN RETURN NULL; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_fence_direct_retry_replacement() FROM PUBLIC;
CREATE TRIGGER strata_retry_generation_before_observation BEFORE INSERT ON public.strata_direct_entry_source
 FOR EACH ROW EXECUTE FUNCTION private.strata_fence_direct_retry_replacement();

-- Prevent an already captured generation-2 source from becoming a new
-- reservation after the stop. Existing intents/reconciliation are unchanged.
CREATE FUNCTION private.strata_fence_direct_retry_intent_after_stop() RETURNS trigger
SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE enabled boolean;
BEGIN
 IF NEW.kind='ENTRY' AND NEW.direct_source_id IS NOT NULL THEN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
   RAISE EXCEPTION 'retry_fence_requires_read_committed';
  END IF;
  PERFORM 1 FROM public.v13_production_account WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retry_account_not_found'; END IF;
  IF EXISTS(SELECT 1 FROM public.strata_direct_entry_current c WHERE c.account_id=NEW.account_id
     AND c.crossing_key=NEW.crossing_key AND c.source_id=NEW.direct_source_id AND c.generation=2)
  THEN
   SELECT r.replacement_enabled INTO enabled
    FROM private.strata_direct_retry_release r WHERE r.account_id=NEW.account_id FOR SHARE;
   IF enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'direct_retry_replacement_disabled'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_fence_direct_retry_intent_after_stop() FROM PUBLIC;
CREATE TRIGGER strata_retry_generation_before_intent BEFORE INSERT ON public.v13_production_intent
 FOR EACH ROW EXECUTE FUNCTION private.strata_fence_direct_retry_intent_after_stop();
COMMIT;
