-- Explicit administrator uploaded documents. Never an issuer HTTP observation.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='12000ms';
ALTER TABLE private.strata_durable_historical_baseline
 DROP CONSTRAINT strata_durable_historical_baseline_baseline_id_check,
 DROP CONSTRAINT strata_durable_historical_baseline_content_sha256_check,
 ADD CONSTRAINT durable_baseline_exact_identity CHECK(
 (baseline_id='repository-july-07-2026-c326a69f-v1' AND content_sha256='c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601')
 OR (content_sha256~'^[a-f0-9]{64}$' AND baseline_id='platform-upload-'||content_sha256));
-- Preserve existing byte hash, effective date, formula and immutable history.
CREATE TABLE private.strata_platform_uploaded_fee_schedule(
 upload_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 baseline_id text NOT NULL UNIQUE REFERENCES private.strata_durable_historical_baseline(baseline_id)
 CHECK(baseline_id~'^platform-upload-[a-f0-9]{64}$'),
 uploader_user_id uuid NOT NULL REFERENCES auth.users(id),
 uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source_url text NOT NULL DEFAULT 'https://kalshi.com/docs/kalshi-fee-schedule.pdf' CHECK(source_url='https://kalshi.com/docs/kalshi-fee-schedule.pdf'),
 attestation text NOT NULL DEFAULT 'PUBLISH_PLATFORM_KALSHI_FEE_PDF_V1' CHECK(attestation='PUBLISH_PLATFORM_KALSHI_FEE_PDF_V1')
);
ALTER TABLE private.strata_platform_uploaded_fee_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_platform_uploaded_fee_schedule FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_platform_uploaded_fee_schedule FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE private.strata_platform_uploaded_fee_schedule_upload_id_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER strata_platform_uploaded_fee_immutable BEFORE UPDATE OR DELETE ON private.strata_platform_uploaded_fee_schedule
 FOR EACH ROW EXECUTE FUNCTION private.durable_observation_immutable();
CREATE FUNCTION private.strata_platform_uploaded_fee_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(1958371201,1);
 IF NOT EXISTS(SELECT 1 FROM auth.users u JOIN public.profiles p ON p.id=u.id
 JOIN private.role_assignments ra ON lower(btrim(ra.email))=lower(btrim(u.email))
 WHERE u.id=NEW.uploader_user_id AND u.email_confirmed_at IS NOT NULL AND p.role='ADMIN' AND ra.role='ADMIN'
 AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())) THEN RAISE EXCEPTION 'platform fee upload admin required';END IF;
 IF NOT EXISTS(SELECT 1 FROM private.strata_durable_historical_baseline b WHERE b.baseline_id=NEW.baseline_id
 AND substring(b.original_bytes from 1 for 5)=decode('255044462d','hex')
 AND NOT EXISTS(SELECT 1 FROM private.strata_platform_official_fee_capture_v1 c WHERE c.content_sha256<>b.content_sha256)
 AND NOT EXISTS(SELECT 1 FROM private.strata_platform_uploaded_fee_schedule u JOIN private.strata_durable_historical_baseline old USING(baseline_id)
 WHERE old.effective_date>b.effective_date)) THEN RAISE EXCEPTION 'upload identity or applicable publication unverified';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_platform_uploaded_fee_guard BEFORE INSERT ON private.strata_platform_uploaded_fee_schedule
 FOR EACH ROW EXECUTE FUNCTION private.strata_platform_uploaded_fee_guard();
CREATE FUNCTION private.strata_platform_uploaded_fee_latch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 UPDATE private.strata_durable_owner_fee_state s SET known_publication_change=true,monitor_state='changed'
 FROM private.strata_durable_owner_fee_model m,private.strata_durable_historical_baseline b
 WHERE m.model_id=s.model_id AND b.baseline_id=NEW.baseline_id AND s.known_publication_change=false
 AND m.official_source_digest<>b.content_sha256;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_platform_uploaded_fee_latch AFTER INSERT ON private.strata_platform_uploaded_fee_schedule
 FOR EACH ROW EXECUTE FUNCTION private.strata_platform_uploaded_fee_latch();
CREATE FUNCTION private.strata_uploaded_fee_model_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.historical_baseline_id LIKE 'platform-upload-%' THEN
  PERFORM pg_advisory_xact_lock_shared(1958371201,1);
  IF NEW.historical_baseline_id IS DISTINCT FROM
   (SELECT baseline_id FROM private.strata_platform_uploaded_fee_schedule ORDER BY upload_id DESC LIMIT 1)
  THEN RAISE EXCEPTION 'active uploaded fee schedule required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_uploaded_fee_model_guard BEFORE INSERT ON private.strata_durable_owner_fee_model
 FOR EACH ROW EXECUTE FUNCTION private.strata_uploaded_fee_model_guard();
ALTER TABLE private.strata_durable_fee_migration
 DROP CONSTRAINT strata_durable_fee_migration_confirmation_check,
 DROP CONSTRAINT durable_migration_source_consent,
 ADD CONSTRAINT durable_migration_source_consent CHECK(
 (source_kind='FRESH_CANONICAL_CAPTURE' AND historical_baseline_id IS NULL AND confirmation='I_APPROVE_ATOMIC_MIGRATION_TO_DURABLE_OFFICIAL_FEE_TERMS_V1' AND risk_acceptance='I_ACCEPT_PUBLICATION_FRESHNESS_MAY_BE_UNKNOWN_AND_UNBOUNDED_FEE_EXITS_MAY_BLOCK_V1')
 OR (source_kind='OWNER_ATTESTED_HISTORICAL_BASELINE' AND historical_baseline_id IS NOT NULL AND
 ((historical_baseline_id='repository-july-07-2026-c326a69f-v1' AND confirmation='I_ATTEST_AND_APPROVE_REPOSITORY_JULY_07_2026_HISTORICAL_BASELINE_V1')
 OR (historical_baseline_id~'^platform-upload-[a-f0-9]{64}$' AND confirmation='I_APPROVE_ADMIN_UPLOADED_KALSHI_FEE_TERMS_V1'))
 AND risk_acceptance='I_ACCEPT_UNVERIFIED_SOURCE_AUTHENTICITY_AND_CURRENT_BASE_RATES_CHANGE_DETECTION_GAPS_AND_UNBOUNDED_FEE_EXITS_MAY_BLOCK_V1'));
REVOKE ALL ON FUNCTION private.strata_platform_uploaded_fee_guard(),private.strata_platform_uploaded_fee_latch(),private.strata_uploaded_fee_model_guard() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
