-- Every failure must be explicit; no synthetic row may be treated as real evidence.
DO $test$
DECLARE role_name text; privilege text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='private.strata_durable_owner_fee_model'::regclass AND tgname='strata_platform_fee_model_guard' AND tgenabled='O') THEN RAISE EXCEPTION 'missing durable guard'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_platform_official_fee_capture_v1'::regclass) THEN RAISE EXCEPTION 'RLS missing'; END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege(role_name,'private.strata_platform_official_fee_capture_v1',privilege) THEN RAISE EXCEPTION 'unexpected browser/service grant % %',role_name,privilege; END IF;
  END LOOP;
  IF has_sequence_privilege(role_name,'private.strata_platform_official_fee_capture_v1_capture_id_seq','USAGE') THEN RAISE EXCEPTION 'unexpected sequence grant'; END IF;
 END LOOP;
END $test$;
-- A shared observation matching the existing consent must not invalidate it.
INSERT INTO private.strata_platform_official_fee_capture_v1(canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
SELECT canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at FROM private.strata_railway_official_fee_capture_v5 WHERE execution_account_id='platform-fee-one';
-- Bind the exact same immutable source to the independently owned second account.
INSERT INTO private.strata_railway_official_fee_capture_v5(execution_account_id,platform_capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
SELECT 'platform-fee-two',capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at FROM private.strata_platform_official_fee_capture_v1;
DO $test$
BEGIN
 IF (SELECT known_publication_change FROM private.strata_durable_owner_fee_state) THEN RAISE EXCEPTION 'matching publication changed consent'; END IF;
 IF NOT EXISTS (SELECT 1 FROM private.strata_railway_official_fee_capture_v5 r JOIN private.strata_platform_official_fee_capture_v1 p ON p.capture_id=r.platform_capture_id WHERE r.execution_account_id='platform-fee-two' AND r.captured_at=p.captured_at AND r.content_sha256=p.content_sha256 AND r.original_bytes=p.original_bytes) THEN RAISE EXCEPTION 'owner receipt provenance mismatch'; END IF;
 BEGIN
  UPDATE private.strata_platform_official_fee_capture_v1 SET effective_date='2026-07-06';
  RAISE EXCEPTION 'unexpected mutable capture';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'immutable issuer evidence' THEN RAISE; END IF; END;
 BEGIN
  DELETE FROM private.strata_platform_official_fee_capture_v1;
  RAISE EXCEPTION 'unexpected deleted capture';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'immutable issuer evidence' THEN RAISE; END IF; END;
 BEGIN
  INSERT INTO private.strata_railway_official_fee_capture_v5(execution_account_id,platform_capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
  SELECT 'platform-fee-two',capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at FROM private.strata_platform_official_fee_capture_v1;
  RAISE EXCEPTION 'unexpected duplicate receipt';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 -- An otherwise well-formed receipt cannot silently change original capture time.
 BEGIN
  INSERT INTO private.strata_railway_official_fee_capture_v5(execution_account_id,platform_capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
  SELECT 'platform-fee-one',capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at-interval '1 second',expires_at-interval '1 second' FROM private.strata_platform_official_fee_capture_v1;
  RAISE EXCEPTION 'unexpected altered receipt';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'current exact platform issuer observation required' THEN RAISE; END IF; END;
 -- Owner consent cannot use the other owner's receipt, even for identical bytes.
 BEGIN
  INSERT INTO private.strata_durable_owner_fee_model(model_id,owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,source_capture_id,official_source_digest,policy_version,formula_version,effective_date,confirmation,genuine_source_verified)
  SELECT '66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','platform-fee-one',repeat('c',40),repeat('b',64),capture_id,content_sha256,'owner_approved_canonical_terms_v1','standard-quadratic-0.07-v1','2026-07-07','I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1',true FROM private.strata_railway_official_fee_capture_v5 WHERE execution_account_id='platform-fee-two';
  RAISE EXCEPTION 'unexpected cross-owner model';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%exact-owner capture%' THEN RAISE; END IF; END;
END $test$;
-- A changed publication must latch in the SAME transaction, then roll back atomically.
BEGIN;
WITH b AS (SELECT convert_to('%PDF-'||repeat('b',128),'UTF8') AS bytes,clock_timestamp() AS at)
INSERT INTO private.strata_platform_official_fee_capture_v1(canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
SELECT 'https://kalshi.com/docs/kalshi-fee-schedule.pdf','railway_canonical_https_direct','issuer_pdf_55m_signed_api_recheck_v2',encode(sha256(bytes),'hex'),bytes,octet_length(bytes),NULL,at,at+interval '55 minutes' FROM b;
DO $test$ BEGIN
 IF NOT (SELECT known_publication_change AND monitor_state='changed' FROM private.strata_durable_owner_fee_state) THEN RAISE EXCEPTION 'publication change not latched'; END IF;
END $test$;
ROLLBACK;
DO $test$ BEGIN
 IF (SELECT known_publication_change FROM private.strata_durable_owner_fee_state) OR (SELECT count(*) FROM private.strata_platform_official_fee_capture_v1)<>1 THEN RAISE EXCEPTION 'rollback leaked fee state'; END IF;
END $test$;
-- Commit an unsupported changed publication; it may invalidate but never authorize.
WITH b AS (SELECT convert_to('%PDF-'||repeat('b',128),'UTF8') AS bytes,clock_timestamp() AS at)
INSERT INTO private.strata_platform_official_fee_capture_v1(canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
SELECT 'https://kalshi.com/docs/kalshi-fee-schedule.pdf','railway_canonical_https_direct','issuer_pdf_55m_signed_api_recheck_v2',encode(sha256(bytes),'hex'),bytes,octet_length(bytes),NULL,at,at+interval '55 minutes' FROM b;
DO $test$
BEGIN
 IF NOT (SELECT known_publication_change AND monitor_state='changed' FROM private.strata_durable_owner_fee_state) THEN RAISE EXCEPTION 'committed change not latched'; END IF;
 BEGIN
  INSERT INTO private.strata_durable_owner_fee_model(model_id,owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,source_capture_id,official_source_digest,policy_version,formula_version,effective_date,confirmation,genuine_source_verified)
  SELECT '77777777-7777-4777-8777-777777777777','11111111-1111-4111-8111-111111111111','platform-fee-one',repeat('c',40),repeat('b',64),capture_id,content_sha256,'owner_approved_canonical_terms_v1','standard-quadratic-0.07-v1','2026-07-07','I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1',true FROM private.strata_railway_official_fee_capture_v5 WHERE execution_account_id='platform-fee-one';
  RAISE EXCEPTION 'unexpected consent to superseded publication';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'platform issuer publication contradicts monetary consent' THEN RAISE; END IF; END;
 BEGIN
  INSERT INTO private.strata_railway_official_fee_capture_v5(execution_account_id,platform_capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
  SELECT 'platform-fee-one',capture_id,canonical_url,source_kind,policy_version,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at FROM private.strata_platform_official_fee_capture_v1 WHERE effective_date IS NOT NULL;
  RAISE EXCEPTION 'unexpected superseded source accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'current exact platform issuer observation required' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM public.v13_production_account WHERE cash_micros=25000000 AND reserved_micros=0)<>2 THEN RAISE EXCEPTION 'account cash changed'; END IF;
END $test$;
