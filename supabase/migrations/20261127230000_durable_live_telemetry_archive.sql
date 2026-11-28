-- Durable, append-only archive scheduling for COMMITTED live observations.
-- No trading permission, pricing, fee, risk or owner-account mutation.
-- This migration is staged and MUST NOT be applied while live execution is running.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
CREATE SCHEMA IF NOT EXISTS private;

DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_telemetry_archiver') THEN
   -- LOGIN has no password: an independently reviewed setup must provision the
   -- private database credential. No inherited or broad schema grants.
   CREATE ROLE strata_telemetry_archiver LOGIN NOINHERIT;
 END IF;
END $roles$;

CREATE TABLE IF NOT EXISTS private.strata_telemetry_archive_batch_v1 (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 observed_day date NOT NULL,
 state text NOT NULL DEFAULT 'LEASED' CHECK(state IN ('LEASED','RETRY','ARCHIVED')),
 lease_token uuid NOT NULL,
 leased_until timestamptz NOT NULL,
 retry_after timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 2147483647),
 event_count integer NOT NULL CHECK(event_count BETWEEN 1 AND 10000),
 object_key text UNIQUE NOT NULL CHECK(length(object_key) BETWEEN 32 AND 300),
 object_version_id text,
 compressed_sha256 text CHECK(compressed_sha256 IS NULL OR compressed_sha256 ~ '^[a-f0-9]{64}$'),
 uncompressed_sha256 text CHECK(uncompressed_sha256 IS NULL OR uncompressed_sha256 ~ '^[a-f0-9]{64}$'),
 compressed_bytes bigint CHECK(compressed_bytes IS NULL OR compressed_bytes > 0),
 last_error_code text CHECK(last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{3,100}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 archived_at timestamptz,
 CONSTRAINT archive_complete_evidence CHECK (
  state <> 'ARCHIVED' OR
  (archived_at IS NOT NULL AND object_version_id IS NOT NULL
   AND compressed_sha256 IS NOT NULL AND uncompressed_sha256 IS NOT NULL AND compressed_bytes IS NOT NULL)
 )
);
CREATE INDEX IF NOT EXISTS strata_archive_retry_v1 ON private.strata_telemetry_archive_batch_v1 (retry_after,leased_until,id)
 WHERE state IN ('LEASED','RETRY');
CREATE INDEX IF NOT EXISTS strata_archive_owner_v1 ON private.strata_telemetry_archive_batch_v1
 (owner_user_id,observed_day,created_at);

CREATE TABLE IF NOT EXISTS private.strata_telemetry_archive_queue_v1 (
 event_id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL,
 execution_account_id text NOT NULL,
 observed_day date NOT NULL,
 recorded_at timestamptz NOT NULL,
 archive_batch_id uuid REFERENCES private.strata_telemetry_archive_batch_v1(id),
 archive_confirmed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT archive_ack_requires_batch CHECK(archive_confirmed_at IS NULL OR archive_batch_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS strata_archive_unbatched_v1
 ON private.strata_telemetry_archive_queue_v1(recorded_at,event_id) WHERE archive_batch_id IS NULL;
CREATE INDEX IF NOT EXISTS strata_archive_batch_rows_v1
 ON private.strata_telemetry_archive_queue_v1(archive_batch_id,recorded_at,event_id);
CREATE INDEX IF NOT EXISTS strata_archive_owner_day_v1
 ON private.strata_telemetry_archive_queue_v1(owner_user_id,observed_day,recorded_at,event_id);

CREATE TABLE IF NOT EXISTS private.strata_telemetry_capture_health_v1 (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 instance_id uuid NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 accepted bigint NOT NULL CHECK(accepted>=0),
 confirmed bigint NOT NULL CHECK(confirmed>=0),
 overflow bigint NOT NULL CHECK(overflow>=0),
 retry_exhausted bigint NOT NULL CHECK(retry_exhausted>=0),
 rejected bigint NOT NULL CHECK(rejected>=0),
 invalid bigint NOT NULL CHECK(invalid>=0),
 pending integer NOT NULL CHECK(pending>=0),
 CONSTRAINT capture_report_valid CHECK(confirmed<=accepted)
);
CREATE INDEX IF NOT EXISTS strata_capture_instance_time_v1
 ON private.strata_telemetry_capture_health_v1(instance_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS strata_capture_report_time_v1
 ON private.strata_telemetry_capture_health_v1(observed_at DESC);

CREATE OR REPLACE FUNCTION private.strata_enqueue_committed_telemetry_v1()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path = pg_catalog,private AS $$
BEGIN
 INSERT INTO private.strata_telemetry_archive_queue_v1
  (event_id,owner_user_id,execution_account_id,observed_day,recorded_at)
 VALUES (NEW.id,NEW.owner_user_id,NEW.execution_account_id,(NEW.observed_at AT TIME ZONE 'UTC')::date,NEW.recorded_at)
 ON CONFLICT(event_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_enqueue_committed_telemetry_v1() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS strata_telemetry_archive_on_insert_v1 ON private.strata_live_decision_log_v1;
CREATE TRIGGER strata_telemetry_archive_on_insert_v1
 AFTER INSERT ON private.strata_live_decision_log_v1
 FOR EACH ROW EXECUTE FUNCTION private.strata_enqueue_committed_telemetry_v1();

ALTER TABLE private.strata_telemetry_archive_batch_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_telemetry_archive_queue_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_telemetry_capture_health_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_telemetry_archive_batch_v1 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON private.strata_telemetry_archive_queue_v1 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON private.strata_telemetry_capture_health_v1 FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA private TO strata_telemetry_archiver;
GRANT SELECT,INSERT,UPDATE ON private.strata_telemetry_archive_batch_v1 TO strata_telemetry_archiver;
GRANT SELECT,INSERT,UPDATE ON private.strata_telemetry_archive_queue_v1 TO strata_telemetry_archiver;
GRANT SELECT ON private.strata_live_decision_log_v1,public.v13_production_account TO strata_telemetry_archiver;
CREATE POLICY strata_archiver_source_read_v1 ON private.strata_live_decision_log_v1
 FOR SELECT TO strata_telemetry_archiver USING(true);
GRANT SELECT ON private.strata_telemetry_capture_health_v1 TO strata_telemetry_archiver;
CREATE POLICY strata_archiver_batch_rw_v1 ON private.strata_telemetry_archive_batch_v1
 FOR ALL TO strata_telemetry_archiver USING(true) WITH CHECK(true);
CREATE POLICY strata_archiver_queue_read_v1 ON private.strata_telemetry_archive_queue_v1
 FOR SELECT TO strata_telemetry_archiver USING(true);
CREATE POLICY strata_archiver_queue_insert_v1 ON private.strata_telemetry_archive_queue_v1
 FOR INSERT TO strata_telemetry_archiver WITH CHECK(true);
CREATE POLICY strata_archiver_queue_update_v1 ON private.strata_telemetry_archive_queue_v1
 FOR UPDATE TO strata_telemetry_archiver USING(true) WITH CHECK(true);
CREATE POLICY strata_archiver_capture_read_v1 ON private.strata_telemetry_capture_health_v1
 FOR SELECT TO strata_telemetry_archiver USING(true);
-- The API's monitoring heartbeat is insert-only, never access to archive jobs or account data.
DO $grant$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
  GRANT INSERT ON private.strata_telemetry_capture_health_v1 TO strata_api_runtime;
  GRANT USAGE ON SEQUENCE private.strata_telemetry_capture_health_v1_id_seq TO strata_api_runtime;
  EXECUTE 'CREATE POLICY strata_api_capture_insert_v1 ON private.strata_telemetry_capture_health_v1 FOR INSERT TO strata_api_runtime WITH CHECK(true)';
 END IF;
END $grant$;
COMMIT;
