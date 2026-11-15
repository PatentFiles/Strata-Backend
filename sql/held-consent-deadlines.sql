-- LOCAL UNAPPLIED proposal; invoker-only triggers, no new roles/grants/tables.
BEGIN;
-- LOCAL CANDIDATE. Mandatory deferred freshness guard for an enabling release.
-- Invoker-only, no elevated privileges or production grant changes.
CREATE FUNCTION private.enforce_held_consent_signed_deadline()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE observed timestamptz;
BEGIN
 observed:=to_timestamp((NEW.payload->>'providerReadAtMs')::double precision/1000);
 IF observed IS NULL OR NOT isfinite(observed) OR observed>clock_timestamp()
    OR clock_timestamp()>=observed+interval '5 seconds' THEN
   RAISE EXCEPTION 'held_consent_signed_evidence_expired' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION private.enforce_held_consent_signed_deadline() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER held_consent_signed_deadline
AFTER INSERT ON public.v13_production_observation DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.kind='OWNER_HELD_SHA_CONSENT')
EXECUTE FUNCTION private.enforce_held_consent_signed_deadline();

-- LOCAL CANDIDATE. Mandatory deferred freshness guard for an enabling release.
-- Invoker-only, no elevated privileges or production grant changes.
CREATE FUNCTION private.enforce_final_release_signed_deadline()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE observed timestamptz;
BEGIN
 observed:=to_timestamp((NEW.payload->>'observedAtMs')::double precision/1000);
 IF observed IS NULL OR NOT isfinite(observed) OR observed>clock_timestamp()
    OR clock_timestamp()>=observed+interval '5 seconds' THEN
   RAISE EXCEPTION 'final_release_signed_evidence_expired' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION private.enforce_final_release_signed_deadline() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER final_release_signed_deadline
AFTER INSERT ON public.v13_production_observation DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.kind='OWNER_RELEASE_SIGNED_RECHECK')
EXECUTE FUNCTION private.enforce_final_release_signed_deadline();

COMMIT;
