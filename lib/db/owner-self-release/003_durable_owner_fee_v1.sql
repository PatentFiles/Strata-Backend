-- Atomic one-time candidate migration. No runtime grants included.
-- Existing objects are an explicit conflict: never silently skip schema drift.
-- Apply only through a reviewed migration runner; duplicate/partial prior installs fail closed.
BEGIN;
CREATE TABLE private.strata_durable_owner_fee_model(
 model_id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK(release_commit_sha~'^[a-f0-9]{40}$'),
 approved_policy_hash text NOT NULL CHECK(approved_policy_hash~'^[a-f0-9]{64}$'),
 source_capture_id bigint NOT NULL REFERENCES private.strata_railway_official_fee_capture_v5(capture_id),
 official_source_digest text NOT NULL CHECK(official_source_digest~'^[a-f0-9]{64}$'),
 policy_version text NOT NULL CHECK(policy_version='owner_approved_canonical_terms_v1'),
 formula_version text NOT NULL CHECK(formula_version='standard-quadratic-0.07-v1'),
 effective_date date NOT NULL CHECK(effective_date='2026-07-07'),
 confirmation text NOT NULL CHECK(confirmation='I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1'),
 genuine_source_verified boolean NOT NULL CHECK(genuine_source_verified),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash)
);
CREATE FUNCTION private.durable_fee_model_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable durable fee model'; END IF;
 IF NOT EXISTS(SELECT 1 FROM private.strata_railway_official_fee_capture_v5 c
 JOIN public.v13_production_account a ON a.id=c.execution_account_id
 WHERE c.capture_id=NEW.source_capture_id AND a.id=NEW.execution_account_id AND a.owner_user_id=NEW.owner_user_id
 AND c.content_sha256=NEW.official_source_digest AND c.effective_date=NEW.effective_date
 AND c.canonical_url='https://kalshi.com/docs/kalshi-fee-schedule.pdf'
 AND c.source_kind='railway_canonical_https_direct'
 AND c.captured_at<=clock_timestamp() AND c.expires_at>clock_timestamp()) THEN
 RAISE EXCEPTION 'fresh genuine exact-owner capture required at enrollment'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER durable_fee_model_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private.strata_durable_owner_fee_model FOR EACH ROW EXECUTE FUNCTION private.durable_fee_model_guard();
CREATE TABLE private.strata_durable_owner_fee_state(
 model_id uuid PRIMARY KEY REFERENCES private.strata_durable_owner_fee_model(model_id),
 known_publication_change boolean NOT NULL DEFAULT false,
 monitor_state text NOT NULL DEFAULT 'never_checked' CHECK(monitor_state IN('unchanged','unavailable','changed','never_checked')),
 entry_revoked boolean NOT NULL DEFAULT false
);
CREATE FUNCTION private.durable_fee_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'durable fee state retained'; END IF;
 IF OLD.model_id<>NEW.model_id OR (OLD.known_publication_change AND NOT NEW.known_publication_change)
 OR (OLD.entry_revoked AND NOT NEW.entry_revoked) THEN RAISE EXCEPTION 'monotonic durable fee state'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER durable_fee_state_guard BEFORE UPDATE OR DELETE
 ON private.strata_durable_owner_fee_state FOR EACH ROW EXECUTE FUNCTION private.durable_fee_state_guard();
ALTER TABLE private.strata_durable_owner_fee_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_durable_owner_fee_model FORCE ROW LEVEL SECURITY;
ALTER TABLE private.strata_durable_owner_fee_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_durable_owner_fee_state FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_durable_owner_fee_model,private.strata_durable_owner_fee_state FROM PUBLIC,anon,authenticated;
CREATE TABLE private.strata_durable_fee_publication_observation(
 observation_id uuid PRIMARY KEY,model_id uuid NOT NULL REFERENCES private.strata_durable_owner_fee_model(model_id),
 source_capture_id bigint REFERENCES private.strata_railway_official_fee_capture_v5(capture_id),
 source_digest text, result text NOT NULL CHECK(result IN('unchanged','changed','unavailable','invalid')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((result='unavailable' AND source_capture_id IS NULL AND source_digest IS NULL) OR (result='invalid' AND source_digest IS NULL) OR
 (result IN('unchanged','changed') AND source_capture_id IS NOT NULL AND source_digest~'^[a-f0-9]{64}$'))
);
CREATE FUNCTION private.durable_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable durable publication observation'; END $$;
CREATE TRIGGER durable_observation_immutable BEFORE UPDATE OR DELETE ON private.strata_durable_fee_publication_observation
 FOR EACH ROW EXECUTE FUNCTION private.durable_observation_immutable();
ALTER TABLE private.strata_durable_fee_publication_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_durable_fee_publication_observation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_durable_fee_publication_observation FROM PUBLIC,anon,authenticated;

-- Same-transaction change propagation; background monitor is not the admission fence.
CREATE FUNCTION private.durable_capture_change_latch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Serialize capture/enrollment against the same account before state locks.
 PERFORM 1 FROM public.v13_production_account WHERE id=NEW.execution_account_id FOR UPDATE;
 UPDATE private.strata_durable_owner_fee_state s SET known_publication_change=true,monitor_state='changed'
 FROM private.strata_durable_owner_fee_model m,private.strata_railway_official_fee_capture_v5 original
 WHERE m.model_id=s.model_id AND original.capture_id=m.source_capture_id
 AND m.execution_account_id=NEW.execution_account_id AND NEW.captured_at>=original.captured_at
 AND NEW.content_sha256<>m.official_source_digest;
 RETURN NEW;
END $$;
CREATE TRIGGER durable_capture_change_latch AFTER INSERT ON private.strata_railway_official_fee_capture_v5
 FOR EACH ROW EXECUTE FUNCTION private.durable_capture_change_latch();
CREATE FUNCTION private.durable_enrollment_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.strata_railway_official_fee_capture_v5 c
 WHERE c.capture_id=NEW.source_capture_id AND c.expires_at>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM private.strata_railway_official_fee_capture_v5 later
 WHERE later.execution_account_id=NEW.execution_account_id AND later.captured_at>=c.captured_at
 AND later.content_sha256<>NEW.official_source_digest)) THEN
 RAISE EXCEPTION 'durable enrollment capture expired or changed at commit'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER durable_enrollment_deadline AFTER INSERT ON private.strata_durable_owner_fee_model DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.durable_enrollment_deadline();
CREATE TABLE private.strata_durable_fee_revocation(event_id uuid PRIMARY KEY,model_id uuid NOT NULL REFERENCES private.strata_durable_owner_fee_model(model_id),owner_user_id uuid NOT NULL REFERENCES auth.users(id),revoked_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER durable_revocation_immutable BEFORE UPDATE OR DELETE ON private.strata_durable_fee_revocation FOR EACH ROW EXECUTE FUNCTION private.durable_observation_immutable();
ALTER TABLE private.strata_durable_fee_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_durable_fee_revocation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_durable_fee_revocation FROM PUBLIC,anon,authenticated;
CREATE TABLE private.strata_durable_fee_migration(
 model_id uuid PRIMARY KEY REFERENCES private.strata_durable_owner_fee_model(model_id),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK(release_commit_sha ~ '^[a-f0-9]{40}$'),
 prior_policy_id text NOT NULL,prior_policy_hash text NOT NULL CHECK(prior_policy_hash ~ '^[a-f0-9]{64}$'),
 new_policy_id text NOT NULL,new_policy_hash text NOT NULL CHECK(new_policy_hash ~ '^[a-f0-9]{64}$'),
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 confirmation text NOT NULL CHECK(confirmation='I_APPROVE_ATOMIC_MIGRATION_TO_DURABLE_OFFICIAL_FEE_TERMS_V1'),
 risk_acceptance text NOT NULL CHECK(risk_acceptance='I_ACCEPT_PUBLICATION_FRESHNESS_MAY_BE_UNKNOWN_AND_UNBOUNDED_FEE_EXITS_MAY_BLOCK_V1'),
 migrated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER durable_migration_immutable BEFORE UPDATE OR DELETE ON private.strata_durable_fee_migration FOR EACH ROW EXECUTE FUNCTION private.durable_observation_immutable();
ALTER TABLE private.strata_durable_fee_migration ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_durable_fee_migration FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_durable_fee_migration FROM PUBLIC,anon,authenticated;
-- Write-once public migration attempt. Terminal rejection is an auditable
-- no-commit receipt, not permission to replay the same model identity.
CREATE TABLE private.strata_durable_fee_migration_attempt(
 model_id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES auth.users(id),execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL,body_hash text NOT NULL,request jsonb NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','REJECTED')),reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),resolved_at timestamptz,
 CHECK((state='PENDING' AND reason IS NULL AND resolved_at IS NULL) OR (state='REJECTED' AND reason IS NOT NULL AND resolved_at IS NOT NULL)));
CREATE FUNCTION private.durable_migration_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'PENDING' OR NEW.state<>'REJECTED' OR
 (to_jsonb(OLD)-'state'-'reason'-'resolved_at') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'reason'-'resolved_at') THEN
 RAISE EXCEPTION 'durable migration attempt immutable'; END IF;
 IF EXISTS(SELECT 1 FROM private.strata_durable_owner_fee_model WHERE model_id=OLD.model_id) THEN
 RAISE EXCEPTION 'durable migration cannot reject committed model'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER durable_migration_attempt_guard BEFORE UPDATE OR DELETE ON private.strata_durable_fee_migration_attempt FOR EACH ROW EXECUTE FUNCTION private.durable_migration_attempt_guard();
ALTER TABLE private.strata_durable_fee_migration_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_durable_fee_migration_attempt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_durable_fee_migration_attempt FROM PUBLIC,anon,authenticated;
COMMIT;
