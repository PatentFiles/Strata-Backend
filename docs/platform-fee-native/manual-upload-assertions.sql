-- Isolated PostgreSQL fixtures. The bytes below are synthetic; parser tests
-- separately qualify supported real PDF bytes. Never use this file in production.
BEGIN;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),role text NOT NULL);
INSERT INTO public.profiles(id,role) VALUES ('11111111-1111-4111-8111-111111111111','ADMIN'),('22222222-2222-4222-8222-222222222222','STANDARD');
INSERT INTO private.role_assignments(email,role) VALUES ('one@example.invalid','ADMIN'),('two@example.invalid','STANDARD');
DO $test$
DECLARE first_id text; second_id text; bytes bytea; digest text; role_name text; perm text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH perm IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege(role_name,'private.strata_platform_uploaded_fee_schedule',perm) THEN RAISE EXCEPTION 'manual publication ACL leak'; END IF;
  END LOOP;
 END LOOP;
 bytes:=convert_to('%PDF-'||repeat('c',128),'UTF8');digest:=encode(sha256(bytes),'hex');first_id:='platform-upload-'||digest;
 INSERT INTO private.strata_durable_historical_baseline(baseline_id,source_kind,content_sha256,original_bytes,effective_date,formula_version)
 VALUES(first_id,'OWNER_ATTESTED_HISTORICAL_BASELINE',digest,bytes,'2026-07-07','standard-quadratic-0.07-v1');
 BEGIN
  INSERT INTO private.strata_platform_uploaded_fee_schedule(baseline_id,uploader_user_id) VALUES(first_id,'22222222-2222-4222-8222-222222222222');
  RAISE EXCEPTION 'unexpected STANDARD upload';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'platform fee upload admin required' THEN RAISE; END IF; END;
 INSERT INTO private.strata_platform_uploaded_fee_schedule(baseline_id,uploader_user_id) VALUES(first_id,'11111111-1111-4111-8111-111111111111');
 IF NOT (SELECT known_publication_change FROM private.strata_durable_owner_fee_state WHERE model_id='55555555-5555-4555-8555-555555555555') THEN RAISE EXCEPTION 'prior different terms did not latch'; END IF;
 IF EXISTS(SELECT 1 FROM private.strata_platform_official_fee_capture_v1) THEN RAISE EXCEPTION 'upload fabricated capture'; END IF;
 BEGIN
  INSERT INTO private.strata_platform_uploaded_fee_schedule(baseline_id,uploader_user_id) VALUES(first_id,'11111111-1111-4111-8111-111111111111');
  RAISE EXCEPTION 'duplicate upload accepted';
 EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN
  DELETE FROM private.strata_platform_uploaded_fee_schedule;
  RAISE EXCEPTION 'mutable upload history';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'immutable durable publication observation' THEN RAISE; END IF;END;
 INSERT INTO private.strata_durable_owner_fee_model(model_id,owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,official_source_digest,source_kind,historical_baseline_id,policy_version,formula_version,effective_date,confirmation,genuine_source_verified)
 VALUES('88888888-8888-4888-8888-888888888888','22222222-2222-4222-8222-222222222222','platform-fee-two',repeat('a',40),repeat('c',64),digest,'OWNER_ATTESTED_HISTORICAL_BASELINE',first_id,'owner_attested_historical_terms_v1','standard-quadratic-0.07-v1','2026-07-07','I_APPROVE_OWNER_ATTESTED_HISTORICAL_FEE_TERMS_V1',false);
 INSERT INTO private.strata_durable_owner_fee_state(model_id) VALUES('88888888-8888-4888-8888-888888888888');
 INSERT INTO private.strata_durable_fee_migration(model_id,owner_user_id,execution_account_id,release_commit_sha,prior_policy_id,prior_policy_hash,new_policy_id,new_policy_hash,source_digest,source_kind,historical_baseline_id,confirmation,risk_acceptance)
 VALUES('88888888-8888-4888-8888-888888888888','22222222-2222-4222-8222-222222222222','platform-fee-two',repeat('a',40),'old',repeat('b',64),'new',repeat('c',64),digest,'OWNER_ATTESTED_HISTORICAL_BASELINE',first_id,'I_APPROVE_ADMIN_UPLOADED_KALSHI_FEE_TERMS_V1','I_ACCEPT_UNVERIFIED_SOURCE_AUTHENTICITY_AND_CURRENT_BASE_RATES_CHANGE_DETECTION_GAPS_AND_UNBOUNDED_FEE_EXITS_MAY_BLOCK_V1');
 bytes:=convert_to('%PDF-'||repeat('d',128),'UTF8');digest:=encode(sha256(bytes),'hex');second_id:='platform-upload-'||digest;
 INSERT INTO private.strata_durable_historical_baseline(baseline_id,source_kind,content_sha256,original_bytes,effective_date,formula_version)
 VALUES(second_id,'OWNER_ATTESTED_HISTORICAL_BASELINE',digest,bytes,'2026-07-07','standard-quadratic-0.07-v1');
 INSERT INTO private.strata_platform_uploaded_fee_schedule(baseline_id,uploader_user_id) VALUES(second_id,'11111111-1111-4111-8111-111111111111');
 IF (SELECT known_publication_change FROM private.strata_durable_owner_fee_state WHERE model_id='88888888-8888-4888-8888-888888888888') THEN RAISE EXCEPTION 'equivalent supported publication invalidated unchanged owner terms'; END IF;
 IF NOT (SELECT known_publication_change FROM private.strata_durable_owner_fee_state WHERE model_id='55555555-5555-4555-8555-555555555555') THEN RAISE EXCEPTION 'replacement cleared prior changed-publication latch'; END IF;
 BEGIN
  INSERT INTO private.strata_durable_owner_fee_model(model_id,owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,official_source_digest,source_kind,historical_baseline_id,policy_version,formula_version,effective_date,confirmation,genuine_source_verified)
  SELECT '99999999-9999-4999-8999-999999999999','22222222-2222-4222-8222-222222222222','platform-fee-two',repeat('a',40),repeat('d',64),content_sha256,source_kind,baseline_id,'owner_attested_historical_terms_v1',formula_version,effective_date,'I_APPROVE_OWNER_ATTESTED_HISTORICAL_FEE_TERMS_V1',false FROM private.strata_durable_historical_baseline WHERE baseline_id=first_id;
  RAISE EXCEPTION 'superseded document authorized';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'active uploaded fee schedule required' THEN RAISE;END IF;END;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
