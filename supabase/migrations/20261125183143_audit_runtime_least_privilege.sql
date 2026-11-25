-- Qualified service-role boundary, not per-customer SQL authentication.
-- The API is a trusted cross-tenant service; existing authenticated joins,
-- account locks, immutable evidence triggers and final-send checks still apply.
-- No ownership, DDL, RLS bypass, role creation, browser grant or default grant.
-- Existing rows/financial values/consents are not modified. Never run at boot.
-- A separately provisioned secret LOGIN may inherit ONLY this NOLOGIN group.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE ROLE strata_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public,private,vault,extensions TO strata_api_runtime;

-- Fixed reviewed inventory, not GRANT ... ON ALL/FUTURE TABLES. Older isolated
-- fixture schemas can omit compatibility-only tables. The production preflight
-- must confirm its exact expected inventory before this migration is applied.
DO $permissions$
DECLARE r record;
BEGIN
  IF to_regclass('public.v13_production_account') IS NULL
    OR to_regclass('private.kalshi_account_worker_lease') IS NULL
    OR to_regclass('private.strata_live_decision_log_v1') IS NULL THEN
    RAISE EXCEPTION 'runtime_role_required_schema_missing';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('private.kalshi_account_funding','SELECT,INSERT,UPDATE'),
    ('private.kalshi_account_operation_attempts','SELECT,INSERT,UPDATE'),
    ('private.kalshi_account_worker_lease','SELECT,INSERT,UPDATE'),
    ('private.kalshi_api_qualification_guard','SELECT,INSERT,UPDATE,DELETE'),
    ('private.kalshi_connection_credentials','SELECT,INSERT,UPDATE'),
    ('private.kalshi_owner_historical_funding','SELECT,INSERT,UPDATE'),
    ('private.kalshi_owner_pilot_transfers','SELECT,INSERT,UPDATE'),
    ('private.kalshi_owner_shard_allocations','SELECT,INSERT,UPDATE'),
    ('private.kalshi_owner_topup_legs','SELECT,INSERT,UPDATE'),
    ('private.kalshi_owner_topups','SELECT,INSERT,UPDATE'),
    ('private.kalshi_restricted_key_recovery','SELECT,INSERT,UPDATE'),
    ('private.mfa_login_policy_audit','SELECT'),
    ('private.provider_connections','SELECT,INSERT,UPDATE'),
    ('private.role_assignments','SELECT'),
    ('private.strata_api_fee_owner_consents','SELECT,INSERT,UPDATE'),
    ('private.strata_api_fee_rate_reviews','SELECT,INSERT,UPDATE'),
    ('private.strata_api_fee_source_grants','SELECT,INSERT,UPDATE'),
    ('private.strata_api_fee_standing_delegations','SELECT,INSERT,UPDATE'),
    ('private.strata_api_fee_standing_models','SELECT,INSERT,UPDATE'),
    ('private.strata_auto_profit_withdrawal_rules','SELECT,INSERT,UPDATE'),
    ('private.strata_auto_withdrawal_maintenance','SELECT,INSERT,UPDATE'),
    ('private.strata_capital_credit_repair','SELECT,INSERT,UPDATE'),
    ('private.strata_continuous_execution_audit','SELECT,INSERT,UPDATE'),
    ('private.strata_continuous_execution_grants','SELECT,INSERT,UPDATE'),
    ('private.strata_continuous_execution_technical_lease','SELECT,INSERT,UPDATE'),
    ('private.strata_demo_ioc_attempt','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_fee_migration','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_fee_migration_attempt','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_fee_publication_observation','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_fee_release_authorization','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_fee_revocation','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_historical_baseline','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_owner_fee_model','SELECT,INSERT,UPDATE'),
    ('private.strata_durable_owner_fee_state','SELECT,INSERT,UPDATE'),
    ('private.strata_emergency_exit_reservations','SELECT,INSERT,UPDATE'),
    ('private.strata_fee_source_grants','SELECT,INSERT,UPDATE'),
    ('private.strata_fee_source_owner_consents','SELECT,INSERT,UPDATE'),
    ('private.strata_fee_source_policy_reviews','SELECT,INSERT,UPDATE'),
    ('private.strata_kalshi_balance_read_slots','SELECT,INSERT,UPDATE'),
    ('private.strata_live_decision_log_v1','SELECT,INSERT'),
    ('private.strata_manual_profit_withdrawals','SELECT,INSERT,UPDATE'),
    ('private.strata_member_read_budget','SELECT,INSERT,UPDATE'),
    ('private.strata_owner_fee_authority_v3','SELECT,INSERT,UPDATE'),
    ('private.strata_owner_fee_evidence_v3','SELECT,INSERT,UPDATE'),
    ('private.strata_owner_sha_approvals','SELECT,INSERT,UPDATE'),
    ('private.strata_owner_standing_fee_v1','SELECT,INSERT,UPDATE'),
    ('private.strata_platform_fee_withdrawal','SELECT,INSERT,UPDATE'),
    ('private.strata_platform_official_fee_capture_v1','SELECT,INSERT,UPDATE'),
    ('private.strata_platform_uploaded_fee_schedule','SELECT,INSERT,UPDATE'),
    ('private.strata_protective_exit_local_no_send','SELECT,INSERT,UPDATE'),
    ('private.strata_protective_exit_reconciliations','SELECT,INSERT,UPDATE'),
    ('private.strata_protective_exit_release','SELECT,INSERT,UPDATE'),
    ('private.strata_protective_release_qualification','SELECT,INSERT,UPDATE'),
    ('private.strata_protective_release_reviews','SELECT,INSERT,UPDATE'),
    ('private.strata_railway_fee_retry_v5','SELECT,INSERT,UPDATE'),
    ('private.strata_railway_official_fee_capture_v5','SELECT,INSERT,UPDATE'),
    ('private.strata_standing_execution_reviews','SELECT,INSERT,UPDATE'),
    ('private.strata_v13_execution_trace','SELECT,INSERT,UPDATE'),
    ('private.strata_v13_signal_audit_progress','SELECT,INSERT,UPDATE'),
    ('private.strata_v13_signal_decisions','SELECT,INSERT,UPDATE'),
    ('private.strata_v13_signal_trace_scope','SELECT,INSERT,UPDATE'),
    ('private.strata_wallet_v4_fee_authority','SELECT,INSERT,UPDATE'),
    ('private.strata_wallet_v4_fee_evidence','SELECT,INSERT,UPDATE'),
    ('public.automations','SELECT,INSERT,UPDATE'),
    ('public.financial_accounts','SELECT,INSERT,UPDATE'),
    ('public.forward_test_book_snapshots','SELECT,INSERT,UPDATE'),
    ('public.forward_test_btc_points','SELECT,INSERT,UPDATE'),
    ('public.forward_test_engine','SELECT,INSERT,UPDATE'),
    ('public.forward_test_evaluations','SELECT,INSERT,UPDATE'),
    ('public.forward_test_positions','SELECT,INSERT,UPDATE'),
    ('public.forward_test_windows','SELECT,INSERT,UPDATE'),
    ('public.kalshi_key_provisioning_attempts','SELECT,INSERT,UPDATE'),
    ('public.live_events','SELECT,INSERT,UPDATE'),
    ('public.live_execution_config','SELECT,INSERT,UPDATE'),
    ('public.live_notification_events','SELECT,INSERT,UPDATE'),
    ('public.live_proposed_orders','SELECT,INSERT,UPDATE'),
    ('public.live_trades','SELECT,INSERT,UPDATE'),
    ('public.mfa_login_policy','SELECT'),
    ('public.mfa_user_preferences','SELECT'),
    ('public.micro_live_commissioning_archive','SELECT,INSERT,UPDATE'),
    ('public.micro_live_config','SELECT,INSERT,UPDATE'),
    ('public.micro_live_decisions','SELECT,INSERT,UPDATE'),
    ('public.micro_live_fee_verification','SELECT,INSERT,UPDATE'),
    ('public.micro_live_fills','SELECT,INSERT,UPDATE'),
    ('public.micro_live_orders','SELECT,INSERT,UPDATE'),
    ('public.micro_live_pair_boundary','SELECT,INSERT,UPDATE'),
    ('public.micro_live_pair_fee_approval','SELECT,INSERT,UPDATE'),
    ('public.micro_live_pair_funding_attempts','SELECT,INSERT,UPDATE'),
    ('public.micro_live_pair_key_provisioning_attempts','SELECT,INSERT,UPDATE'),
    ('public.micro_live_run_archive','SELECT,INSERT,UPDATE'),
    ('public.micro_live_settlements','SELECT,INSERT,UPDATE'),
    ('public.micro_live_subaccount_creation_attempts','SELECT,INSERT,UPDATE'),
    ('public.paper_history','SELECT,INSERT,UPDATE'),
    ('public.profiles','SELECT'),
    ('public.strata_configured_stake','SELECT,INSERT,UPDATE'),
    ('public.strata_direct_entry_source','SELECT,INSERT'),
    ('public.strata_fee_operator_release_candidates','SELECT,INSERT,UPDATE'),
    ('public.strata_fee_operator_source_reviews','SELECT,INSERT,UPDATE'),
    ('public.strata_index2_key_attempt','SELECT,INSERT,UPDATE'),
    ('public.strata_official_fee_capture_throttle','SELECT,INSERT,UPDATE'),
    ('public.strata_official_fee_captures','SELECT,INSERT,UPDATE'),
    ('public.strata_pre_boundary_transfer_acknowledgment','SELECT,INSERT,UPDATE'),
    ('public.strata_subaccount_creation_attempt','SELECT,INSERT,UPDATE'),
    ('public.strategies','SELECT,INSERT,UPDATE'),
    ('public.strategy_recommendations','SELECT,INSERT,UPDATE'),
    ('public.strategy_versions','SELECT,INSERT,UPDATE'),
    ('public.v13_commissioning_evidence','SELECT,INSERT,UPDATE'),
    ('public.v13_live_money_policy','SELECT,INSERT,UPDATE'),
    ('public.v13_production_account','SELECT,INSERT,UPDATE'),
    ('public.v13_production_event','SELECT,INSERT'),
    ('public.v13_production_intent','SELECT,INSERT,UPDATE'),
    ('public.v13_production_observation','SELECT,INSERT'),
    ('public.v13_production_position','SELECT,INSERT,UPDATE'),
    ('public.v13_shared_preset','SELECT,INSERT,UPDATE,DELETE'),
    ('public.v13_strategy_parameter_set','SELECT,INSERT,UPDATE'),
    ('public.v13_strategy_shadow_evaluation','SELECT,INSERT,UPDATE')
  ) AS allowlist(relation,privileges) LOOP
    IF to_regclass(r.relation) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('GRANT %s ON TABLE %s TO strata_api_runtime',r.privileges,to_regclass(r.relation));
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',to_regclass(r.relation));
    -- This policy grants the trusted service only its already enumerated object
    -- privileges. It grants nothing to anon, authenticated, paper or new tables.
    EXECUTE format('CREATE POLICY strata_api_runtime_access_v1 ON %s TO strata_api_runtime USING (true) WITH CHECK (true)',to_regclass(r.relation));
  END LOOP;
END
$permissions$;
-- Hosted Supabase owns auth.users and does not delegate schema USAGE/policy
-- management to postgres. Do not change managed Auth objects or impersonate
-- its reserved roles. This private, four-column owner-rights view is the narrow
-- identity read/lock capability of the trusted API, never a browser interface.
CREATE VIEW private.strata_runtime_auth_user_v1 WITH(security_barrier=true) AS
 SELECT id,email,email_confirmed_at,banned_until FROM auth.users;
REVOKE ALL ON private.strata_runtime_auth_user_v1 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,UPDATE(id) ON private.strata_runtime_auth_user_v1 TO strata_api_runtime;
-- Existing server-side legacy Edge consumers already hold Auth read authority.
-- Preserve that read path without adding any browser role or write authority.
GRANT SELECT ON private.strata_runtime_auth_user_v1 TO service_role;
CREATE FUNCTION private.strata_runtime_auth_user_readonly_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $readonly$
BEGIN
 RAISE EXCEPTION 'runtime_auth_identity_is_read_only' USING ERRCODE='42501';
END
$readonly$;
REVOKE ALL ON FUNCTION private.strata_runtime_auth_user_readonly_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER strata_runtime_auth_user_no_mutation_v1
 INSTEAD OF INSERT OR UPDATE OR DELETE ON private.strata_runtime_auth_user_v1
 FOR EACH ROW EXECUTE FUNCTION private.strata_runtime_auth_user_readonly_v1();
-- Preserve the inspected invoker-rights guard exactly, except the narrow
-- identity relation. A concurrently changed function refuses this migration.
DO $guard_definition$
BEGIN
 IF to_regprocedure('private.strata_platform_fee_withdrawal_guard()') IS NOT NULL
 AND encode(sha256(convert_to(replace(pg_get_functiondef('private.strata_platform_fee_withdrawal_guard()'::regprocedure),E'\r',''),'UTF8')),'hex')<>'f7adcee599631aa19d036127ee5fec19c67f6c9059a8789b7fbe2e60cd09a61a'
 THEN RAISE EXCEPTION 'runtime_auth_guard_definition_changed'; END IF;
END $guard_definition$;
CREATE OR REPLACE FUNCTION private.strata_platform_fee_withdrawal_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
 PERFORM pg_advisory_xact_lock(1958371201,1);
 IF NOT EXISTS(SELECT 1 FROM private.strata_runtime_auth_user_v1 u JOIN public.profiles p ON p.id=u.id
 JOIN private.role_assignments ra ON lower(btrim(ra.email))=lower(btrim(u.email))
 WHERE u.id=NEW.administrator_user_id AND u.email_confirmed_at IS NOT NULL AND p.role='ADMIN' AND ra.role='ADMIN'
 AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())) THEN RAISE EXCEPTION 'platform fee withdrawal admin required';END IF;
 IF NEW.upload_id IS DISTINCT FROM (SELECT upload_id FROM private.strata_platform_uploaded_fee_schedule ORDER BY upload_id DESC LIMIT 1)
 THEN RAISE EXCEPTION 'only latest publication can be withdrawn';END IF;
 PERFORM private.strata_platform_fee_require_safe_cutover();
 UPDATE private.strata_durable_owner_fee_state s SET known_publication_change=true,monitor_state='changed'
 FROM private.strata_durable_owner_fee_model m WHERE m.model_id=s.model_id
 AND m.historical_baseline_id LIKE 'platform-upload-%' AND s.known_publication_change=false;
 RETURN NEW;
END $function$
;

-- Preserve the inspected invoker-rights guard exactly, except the narrow
-- identity relation. A concurrently changed function refuses this migration.
DO $guard_definition$
BEGIN
 IF to_regprocedure('private.strata_platform_uploaded_fee_guard()') IS NOT NULL
 AND encode(sha256(convert_to(replace(pg_get_functiondef('private.strata_platform_uploaded_fee_guard()'::regprocedure),E'\r',''),'UTF8')),'hex')<>'7737e07eed019dc59e45d5bdd4d428cc344b2de374a66a6efaf5edf5944c2ba5'
 THEN RAISE EXCEPTION 'runtime_auth_guard_definition_changed'; END IF;
END $guard_definition$;
CREATE OR REPLACE FUNCTION private.strata_platform_uploaded_fee_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
 PERFORM pg_advisory_xact_lock(1958371201,1);
 PERFORM private.strata_platform_fee_require_safe_cutover();
 IF NOT EXISTS(SELECT 1 FROM private.strata_runtime_auth_user_v1 u JOIN public.profiles p ON p.id=u.id
 JOIN private.role_assignments ra ON lower(btrim(ra.email))=lower(btrim(u.email))
 WHERE u.id=NEW.uploader_user_id AND u.email_confirmed_at IS NOT NULL AND p.role='ADMIN' AND ra.role='ADMIN'
 AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())) THEN RAISE EXCEPTION 'platform fee upload admin required';END IF;
 IF NOT EXISTS(SELECT 1 FROM private.strata_durable_historical_baseline b WHERE b.baseline_id=NEW.baseline_id
 AND substring(b.original_bytes from 1 for 5)=decode('255044462d','hex')
 AND NOT EXISTS(SELECT 1 FROM private.strata_platform_official_fee_capture_v1 c WHERE c.content_sha256<>b.content_sha256)
 AND NOT EXISTS(SELECT 1 FROM private.strata_platform_uploaded_fee_schedule u JOIN private.strata_durable_historical_baseline prior_baseline USING(baseline_id)
 WHERE prior_baseline.effective_date>b.effective_date)) THEN RAISE EXCEPTION 'upload identity or applicable publication unverified';END IF;
 RETURN NEW;
END $function$
;

-- Preserve the inspected invoker-rights guard exactly, except the narrow
-- identity relation. A concurrently changed function refuses this migration.
DO $guard_definition$
BEGIN
 IF to_regprocedure('private.strata_require_two_fee_policy_reviews()') IS NOT NULL
 AND encode(sha256(convert_to(replace(pg_get_functiondef('private.strata_require_two_fee_policy_reviews()'::regprocedure),E'\r',''),'UTF8')),'hex')<>'d29ac39b688030e257717fc7e26f58e842ea3f2d9b57e961327d13dfa9440d2f'
 THEN RAISE EXCEPTION 'runtime_auth_guard_definition_changed'; END IF;
END $guard_definition$;
CREATE OR REPLACE FUNCTION private.strata_require_two_fee_policy_reviews()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE eligible_reviews integer;
BEGIN
  IF NEW.policy_decision_sha256 <>
       'f8f7e0920168ab4601c59a3a9343e940d78dd974512c7ec97f7d052bf5fd685e'
    OR NEW.reviewed_pdf_sha256 <>
       'c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601'
    OR NEW.authorized_stages <> ARRAY['STEP_6','STEP_9','STEP_11','ORDER_ENTRY']::text[]
    THEN RAISE EXCEPTION 'fee_policy_scope_not_reviewed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.strata_fee_operator_release_candidates c
    WHERE c.release_id=NEW.release_id AND c.revoked_at IS NULL
      AND c.expires_at>now() AND NEW.expires_at<=c.expires_at
      AND c.content_sha256=NEW.reviewed_pdf_sha256
      AND c.evidence_kind='operator_attested_commissioning_candidate'
  ) THEN RAISE EXCEPTION 'fee_policy_release_inactive'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM private.strata_runtime_auth_user_v1 u JOIN private.role_assignments role
      ON lower(btrim(u.email))=lower(btrim(role.email))
    WHERE u.id=NEW.approved_by_admin_id AND u.email_confirmed_at IS NOT NULL
      AND role.role='ADMIN'
  ) THEN RAISE EXCEPTION 'fee_policy_issuer_not_admin'; END IF;
  SELECT count(DISTINCT review.reviewer_user_id) INTO eligible_reviews
    FROM private.strata_fee_source_policy_reviews review
    JOIN private.strata_runtime_auth_user_v1 u ON u.id=review.reviewer_user_id
    JOIN private.role_assignments role
      ON lower(btrim(u.email))=lower(btrim(role.email))
    WHERE review.release_id=NEW.release_id
      AND review.owner_user_id=NEW.owner_user_id
      AND review.policy_decision_sha256=NEW.policy_decision_sha256
      AND review.reviewed_pdf_sha256=NEW.reviewed_pdf_sha256
      AND review.revoked_at IS NULL AND review.expires_at>now()
      AND u.email_confirmed_at IS NOT NULL AND role.role='ADMIN';
  IF eligible_reviews < 2 THEN RAISE EXCEPTION 'two_independent_fee_policy_admins_required'; END IF;
  RETURN NEW;
END
$function$
;

-- Row locks require UPDATE on one column. Actual identity changes remain
-- refused, including no-op changes, by a restrictive RLS check (app tables)
-- or the read-only view trigger (managed Auth). No Auth privilege is granted.
GRANT UPDATE(id) ON public.profiles TO strata_api_runtime;
GRANT UPDATE(email) ON private.role_assignments TO strata_api_runtime;
CREATE POLICY strata_api_runtime_no_identity_update_v1 ON public.profiles AS RESTRICTIVE FOR UPDATE TO strata_api_runtime USING(true) WITH CHECK(false);
CREATE POLICY strata_api_runtime_no_identity_update_v1 ON private.role_assignments AS RESTRICTIVE FOR UPDATE TO strata_api_runtime USING(true) WITH CHECK(false);
-- The cash-conservation proof locks immutable event/observation rows. These
-- column-level grants admit the read locks, never physical history updates.
GRANT UPDATE(event_id) ON public.v13_production_event TO strata_api_runtime;
GRANT UPDATE(id) ON public.v13_production_observation,public.strata_direct_entry_source TO strata_api_runtime;
CREATE POLICY strata_api_runtime_immutable_event_v1 ON public.v13_production_event AS RESTRICTIVE FOR UPDATE TO strata_api_runtime USING(true) WITH CHECK(false);
CREATE POLICY strata_api_runtime_immutable_observation_v1 ON public.v13_production_observation AS RESTRICTIVE FOR UPDATE TO strata_api_runtime USING(true) WITH CHECK(false);
CREATE POLICY strata_api_runtime_immutable_source_v1 ON public.strata_direct_entry_source AS RESTRICTIVE FOR UPDATE TO strata_api_runtime USING(true) WITH CHECK(false);
GRANT SELECT ON vault.decrypted_secrets TO strata_api_runtime;
DO $sequences$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['private.mfa_login_policy_audit_id_seq','private.strata_continuous_execution_audit_audit_id_seq','private.strata_platform_official_fee_capture_v1_capture_id_seq','private.strata_platform_uploaded_fee_schedule_upload_id_seq','private.strata_railway_official_fee_capture_v5_capture_id_seq','private.strata_v13_execution_trace_trace_id_seq','private.strata_v13_signal_decisions_decision_id_seq','public.strata_official_fee_captures_id_seq'] LOOP
  IF to_regclass(name) IS NOT NULL THEN
   EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE %s TO strata_api_runtime',to_regclass(name));
  END IF;
 END LOOP;
END
$sequences$;
GRANT EXECUTE ON FUNCTION private.strata_exit_request_quantity_hundredths(jsonb),
 private.strata_platform_fee_require_safe_cutover(),private.strata_reserve_member_read_token(integer),
 public.register_kalshi_credential(uuid,uuid,text,text,text),
 public.strata_two_operator_fee_reviews_valid(uuid,uuid,text) TO strata_api_runtime;
DO $vault$
DECLARE signature text; found boolean:=false;
BEGIN
 -- Production Vault has a defaulted fourth UUID argument. The deliberately
 -- synthetic native platform fixture exposes the three-argument equivalent.
 FOREACH signature IN ARRAY ARRAY['vault.create_secret(text,text,text,uuid)','vault.create_secret(text,text,text)'] LOOP
  IF to_regprocedure(signature) IS NOT NULL THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO strata_api_runtime',to_regprocedure(signature)); found:=true;
  END IF;
 END LOOP;
 IF NOT found THEN RAISE EXCEPTION 'runtime_role_vault_create_missing'; END IF;
 IF to_regprocedure('vault._crypto_aead_det_decrypt(bytea,bytea,bigint,bytea,bytea)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION vault._crypto_aead_det_decrypt(bytea,bytea,bigint,bytea,bytea) TO strata_api_runtime;
 END IF;
END
$vault$;
COMMIT;
