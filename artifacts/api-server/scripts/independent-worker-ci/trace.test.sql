INSERT INTO strata_direct_entry_source VALUES
 ('src-a','A','M','M:first','2026-01-01 00:00:01Z','2026-01-01 00:00:00Z','2026-01-01 00:00:10Z','{}',encode(sha256(convert_to('{}','UTF8')),'hex'));
INSERT INTO strata_shadow_signal_trace VALUES
 ('A','M:first','src-a','SOURCE_OBSERVED','2026-01-01 00:00:01Z',1000),
 ('A','M:first','src-a','PREPARE_ACCEPTED_NO_SUBMIT','2026-01-01 00:00:05Z',5000),
 ('A','M:first','src-a','PREPARE_REFUSED','2026-01-01 00:00:05.001Z',5001);
CREATE FUNCTION assert_rejected(s text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE s; EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation THEN RETURN; END;
 RAISE check_violation USING MESSAGE='fixture accepted forbidden change';
END $$;
SELECT assert_rejected($$INSERT INTO strata_shadow_signal_trace VALUES
 ('B','M:first','src-a','SOURCE_OBSERVED','2026-01-01 00:00:01Z',1000)$$);
SELECT assert_rejected($$INSERT INTO strata_shadow_signal_trace VALUES
 ('A','N:first','src-a','SOURCE_OBSERVED','2026-01-01 00:00:01Z',1000)$$);
SELECT assert_rejected($$INSERT INTO strata_shadow_signal_trace VALUES
 ('A','M:first','src-a','PREPARE_ACCEPTED_NO_SUBMIT','2026-01-01 00:00:05.000001Z',5000)$$);
SELECT assert_rejected($$INSERT INTO strata_shadow_signal_trace VALUES
 ('A','M:first','src-a','DISPATCH_COMPLETED','2026-01-01 00:00:05Z',5000)$$);
SELECT assert_rejected($$INSERT INTO strata_shadow_signal_trace VALUES
 ('A','M:first','src-a','SOURCE_OBSERVED','2026-01-01 00:00:01Z',1000)$$);
SELECT assert_rejected($$UPDATE strata_shadow_signal_trace SET oldest_age_ms=1$$);
SELECT assert_rejected($$DELETE FROM strata_shadow_signal_trace$$);
DO $$ BEGIN
 IF (SELECT count(*) FROM strata_shadow_signal_trace)<>3 OR
    (SELECT count(*) FROM v13_production_intent)<>1 THEN
 RAISE EXCEPTION 'unexpected writes'; END IF;
END $$;
-- Reproduce the essential 0044 dependency without adding a fake paper row.
CREATE TABLE public.fixture_legacy_trace (
  evaluation_id text NOT NULL REFERENCES public.forward_test_evaluations(id),
  phase text NOT NULL
);
SELECT assert_rejected($$INSERT INTO public.fixture_legacy_trace VALUES ('src-a','QUALIFYING_SEEN')$$);
-- A separate source-aware catch-up can find an unobserved direct row without
-- depending on paper or promoting an expired signal to actionable evidence.
INSERT INTO public.strata_direct_entry_source VALUES
 ('src-a-missed','A','M2','M2:first','2026-01-01 00:00:02Z','2026-01-01 00:00:01Z','2026-01-01 00:00:10Z','{}',encode(sha256(convert_to('{}','UTF8')),'hex')),
 ('src-b-missed','B','M2','M2:first','2026-01-01 00:00:02Z','2026-01-01 00:00:01Z','2026-01-01 00:00:10Z','{}',encode(sha256(convert_to('{}','UTF8')),'hex'));
DO $$
DECLARE got text[];
BEGIN
 SELECT array_agg(x.id) INTO got FROM (
   SELECT s.id FROM public.strata_direct_entry_source s
   WHERE s.account_id='A' AND s.observed_at<='2026-01-01 00:00:03Z'::timestamptz
     AND NOT EXISTS (
       SELECT 1 FROM public.strata_shadow_signal_trace t
        WHERE t.account_id=s.account_id AND t.direct_source_id=s.id AND t.probe_phase='SOURCE_OBSERVED')
   ORDER BY s.observed_at,s.id LIMIT 100
 ) x;
 IF got IS DISTINCT FROM ARRAY['src-a-missed']::text[] THEN RAISE EXCEPTION 'unseen replay scope incorrect'; END IF;
END $$;
