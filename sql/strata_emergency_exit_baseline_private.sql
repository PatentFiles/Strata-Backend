-- REQUIRES independent review. No approval, order or live flag is created.
-- Applied only once the PREPARED reservation table has zero unresolved rows.
-- An immutable pre-submission position baseline is indispensable to crash recovery.
BEGIN;
ALTER TABLE private.strata_emergency_exit_reservations
 ADD COLUMN IF NOT EXISTS initial_position_fp text,
 ADD COLUMN IF NOT EXISTS position_observed_at_ms bigint;
-- Never invent a baseline for an existing reservation. Fail migration rather
-- than defaulting or backfilling a possibly already-submitted order.
ALTER TABLE private.strata_emergency_exit_reservations
 ALTER COLUMN initial_position_fp SET NOT NULL,
 ALTER COLUMN position_observed_at_ms SET NOT NULL;
ALTER TABLE private.strata_emergency_exit_reservations
 ADD CONSTRAINT strata_exit_snapshot_format
 CHECK (
   position_observed_at_ms > 0
   AND ((reducing_side='YES' AND initial_position_fp ~ '^[0-9]{1,9}\\.[0-9]{2}$')
    OR (reducing_side='NO' AND initial_position_fp ~ '^-[0-9]{1,9}\\.[0-9]{2}$'))
 );
CREATE OR REPLACE FUNCTION private.strata_protective_exit_baseline_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF ROW(NEW.initial_position_fp,NEW.position_observed_at_ms)
    IS DISTINCT FROM ROW(OLD.initial_position_fp,OLD.position_observed_at_ms) THEN
   RAISE EXCEPTION 'protective exit original authenticated inventory is immutable'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS strata_protective_exit_baseline_guard
 ON private.strata_emergency_exit_reservations;
CREATE TRIGGER strata_protective_exit_baseline_guard
 BEFORE UPDATE ON private.strata_emergency_exit_reservations
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_exit_baseline_guard();
REVOKE ALL ON FUNCTION private.strata_protective_exit_baseline_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
