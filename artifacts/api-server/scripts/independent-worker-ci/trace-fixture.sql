-- Disposable PG fixture only. No production registration or writer grants.
CREATE TABLE public.strata_shadow_signal_trace(
 account_id text NOT NULL,
 crossing_key text NOT NULL,
 direct_source_id text NOT NULL,
 probe_phase text NOT NULL CHECK(probe_phase IN
   ('SOURCE_OBSERVED','PREPARE_ACCEPTED_NO_SUBMIT','PREPARE_REFUSED')),
 observed_at timestamptz NOT NULL,
 oldest_age_ms integer NOT NULL CHECK(oldest_age_ms>=0),
 CHECK(probe_phase<>'PREPARE_ACCEPTED_NO_SUBMIT' OR oldest_age_ms<=5000),
 PRIMARY KEY(account_id,direct_source_id,probe_phase),
 FOREIGN KEY(direct_source_id,account_id,crossing_key)
   REFERENCES public.strata_direct_entry_source(id,account_id,crossing_key)
);
ALTER TABLE public.strata_shadow_signal_trace ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.strata_shadow_signal_trace FROM PUBLIC;
CREATE FUNCTION public.strata_shadow_signal_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE observed timestamptz; oldest timestamptz; closes timestamptz;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'shadow_audit_append_only'; END IF;
 SELECT s.observed_at,s.oldest_source_at,s.closes_at INTO observed,oldest,closes
 FROM public.strata_direct_entry_source s WHERE
 (s.id,s.account_id,s.crossing_key)=(NEW.direct_source_id,NEW.account_id,NEW.crossing_key);
 IF NOT FOUND OR NEW.observed_at<observed OR
    floor(extract(epoch FROM (NEW.observed_at-oldest))*1000)<>NEW.oldest_age_ms OR
    (NEW.probe_phase='PREPARE_ACCEPTED_NO_SUBMIT' AND
      (NEW.observed_at>=closes OR NEW.observed_at-oldest>interval '5 seconds')) THEN
  RAISE EXCEPTION 'shadow_scope_or_age_unverified';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_shadow_signal_audit_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.strata_shadow_signal_trace FOR EACH ROW
 EXECUTE FUNCTION public.strata_shadow_signal_audit_guard();
