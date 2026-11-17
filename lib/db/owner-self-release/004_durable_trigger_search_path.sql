-- Narrow post-003 hardening. No privilege grants or SECURITY DEFINER conversion.
-- Application must remain stopped/disarmed; a busy schema fails rather than waits.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='12000ms';
ALTER FUNCTION private.durable_fee_model_guard() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION private.durable_fee_state_guard() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION private.durable_observation_immutable() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION private.durable_capture_change_latch() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION private.durable_enrollment_deadline() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION private.durable_migration_scope_guard() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION private.durable_migration_attempt_guard() SET search_path = pg_catalog, pg_temp;
COMMIT;
