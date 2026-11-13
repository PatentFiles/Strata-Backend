-- Candidate only: requires independent review and controlled release sequencing.
-- Stores the exact signed order request to make UNKNOWN restart recovery possible.
-- No permissions, execution approvals, positions or market orders are created.
BEGIN;
ALTER TABLE private.strata_emergency_exit_reservations
 ADD COLUMN IF NOT EXISTS order_request_json text;
-- Never synthesize historical request bodies. If prior reservations exist,
-- refuse this migration until an owner-reviewed evidence recovery plan exists.
DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations
           WHERE order_request_json IS NULL)
 THEN RAISE EXCEPTION 'cannot backfill immutable protective exit request';
 END IF;
END $guard$;
ALTER TABLE private.strata_emergency_exit_reservations
 ALTER COLUMN order_request_json SET NOT NULL;
ALTER TABLE private.strata_emergency_exit_reservations
 ADD CONSTRAINT strata_exit_request_json_valid
 CHECK (length(order_request_json) BETWEEN 30 AND 4096
    AND jsonb_typeof(order_request_json::jsonb)='object');
CREATE OR REPLACE FUNCTION private.strata_protective_exit_order_request_guard()
 RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
BEGIN
 IF NEW.order_request_json IS DISTINCT FROM OLD.order_request_json THEN
  RAISE EXCEPTION 'immutable protective exit order request cannot change'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $guard$;
DROP TRIGGER IF EXISTS strata_protective_exit_order_request_guard
 ON private.strata_emergency_exit_reservations;
CREATE TRIGGER strata_protective_exit_order_request_guard
 BEFORE UPDATE ON private.strata_emergency_exit_reservations FOR EACH ROW
 EXECUTE FUNCTION private.strata_protective_exit_order_request_guard();
REVOKE ALL ON FUNCTION private.strata_protective_exit_order_request_guard()
 FROM PUBLIC,anon,authenticated;
COMMIT;
