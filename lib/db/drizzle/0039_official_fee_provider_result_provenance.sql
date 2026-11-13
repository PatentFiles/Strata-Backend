-- #165: Distinguish an actual upstream provider HTTP response from the
-- project-wide shared lease (which itself is not a provider 429).
-- Never grants monetary authority, changes captured PDF identity, owner
-- policy, cash, exit qualifications or live execution flags.
BEGIN;
ALTER TABLE public.strata_official_fee_capture_throttle
  ADD COLUMN IF NOT EXISTS last_provider_http_status integer,
  ADD COLUMN IF NOT EXISTS last_provider_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_provider_retry_at timestamptz;
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE conname='strata_fee_provider_http_status_valid'
    AND conrelid='public.strata_official_fee_capture_throttle'::regclass
 ) THEN
  ALTER TABLE public.strata_official_fee_capture_throttle
   ADD CONSTRAINT strata_fee_provider_http_status_valid
   CHECK(last_provider_http_status IS NULL OR
         last_provider_http_status BETWEEN 200 AND 599);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.strata_record_official_fee_provider_result(
 p_status integer, p_retry_at timestamptz DEFAULT NULL
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
 n timestamptz := clock_timestamp();
 deadline timestamptz;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'service role required' USING ERRCODE='42501';
 END IF;
 IF p_status IS NULL OR p_status<200 OR p_status>599 THEN
  RAISE EXCEPTION 'invalid provider HTTP status' USING ERRCODE='22023';
 END IF;
 IF p_status <> 429 AND p_retry_at IS NOT NULL THEN
  RAISE EXCEPTION 'unexpected retry deadline' USING ERRCODE='22023';
 END IF;
 IF p_retry_at IS NOT NULL AND
  (p_retry_at<n-interval '5 seconds' OR
   p_retry_at>n+interval '24 hours') THEN
  RAISE EXCEPTION 'retry deadline out of bounds' USING ERRCODE='22023';
 END IF;
 UPDATE public.strata_official_fee_capture_throttle
 SET last_provider_http_status=p_status,
     last_provider_at=n,
     last_provider_retry_at=CASE WHEN p_status=429 THEN
       GREATEST(next_allowed_at,COALESCE(p_retry_at,next_allowed_at))
       ELSE NULL END,
     next_allowed_at=CASE WHEN p_status=429 THEN
       GREATEST(next_allowed_at,COALESCE(p_retry_at,next_allowed_at))
       ELSE next_allowed_at END
 WHERE id=true
 RETURNING next_allowed_at INTO deadline;
 IF deadline IS NULL THEN
  RAISE EXCEPTION 'shared lease row missing' USING ERRCODE='23514';
 END IF;
 RETURN deadline;
END $$;
REVOKE ALL ON FUNCTION public.strata_record_official_fee_provider_result(integer,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.strata_record_official_fee_provider_result(integer,timestamptz)
 TO service_role;
COMMIT;
