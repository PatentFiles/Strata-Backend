-- Additive migration candidate; apply through reviewed database deployment only.
-- No account, grant, data, schema ownership, or trading permission is changed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION private.enforce_owner_settled_cash_recovery_commit_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE
 a record; l record; observed_at timestamptz; actual_now timestamptz;
BEGIN
 IF NEW.payload->>'priorReason' IS DISTINCT FROM 'production_external_cash_mismatch'
    OR NEW.payload->>'accountId' IS DISTINCT FROM NEW.account_id
    OR NEW.payload->'tradingAuthorized' IS DISTINCT FROM 'false'::jsonb
    OR COALESCE(NEW.payload->>'observedAtMs','') !~ '^[0-9]{1,15}$'
    OR COALESCE(NEW.payload->>'priorRevision','') !~ '^[0-9]{1,18}$'
    OR COALESCE(NEW.payload->>'fencingToken','') !~ '^[0-9]{1,19}$'
    OR COALESCE(NEW.payload->>'evidenceDigest','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(NEW.payload->>'settlementEventId','') !~ '^settlement:[A-Za-z0-9:._-]{1,200}$'
 THEN
  RAISE EXCEPTION 'owner_settled_cash_recovery_commit_scope_invalid' USING ERRCODE='23514';
 END IF;

 observed_at := to_timestamp((NEW.payload->>'observedAtMs')::numeric / 1000);
 actual_now := clock_timestamp();
 IF actual_now < observed_at OR actual_now >= observed_at + interval '5 seconds' THEN
  RAISE EXCEPTION 'owner_settled_cash_recovery_commit_expired' USING ERRCODE='23514';
 END IF;

 SELECT owner_user_id, revision, blocked_reason, reconciled_at, evidence_digest, execution_enabled,
  kill_switch, key_fingerprint, subaccount, exchange_index, reserved_micros
 INTO a FROM public.v13_production_account WHERE id=NEW.account_id;
 IF NOT FOUND OR a.owner_user_id::text IS DISTINCT FROM NEW.payload->>'owner'
    OR a.revision IS DISTINCT FROM (NEW.payload->>'priorRevision')::bigint + 1
    OR a.blocked_reason IS NOT NULL OR a.execution_enabled IS DISTINCT FROM false
    OR a.kill_switch IS DISTINCT FROM true OR a.reconciled_at IS DISTINCT FROM observed_at
    OR a.evidence_digest IS DISTINCT FROM NEW.payload->>'evidenceDigest'
    OR a.subaccount IS DISTINCT FROM 1 OR a.exchange_index IS DISTINCT FROM 2
    OR a.reserved_micros IS DISTINCT FROM 0::bigint
 THEN
  RAISE EXCEPTION 'owner_settled_cash_recovery_commit_state_invalid' USING ERRCODE='23514';
 END IF;

 SELECT state, arm_requested, credential_fingerprint, fencing_token INTO STRICT l
 FROM private.kalshi_account_worker_lease
 WHERE execution_account_id=NEW.account_id AND owner_user_id=a.owner_user_id;
 IF l.state IS DISTINCT FROM 'released' OR l.arm_requested IS DISTINCT FROM false
    OR l.credential_fingerprint IS DISTINCT FROM a.key_fingerprint
    OR l.fencing_token::text IS DISTINCT FROM NEW.payload->>'fencingToken'
 THEN
  RAISE EXCEPTION 'owner_settled_cash_recovery_commit_worker_invalid' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $fn$;

CREATE FUNCTION private.enforce_owner_settled_cash_recovery_transition_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN
 IF NEW.revision IS DISTINCT FROM OLD.revision+1
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.cash_micros IS DISTINCT FROM OLD.cash_micros
    OR NEW.reserved_micros IS DISTINCT FROM 0::bigint
    OR OLD.reserved_micros IS DISTINCT FROM 0::bigint
    OR NEW.execution_enabled IS DISTINCT FROM false OR NEW.kill_switch IS DISTINCT FROM true
    OR NEW.evidence_digest IS NULL OR NEW.reconciled_at IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.v13_production_observation o
      WHERE o.account_id=NEW.id AND o.kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'
       -- Epoch-safe low xid bits; the recovery transaction never uses a savepoint.
       AND o.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296::numeric)
       AND o.payload->>'owner'=NEW.owner_user_id::text
       AND o.payload->>'priorRevision'=OLD.revision::text
       AND o.payload->>'priorReason'=OLD.blocked_reason
       AND o.payload->>'evidenceDigest'=NEW.evidence_digest
       AND o.payload->>'observedAtMs'=trunc(extract(epoch FROM NEW.reconciled_at)*1000)::bigint::text
       AND o.payload->'tradingAuthorized'='false'::jsonb
    )
 THEN
  RAISE EXCEPTION 'owner_settled_cash_recovery_transition_unproven' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $fn$;

REVOKE ALL ON FUNCTION private.enforce_owner_settled_cash_recovery_commit_fence() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.enforce_owner_settled_cash_recovery_transition_fence() FROM PUBLIC,anon,authenticated;

-- Unexpected per-role default privileges must not silently expose either function.
DO $acl$
BEGIN
 IF EXISTS (
   SELECT FROM pg_catalog.pg_proc p
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   WHERE p.oid IN ('private.enforce_owner_settled_cash_recovery_commit_fence()'::regprocedure,
                   'private.enforce_owner_settled_cash_recovery_transition_fence()'::regprocedure)
    AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
 ) THEN
  RAISE EXCEPTION 'owner_settled_cash_recovery_unexpected_function_acl';
 END IF;
END $acl$;

CREATE CONSTRAINT TRIGGER owner_settled_cash_recovery_commit_fence
 AFTER INSERT ON public.v13_production_observation DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN (NEW.kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY')
 EXECUTE FUNCTION private.enforce_owner_settled_cash_recovery_commit_fence();
ALTER TABLE public.v13_production_observation ENABLE ALWAYS TRIGGER owner_settled_cash_recovery_commit_fence;

CREATE CONSTRAINT TRIGGER owner_settled_cash_recovery_transition_fence
 AFTER UPDATE OF blocked_reason ON public.v13_production_account DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN (OLD.blocked_reason='production_external_cash_mismatch' AND NEW.blocked_reason IS NULL)
 EXECUTE FUNCTION private.enforce_owner_settled_cash_recovery_transition_fence();
ALTER TABLE public.v13_production_account ENABLE ALWAYS TRIGGER owner_settled_cash_recovery_transition_fence;
COMMIT;
