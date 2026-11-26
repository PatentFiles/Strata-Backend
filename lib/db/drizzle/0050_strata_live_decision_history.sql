-- Append-only advisory evidence. No execution, approval, fee or balance authority.
BEGIN;
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE private.strata_live_decision_log_v1 (
  id uuid PRIMARY KEY,
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  owner_user_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[a-f0-9]{40}$'),
  stage text NOT NULL CHECK (stage IN ('OBSERVATION','ENTRY_GATE','PREPARE','DISPATCH')),
  outcome text NOT NULL CHECK (outcome IN ('PASS','QUALIFIED','BLOCKED','ERROR')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,127}$'),
  reason_detail text CHECK (length(reason_detail)<=512),
  market_ticker text CHECK (length(market_ticker)<=128),
  direction text CHECK (direction IN ('UP','DOWN','NONE')),
  signal text CHECK (signal IN ('PASS','WATCH','SCOUT','CONFIRM','EXIT')),
  direct_source_id text,
  policy_hash text CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  policy_revision integer CHECK (policy_revision>0),
  configured_stake_cents integer CHECK (configured_stake_cents>0),
  allocation_preset text CHECK (length(allocation_preset)<=120),
  strategy_version text,
  strategy_parameter_hash text CHECK (strategy_parameter_hash ~ '^[a-f0-9]{64}$'),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=16384),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX strata_live_decision_owner_time_v1 ON private.strata_live_decision_log_v1(owner_user_id,observed_at DESC,id DESC);
CREATE INDEX strata_live_decision_account_time_v1 ON private.strata_live_decision_log_v1(execution_account_id,observed_at DESC,id DESC);
CREATE INDEX strata_live_decision_time_v1 ON private.strata_live_decision_log_v1(observed_at DESC,id DESC);
CREATE INDEX strata_live_decision_source_v1 ON private.strata_live_decision_log_v1(execution_account_id,direct_source_id) WHERE direct_source_id IS NOT NULL;
ALTER TABLE private.strata_live_decision_log_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_live_decision_log_v1 FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON private.strata_live_decision_log_v1 FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON private.strata_live_decision_log_v1 FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN REVOKE ALL ON private.strata_live_decision_log_v1 FROM service_role; END IF;
END $$;
CREATE FUNCTION private.strata_live_decision_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'live_decision_immutable'; END $$;
CREATE TRIGGER strata_live_decision_immutable_v1
BEFORE UPDATE OR DELETE ON private.strata_live_decision_log_v1
FOR EACH ROW EXECUTE FUNCTION private.strata_live_decision_immutable_v1();
COMMIT;
