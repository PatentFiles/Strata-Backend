-- Public issuer bytes are independent of owner identity. Owner-bound V5
-- receipts can reference the immutable platform observation without renewing
-- its original timestamp, or sharing a monetary authorization.
BEGIN;
CREATE TABLE private.strata_platform_official_fee_capture_v1 (
 capture_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 canonical_url text NOT NULL CHECK(canonical_url='https://kalshi.com/docs/kalshi-fee-schedule.pdf'),
 source_kind text NOT NULL CHECK(source_kind='railway_canonical_https_direct'),
 policy_version text NOT NULL CHECK(policy_version='issuer_pdf_55m_signed_api_recheck_v2'),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 original_bytes bytea NOT NULL,
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 100 AND 2000000),
 -- NULL means actual issuer bytes arrived but their monetary terms are not
 -- supported. This observation can invalidate old evidence, never approve fees.
 effective_date date,
 captured_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(octet_length(original_bytes)=byte_length AND
       pg_catalog.encode(pg_catalog.sha256(original_bytes),'hex')=content_sha256 AND
       substring(original_bytes from 1 for 5)=decode('255044462d','hex')),
 CHECK(expires_at=captured_at+interval '55 minutes' AND
       captured_at BETWEEN stored_at-interval '5 minutes' AND stored_at+interval '5 seconds' AND
       (effective_date IS NULL OR effective_date<=captured_at::date))
);
ALTER TABLE private.strata_platform_official_fee_capture_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_platform_official_fee_capture_v1 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE private.strata_platform_official_fee_capture_v1_capture_id_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX strata_platform_official_fee_latest ON private.strata_platform_official_fee_capture_v1(captured_at DESC,capture_id DESC);
CREATE TRIGGER strata_platform_fee_immutable BEFORE UPDATE OR DELETE ON private.strata_platform_official_fee_capture_v1
 FOR EACH ROW EXECUTE FUNCTION private.strata_railway_fee_v5_immutable();
ALTER TABLE private.strata_railway_official_fee_capture_v5
 ADD COLUMN platform_capture_id bigint REFERENCES private.strata_platform_official_fee_capture_v1(capture_id);
ALTER TABLE private.strata_railway_official_fee_capture_v5 DROP CONSTRAINT original_lease_bound;
ALTER TABLE private.strata_railway_official_fee_capture_v5 ADD CONSTRAINT original_lease_bound CHECK(
 expires_at=captured_at+interval '55 minutes' AND captured_at<=stored_at+interval '5 seconds' AND
 effective_date<=captured_at::date AND
 ((platform_capture_id IS NULL AND captured_at>=stored_at-interval '5 minutes')
 OR (platform_capture_id IS NOT NULL AND captured_at<=stored_at AND expires_at>stored_at)));
CREATE UNIQUE INDEX strata_owner_platform_fee_receipt_unique ON private.strata_railway_official_fee_capture_v5(execution_account_id,platform_capture_id)
 WHERE platform_capture_id IS NOT NULL;

-- One global publication writer, with read/share admission from monetary
-- model creation. A new issuer observation cannot race a new consent and
-- leave a changed model unlatched. The original account capture trigger stays.
CREATE FUNCTION private.strata_platform_fee_write_lock() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 PERFORM pg_advisory_xact_lock(1958371201,1);
 RETURN NEW;
END $fn$;
CREATE TRIGGER strata_platform_fee_write_lock BEFORE INSERT ON private.strata_platform_official_fee_capture_v1
 FOR EACH ROW EXECUTE FUNCTION private.strata_platform_fee_write_lock();

CREATE FUNCTION private.strata_platform_fee_owner_binding() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF NEW.platform_capture_id IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock_shared(1958371201,1);
 IF NOT EXISTS (
 SELECT 1 FROM private.strata_platform_official_fee_capture_v1 c
 WHERE c.capture_id=NEW.platform_capture_id AND c.effective_date IS NOT NULL
 AND c.captured_at<=clock_timestamp() AND c.expires_at>clock_timestamp()
 AND ROW(c.canonical_url,c.source_kind,c.policy_version,c.content_sha256,c.original_bytes,c.byte_length,c.effective_date,c.captured_at,c.expires_at)
 IS NOT DISTINCT FROM ROW(NEW.canonical_url,NEW.source_kind,NEW.policy_version,NEW.content_sha256,NEW.original_bytes,NEW.byte_length,NEW.effective_date,NEW.captured_at,NEW.expires_at)
 AND NOT EXISTS(SELECT 1 FROM private.strata_platform_official_fee_capture_v1 later
 WHERE (later.captured_at,later.capture_id)>(c.captured_at,c.capture_id))
 ) THEN RAISE EXCEPTION 'current exact platform issuer observation required'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER strata_platform_fee_owner_binding BEFORE INSERT ON private.strata_railway_official_fee_capture_v5
 FOR EACH ROW EXECUTE FUNCTION private.strata_platform_fee_owner_binding();

-- The production durable tables predate this migration but are absent from
-- the older core-only disposable schema. Attach additional guards when that
-- extension is installed; public durable binding also checks their presence.
CREATE FUNCTION private.strata_platform_fee_model_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(1958371201,1);
 IF EXISTS(SELECT 1 FROM private.strata_platform_official_fee_capture_v1 c
 LEFT JOIN private.strata_railway_official_fee_capture_v5 original ON original.capture_id=NEW.source_capture_id
 WHERE c.content_sha256<>NEW.official_source_digest
 AND (NEW.source_kind='OWNER_ATTESTED_HISTORICAL_BASELINE' OR c.captured_at>=original.captured_at))
 THEN RAISE EXCEPTION 'platform issuer publication contradicts monetary consent'; END IF;
 RETURN NEW;
END $fn$;
CREATE FUNCTION private.strata_platform_fee_change_latch() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF to_regclass('private.strata_durable_owner_fee_model') IS NOT NULL AND
    to_regclass('private.strata_durable_owner_fee_state') IS NOT NULL THEN
  UPDATE private.strata_durable_owner_fee_state s SET known_publication_change=true,monitor_state='changed'
  FROM private.strata_durable_owner_fee_model m
  LEFT JOIN private.strata_railway_official_fee_capture_v5 original ON original.capture_id=m.source_capture_id
  WHERE m.model_id=s.model_id AND s.known_publication_change IS DISTINCT FROM true
  AND (m.source_kind='OWNER_ATTESTED_HISTORICAL_BASELINE' OR NEW.captured_at>=original.captured_at)
  AND NEW.content_sha256<>m.official_source_digest;
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER strata_platform_fee_change_latch AFTER INSERT ON private.strata_platform_official_fee_capture_v1
 FOR EACH ROW EXECUTE FUNCTION private.strata_platform_fee_change_latch();
DO $fn$ BEGIN
 IF to_regclass('private.strata_durable_owner_fee_model') IS NOT NULL THEN
 EXECUTE 'CREATE TRIGGER strata_platform_fee_model_guard BEFORE INSERT ON private.strata_durable_owner_fee_model FOR EACH ROW EXECUTE FUNCTION private.strata_platform_fee_model_guard()';
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION private.strata_platform_fee_write_lock(),private.strata_platform_fee_owner_binding(),private.strata_platform_fee_model_guard(),private.strata_platform_fee_change_latch() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
