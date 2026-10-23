-- Security hardening: pin two existing private trigger functions to immutable
-- trusted PostgreSQL built-ins. Both functions refer to other tables using
-- explicit schema qualifiers. No DML or account/financial state is changed.
-- See Supabase linter function_search_path_mutable.
BEGIN;
ALTER FUNCTION private.strata_fee_source_prevent_evidence_mutation()
  SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION private.strata_require_two_fee_policy_reviews()
  SET search_path = pg_catalog, pg_temp;
COMMIT;
