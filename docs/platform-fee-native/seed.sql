-- Synthetic test identities and bytes only; never run against a deployed database.
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('11111111-1111-4111-8111-111111111111','one@example.invalid',now()),
 ('22222222-2222-4222-8222-222222222222','two@example.invalid',now());
INSERT INTO public.financial_accounts(id,user_id,provider) VALUES
 ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','kalshi'),
 ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','kalshi');
INSERT INTO public.v13_production_account(id,owner_user_id,kalshi_connection_id,subaccount,exchange_index,key_fingerprint,cash_micros,reserved_micros,initial_cash_micros,revision,blocked_reason)
VALUES ('platform-fee-one','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',1,2,repeat('a',64),25000000,0,25000000,1,'synthetic'),
 ('platform-fee-two','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444',1,2,repeat('b',64),25000000,0,25000000,1,'synthetic');
WITH b AS (SELECT convert_to('%PDF-'||repeat('a',128),'UTF8') AS bytes,clock_timestamp()-interval '2 seconds' AS at)
INSERT INTO private.strata_railway_official_fee_capture_v5(execution_account_id,canonical_url,content_sha256,original_bytes,byte_length,effective_date,captured_at,expires_at)
SELECT 'platform-fee-one','https://kalshi.com/docs/kalshi-fee-schedule.pdf',encode(sha256(bytes),'hex'),bytes,octet_length(bytes),'2026-07-07',at,at+interval '55 minutes' FROM b;
INSERT INTO private.strata_durable_owner_fee_model(model_id,owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,source_capture_id,official_source_digest,policy_version,formula_version,effective_date,confirmation,genuine_source_verified)
SELECT '55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','platform-fee-one',repeat('a',40),repeat('b',64),capture_id,content_sha256,'owner_approved_canonical_terms_v1','standard-quadratic-0.07-v1','2026-07-07','I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1',true
FROM private.strata_railway_official_fee_capture_v5 WHERE execution_account_id='platform-fee-one';
INSERT INTO private.strata_durable_owner_fee_state(model_id) VALUES ('55555555-5555-4555-8555-555555555555');
