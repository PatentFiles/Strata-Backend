-- #165: independent trusted Railway-origin Kalshi PDF capture, not an Edge download.
-- Backend obtains issuer bytes with a fixed TLS GET; PostgreSQL stores the
-- original complete bytes and enforces their digest immutably.
-- No grants, account policy changes, trade permission or privilege escalation.
CREATE TABLE IF NOT EXISTS private.strata_railway_official_fee_capture_v5 (
 capture_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 source_kind text NOT NULL DEFAULT 'railway_canonical_https_direct'
   CHECK (source_kind = 'railway_canonical_https_direct'),
 policy_version text NOT NULL DEFAULT 'issuer_pdf_55m_signed_api_recheck_v2'
   CHECK (policy_version = 'issuer_pdf_55m_signed_api_recheck_v2'),
 canonical_url text NOT NULL
   CHECK (canonical_url = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'),
 content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
 original_bytes bytea NOT NULL,
 byte_length integer NOT NULL CHECK (byte_length BETWEEN 100 AND 2000000),
 effective_date date NOT NULL,
 captured_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT authentic_source_bytes CHECK (
   octet_length(original_bytes)=byte_length AND
   encode(extensions.digest(original_bytes,'sha256'),'hex')=content_sha256 AND
   substring(original_bytes from 1 for 5)=decode('255044462d','hex')),
 CONSTRAINT original_lease_bound CHECK (
   expires_at=captured_at+interval '55 minutes' AND
   captured_at<=stored_at+interval '5 seconds' AND
   captured_at>=stored_at-interval '5 minutes' AND
   effective_date<=captured_at::date)
);
CREATE INDEX IF NOT EXISTS strata_railway_fee_v5_account_latest_idx
 ON private.strata_railway_official_fee_capture_v5(execution_account_id,captured_at DESC);

CREATE OR REPLACE FUNCTION private.strata_railway_fee_v5_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'immutable issuer evidence'; END
$$;
DROP TRIGGER IF EXISTS strata_railway_fee_v5_immutable_trigger
 ON private.strata_railway_official_fee_capture_v5;
CREATE TRIGGER strata_railway_fee_v5_immutable_trigger
 BEFORE UPDATE OR DELETE ON private.strata_railway_official_fee_capture_v5
 FOR EACH ROW EXECUTE FUNCTION private.strata_railway_fee_v5_immutable();
REVOKE ALL ON TABLE private.strata_railway_official_fee_capture_v5 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE private.strata_railway_official_fee_capture_v5_capture_id_seq
 FROM PUBLIC,anon,authenticated;
ALTER TABLE private.strata_railway_official_fee_capture_v5 ENABLE ROW LEVEL SECURITY;
