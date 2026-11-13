-- Provider-origin fee evidence only. A browser upload must never create an approved artifact.
-- A private Storage object is written through the Storage API, never by editing storage.objects.
BEGIN;
CREATE TABLE IF NOT EXISTS public.strata_official_fee_captures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_url text NOT NULL CHECK (canonical_url = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL CHECK (storage_path ~ '^official/[0-9a-f]{64}\.pdf$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 100 AND 2000000),
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > captured_at AND expires_at <= captured_at + interval '1 hour')
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_official_fee_captures_digest_path_uq
  ON public.strata_official_fee_captures(content_sha256,storage_path,captured_at);
CREATE INDEX IF NOT EXISTS strata_official_fee_captures_recent_idx
  ON public.strata_official_fee_captures(captured_at DESC);
ALTER TABLE public.strata_official_fee_captures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.strata_official_fee_captures FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.strata_official_fee_captures TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.strata_official_fee_captures_id_seq TO service_role;

CREATE TABLE IF NOT EXISTS public.strata_official_fee_capture_throttle (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  next_allowed_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz
);
INSERT INTO public.strata_official_fee_capture_throttle(id) VALUES(true) ON CONFLICT(id) DO NOTHING;
ALTER TABLE public.strata_official_fee_capture_throttle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.strata_official_fee_capture_throttle FROM PUBLIC,anon,authenticated;
GRANT SELECT,UPDATE ON public.strata_official_fee_capture_throttle TO service_role;

CREATE OR REPLACE FUNCTION public.strata_claim_official_fee_capture()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE acquired integer;
BEGIN
  -- This call is made only by the Edge Function's service-role client.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RETURN false; END IF;
  UPDATE public.strata_official_fee_capture_throttle
  SET next_allowed_at = clock_timestamp() + interval '30 minutes'
  WHERE id = true AND next_allowed_at <= clock_timestamp();
  GET DIAGNOSTICS acquired = ROW_COUNT;
  RETURN acquired = 1;
END $$;
REVOKE ALL ON FUNCTION public.strata_claim_official_fee_capture() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.strata_claim_official_fee_capture() TO service_role;
COMMIT;