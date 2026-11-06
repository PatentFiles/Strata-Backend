-- 2026-10-26: Bounded coordination window for independent human technical review.
-- NO trading authority, authorizer role, evidence digest, existing record, order,
-- fee policy, worker lease, or owner consent is created or changed by this migration.
--
-- Separate the immutable signed GET *observation time* from the time available
-- for distinct real humans to examine exact-SHA protective-exit implementation.
-- Existing 15-minute rows remain immutable and keep their original expirations.
-- Before every START, production still requires current signed exchange snapshots,
-- current Kalshi fees, conservative risk caps, lease ownership and the independent
-- SHA-bound approved final protective release.
--
-- This is deliberately a bounded 8-hour receipt window, NOT indefinite evidence.
-- Production deployment requires owner approval and independent review of this
-- schema-policy change. Does not change the current deployed Railway Git SHA.
BEGIN;
SET LOCAL lock_timeout = '2000ms';
SET LOCAL statement_timeout = '15000ms';

ALTER TABLE private.strata_protective_release_qualification
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '8 hours');
ALTER TABLE private.strata_protective_release_qualification
  DROP CONSTRAINT strata_release_qualification_window;
ALTER TABLE private.strata_protective_release_qualification
  ADD CONSTRAINT strata_release_qualification_window CHECK (
    expires_at > observed_at
    AND expires_at <= observed_at + interval '8 hours'
  );

ALTER TABLE private.strata_protective_release_reviews
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '8 hours');
ALTER TABLE private.strata_protective_release_reviews
  DROP CONSTRAINT strata_release_review_window;
ALTER TABLE private.strata_protective_release_reviews
  ADD CONSTRAINT strata_release_review_window CHECK (
    expires_at > approved_at
    AND expires_at <= approved_at + interval '8 hours'
  );

COMMENT ON COLUMN private.strata_protective_release_qualification.expires_at IS
  '8-hour bounded window for coordinating independent exact-SHA review, not proof of live exchange freshness. observed_at is immutable; START must independently re-check signed cash, exposure and fees.';
COMMENT ON COLUMN private.strata_protective_release_reviews.expires_at IS
  '8-hour bounded window for distinct reviewer and owner to complete genuine AAL2 release. Existing immutable receipts are not extended. Revoke on invalidation.';

-- Assert both defaults are exactly eight hours. If schema setup changed unexpectedly,
-- raise an exception and roll back this whole migration.
DO $$
DECLARE q text; r text;
BEGIN
 SELECT pg_get_expr(d.adbin,d.adrelid) INTO q
 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
 WHERE d.adrelid='private.strata_protective_release_qualification'::regclass
 AND a.attname='expires_at';
 SELECT pg_get_expr(d.adbin,d.adrelid) INTO r
 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
 WHERE d.adrelid='private.strata_protective_release_reviews'::regclass
 AND a.attname='expires_at';
 IF q NOT LIKE '%08:00:00%' OR r NOT LIKE '%08:00:00%' THEN
   RAISE EXCEPTION '8-hour coordination TTL defaults not verified: %, %',q,r;
 END IF;
END $$;
COMMIT;
