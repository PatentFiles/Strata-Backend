-- REVIEW/ORDERS-OFF ONLY. Not in the production migration journal.
-- Apply only to a disposable database while testing the matched V2 binary.
BEGIN;
CREATE TABLE public.strata_direct_entry_refusal (
 source_id text PRIMARY KEY,
 account_id text NOT NULL,
 crossing_key text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 reason text NOT NULL CHECK(reason='FIRST_MARKET_READ_EVENT_FEE_UNVERIFIED_BEFORE_TX'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(source_id,account_id,crossing_key) REFERENCES public.strata_direct_entry_source(id,account_id,crossing_key)
);
CREATE TABLE public.strata_direct_entry_current (
 account_id text NOT NULL,
 crossing_key text NOT NULL,
 source_id text NOT NULL,
 generation smallint NOT NULL DEFAULT 1 CHECK(generation IN (1,2)),
 PRIMARY KEY(account_id,crossing_key),
 FOREIGN KEY(source_id,account_id,crossing_key) REFERENCES public.strata_direct_entry_source(id,account_id,crossing_key)
);
ALTER TABLE public.strata_direct_entry_refusal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strata_direct_entry_current ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.strata_direct_entry_refusal, public.strata_direct_entry_current FROM PUBLIC;
CREATE TRIGGER strata_direct_refusal_immutable BEFORE UPDATE OR DELETE ON public.strata_direct_entry_refusal
 FOR EACH ROW EXECUTE FUNCTION public.strata_direct_source_immutable();

-- The trusted first-read handler calls this with the pinned evidence digest.
-- No EXECUTE grant here. Generic worker analytics cannot issue a receipt.
CREATE FUNCTION public.strata_record_first_market_fee_refusal(a text,k text,s text,h text)
RETURNS boolean SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'retry_fence_requires_read_committed'; END IF;
 PERFORM 1 FROM public.v13_production_account
 WHERE id=a AND reserved_micros=0 AND blocked_reason IS NULL FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.v13_production_intent WHERE account_id=a AND
  (crossing_key=k OR state IN ('UNKNOWN','DISPATCHED'))) OR NOT EXISTS(
  SELECT 1 FROM public.strata_direct_entry_current c JOIN public.strata_direct_entry_source o ON o.id=c.source_id
  WHERE c.account_id=a AND c.crossing_key=k AND c.source_id=s AND c.generation=1 AND o.evidence_sha256=h)
 THEN RETURN false; END IF;
 INSERT INTO public.strata_direct_entry_refusal(source_id,account_id,crossing_key,source_sha256,reason)
 VALUES(s,a,k,h,'FIRST_MARKET_READ_EVENT_FEE_UNVERIFIED_BEFORE_TX') ON CONFLICT DO NOTHING;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.strata_record_first_market_fee_refusal(text,text,text,text) FROM PUBLIC;

-- Trigger-guarded candidate publication plus a pinned current source. The
-- database does not authenticate provider evidence; the existing sealed source
-- path still has to do that. Historical sources stay immutable.
CREATE FUNCTION public.strata_fence_direct_entry_observation() RETURNS trigger
 SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE previous_id text; previous_at timestamptz; previous_oldest timestamptz; previous_generation smallint; sample_at timestamptz;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'retry_fence_requires_read_committed'; END IF;
 PERFORM 1 FROM public.v13_production_account
 WHERE id=NEW.account_id AND reserved_micros=0 AND blocked_reason IS NULL FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.v13_production_intent WHERE account_id=NEW.account_id AND
  (crossing_key=NEW.crossing_key OR state IN ('UNKNOWN','DISPATCHED'))) THEN RETURN NULL; END IF;
 sample_at:=clock_timestamp();
 IF sample_at<NEW.observed_at OR sample_at-NEW.oldest_source_at>interval '5 seconds' OR sample_at>=NEW.closes_at THEN RETURN NULL; END IF;
 SELECT o.id,o.observed_at,o.oldest_source_at,c.generation INTO previous_id,previous_at,previous_oldest,previous_generation
 FROM public.strata_direct_entry_current c JOIN public.strata_direct_entry_source o ON o.id=c.source_id
 WHERE c.account_id=NEW.account_id AND c.crossing_key=NEW.crossing_key;
 IF FOUND AND (previous_generation<>1 OR previous_at>=NEW.observed_at OR previous_oldest>=NEW.oldest_source_at OR NOT EXISTS(SELECT 1 FROM public.strata_direct_entry_refusal WHERE source_id=previous_id))
 THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.strata_fence_direct_entry_observation() FROM PUBLIC;
CREATE FUNCTION public.strata_set_direct_entry_current() RETURNS trigger
 SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'retry_fence_requires_read_committed'; END IF;
 INSERT INTO public.strata_direct_entry_current(account_id,crossing_key,source_id) VALUES(NEW.account_id,NEW.crossing_key,NEW.id)
 ON CONFLICT(account_id,crossing_key) DO UPDATE SET source_id=EXCLUDED.source_id,
 generation=public.strata_direct_entry_current.generation+1;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.strata_set_direct_entry_current() FROM PUBLIC;
CREATE FUNCTION public.strata_fence_retired_direct_intent() RETURNS trigger
 SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'retry_fence_requires_read_committed'; END IF;
 IF NEW.kind='ENTRY' AND NEW.direct_source_id IS NOT NULL THEN
  PERFORM 1 FROM public.v13_production_account WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(
   SELECT 1 FROM public.strata_direct_entry_current c
   WHERE c.account_id=NEW.account_id AND c.crossing_key=NEW.crossing_key AND c.source_id=NEW.direct_source_id
    AND NOT EXISTS(SELECT 1 FROM public.strata_direct_entry_refusal r WHERE r.source_id=c.source_id)
  ) THEN RAISE EXCEPTION 'retired_or_noncurrent_direct_source'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.strata_fence_retired_direct_intent() FROM PUBLIC;

COMMIT;
