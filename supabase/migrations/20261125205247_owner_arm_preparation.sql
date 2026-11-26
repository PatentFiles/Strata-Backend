-- Additive owner lifecycle bookkeeping only. No account is activated, no
-- existing consent is changed, and no worker is started by this migration.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.v13_production_account
  ADD COLUMN owner_control_epoch bigint NOT NULL DEFAULT 0
  CHECK (owner_control_epoch>=0);

CREATE TABLE private.strata_owner_arm_attempt (
  request_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  control_epoch bigint NOT NULL CHECK (control_epoch>0),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[a-f0-9]{40}$'),
  state text NOT NULL CHECK (state IN ('PREPARING','READY','STARTING','STARTED','BLOCKED')),
  stage text NOT NULL CHECK (stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,119}$'),
  final_stake_cents integer CHECK (final_stake_cents BETWEEN 500 AND 2500000),
  final_policy_hash text CHECK (final_policy_hash ~ '^[a-f0-9]{64}$'),
  final_fee_digest text CHECK (final_fee_digest ~ '^[a-f0-9]{64}$'),
  final_key_fingerprint text CHECK (final_key_fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (execution_account_id,control_epoch),
  CHECK (expires_at>created_at),
  CHECK (state NOT IN ('READY','STARTING','STARTED') OR
    (final_policy_hash IS NOT NULL AND final_fee_digest IS NOT NULL AND final_key_fingerprint IS NOT NULL AND final_stake_cents IS NOT NULL))
);
CREATE INDEX strata_owner_arm_readback ON private.strata_owner_arm_attempt(owner_user_id,created_at DESC);
CREATE UNIQUE INDEX strata_owner_arm_single_preparation ON private.strata_owner_arm_attempt(execution_account_id)
  WHERE state IN ('PREPARING','STARTING');
ALTER TABLE private.strata_owner_arm_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_arm_attempt FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.strata_owner_arm_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'owner arm history retained'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'PREPARING' OR NEW.final_policy_hash IS NOT NULL OR NEW.final_fee_digest IS NOT NULL
      OR NEW.final_key_fingerprint IS NOT NULL OR NEW.final_stake_cents IS NOT NULL THEN RAISE EXCEPTION 'owner arm must begin preparing'; END IF;
   PERFORM 1 FROM public.v13_production_account a WHERE a.id=NEW.execution_account_id
     AND a.owner_user_id=NEW.owner_user_id AND a.owner_control_epoch=NEW.control_epoch;
   IF NOT FOUND THEN RAISE EXCEPTION 'owner arm account scope mismatch'; END IF;
 ELSE
   IF (OLD.request_id,OLD.owner_user_id,OLD.execution_account_id,OLD.control_epoch,OLD.scope_digest,
       OLD.release_commit_sha,OLD.created_at) IS DISTINCT FROM
      (NEW.request_id,NEW.owner_user_id,NEW.execution_account_id,NEW.control_epoch,NEW.scope_digest,
       NEW.release_commit_sha,NEW.created_at) THEN RAISE EXCEPTION 'owner arm immutable scope'; END IF;
   IF NOT ((OLD.state='PREPARING' AND NEW.state IN ('PREPARING','READY','BLOCKED')) OR
           (OLD.state='READY' AND NEW.state IN ('STARTING','BLOCKED')) OR
           (OLD.state='STARTING' AND NEW.state IN ('STARTED','BLOCKED'))) THEN
     RAISE EXCEPTION 'owner arm terminal or invalid transition';
   END IF;
   IF OLD.state<>'PREPARING' AND
     (OLD.final_policy_hash,OLD.final_fee_digest,OLD.final_key_fingerprint,OLD.final_stake_cents) IS DISTINCT FROM
     (NEW.final_policy_hash,NEW.final_fee_digest,NEW.final_key_fingerprint,NEW.final_stake_cents) THEN
       RAISE EXCEPTION 'owner arm approved scope immutable';
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_owner_arm_history_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER strata_owner_arm_history_guard BEFORE INSERT OR UPDATE OR DELETE
  ON private.strata_owner_arm_attempt FOR EACH ROW EXECUTE FUNCTION private.strata_owner_arm_history_guard();

-- Only the established trusted backend role may use this bookkeeping. Clients
-- access authenticated owner routes; no browser role receives table access.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
   GRANT SELECT,INSERT,UPDATE ON private.strata_owner_arm_attempt TO strata_api_runtime;
   GRANT EXECUTE ON FUNCTION private.strata_owner_arm_history_guard() TO strata_api_runtime;
   CREATE POLICY strata_api_runtime_owner_arm ON private.strata_owner_arm_attempt
     TO strata_api_runtime USING (true) WITH CHECK (true);
 END IF;
END $$;
COMMIT;
