-- Read-only administrative operator identity for fee-evidence inspection.
-- It does not approve a document, create a capture, change risk policy or alter execution.
BEGIN;
CREATE OR REPLACE FUNCTION public.strata_can_inspect_pending_fee_artifact()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN private.role_assignments ra ON lower(btrim(ra.email)) = lower(btrim(u.email))
    WHERE u.id = auth.uid()
      AND u.email IS NOT NULL
      AND u.email_confirmed_at IS NOT NULL
      AND ra.role = 'ADMIN'
  );
$$;
REVOKE ALL ON FUNCTION public.strata_can_inspect_pending_fee_artifact() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.strata_can_inspect_pending_fee_artifact() TO authenticated;
COMMIT;
