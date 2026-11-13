-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Adds durable, user-owned preparation records for future Kalshi account setup.
-- This file does not call Kalshi, create a subaccount, generate a key, write a
-- Vault secret, provision an execution account, transfer funds, or place orders.
--
-- Rollback:
--   DROP TABLE IF EXISTS private.kalshi_account_operation_attempts;
--   DROP INDEX IF EXISTS private.kalshi_connection_credentials_id_owner_connection_uidx;
BEGIN;

-- id is already unique. This adds a composite ownership target so an attempt
-- cannot borrow another user's credential binding.
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_connection_credentials_id_owner_connection_uidx
  ON private.kalshi_connection_credentials (id, owner_user_id, provider_connection_id);

CREATE TABLE IF NOT EXISTS private.kalshi_account_operation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  financial_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  operation text NOT NULL,
  state text NOT NULL DEFAULT 'prepared',
  target_subaccount smallint NOT NULL DEFAULT 1,
  target_exchange_index smallint NOT NULL DEFAULT 2,
  authority_credential_id uuid NOT NULL,
  authority_fingerprint text NOT NULL,
  target_credential_id uuid,
  target_fingerprint text,
  planned_execution_account_id text,
  plan jsonb NOT NULL,
  precondition_digest text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  response_received_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  response_status integer,
  response_digest text,
  result_reference text,
  uncertainty_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kalshi_account_operation_attempts_operation_check CHECK (
    operation IN ('create_subaccount', 'generate_api_key', 'provision_execution_account')
  ),
  CONSTRAINT kalshi_account_operation_attempts_state_check CHECK (
    state IN ('prepared', 'attempted', 'response_received', 'uncertain', 'completed', 'cancelled')
  ),
  CONSTRAINT kalshi_account_operation_attempts_pair_check CHECK (
    target_subaccount = 1 AND target_exchange_index = 2
  ),
  CONSTRAINT kalshi_account_operation_attempts_authority_fingerprint_check CHECK (
    authority_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT kalshi_account_operation_attempts_target_fingerprint_check CHECK (
    target_fingerprint IS NULL OR target_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT kalshi_account_operation_attempts_precondition_digest_check CHECK (
    precondition_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT kalshi_account_operation_attempts_response_digest_check CHECK (
    response_digest IS NULL OR response_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT kalshi_account_operation_attempts_plan_check CHECK (
    jsonb_typeof(plan) = 'object'
    AND plan ->> 'operation' = operation
    AND plan::text !~* '"(private[_-]?key|secret|password|pem|authorization|api[_-]?key|token)"[[:space:]]*:'
    AND (
      (operation = 'create_subaccount'
        AND plan ->> 'exchangePath' = '/trade-api/v2/portfolio/subaccounts'
        AND plan ->> 'method' = 'POST'
        AND plan -> 'request' ->> 'exchange_index' = '2'
        AND plan ->> 'expectedSubaccount' = '1'
      )
      OR (operation = 'generate_api_key'
        AND plan ->> 'exchangePath' = '/trade-api/v2/api_keys/generate'
        AND plan ->> 'method' = 'POST'
        AND plan -> 'request' ->> 'name' = 'STRATA_V13_SUBACCOUNT_1'
        AND plan -> 'request' ->> 'key_type' = 'rsa'
        AND plan -> 'request' -> 'scopes' = '["read", "write::trade"]'::jsonb
        AND plan -> 'request' ->> 'subaccount' = '1'
        AND plan ->> 'vaultDestination' = 'supabase_vault')
      OR (operation = 'provision_execution_account'
        AND plan ->> 'plannedExecutionAccountId' ~ '^strata-account-[0-9a-f]{24}$'
        AND plan ->> 'subaccount' = '1'
        AND plan ->> 'exchangeIndex' = '2'
        AND plan ->> 'commissioned' = 'false'
        AND plan ->> 'executionEnabled' = 'false'
        AND plan ->> 'killSwitch' = 'true'
        AND plan ->> 'cashPrecisionVerified' = 'false')
    )
  ),
  CONSTRAINT kalshi_account_operation_attempts_result_reference_check CHECK (
    result_reference IS NULL OR (
      char_length(result_reference) BETWEEN 1 AND 200
      AND result_reference !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT kalshi_account_operation_attempts_uncertainty_check CHECK (
    uncertainty_reason IS NULL OR (
      char_length(uncertainty_reason) BETWEEN 1 AND 200
      AND uncertainty_reason !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT kalshi_account_operation_attempts_lifecycle_check CHECK (
    (state = 'prepared' AND attempted_at IS NULL AND response_received_at IS NULL
      AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'attempted' AND attempted_at IS NOT NULL AND response_received_at IS NULL
      AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'response_received' AND attempted_at IS NOT NULL AND response_received_at IS NOT NULL
      AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'uncertain' AND attempted_at IS NOT NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND uncertainty_reason IS NOT NULL)
    OR (state = 'completed' AND attempted_at IS NOT NULL AND response_received_at IS NOT NULL
      AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state = 'cancelled' AND attempted_at IS NULL AND response_received_at IS NULL
      AND completed_at IS NULL AND cancelled_at IS NOT NULL)
  ),
  CONSTRAINT kalshi_account_operation_attempts_owner_fk
    FOREIGN KEY (financial_account_id, owner_user_id)
    REFERENCES public.financial_accounts (id, user_id),
  CONSTRAINT kalshi_account_operation_attempts_connection_fk
    FOREIGN KEY (provider_connection_id, financial_account_id)
    REFERENCES private.provider_connections (id, financial_account_id),
  CONSTRAINT kalshi_account_operation_attempts_authority_fk
    FOREIGN KEY (authority_credential_id, owner_user_id, provider_connection_id)
    REFERENCES private.kalshi_connection_credentials (id, owner_user_id, provider_connection_id),
  CONSTRAINT kalshi_account_operation_attempts_target_fk
    FOREIGN KEY (target_credential_id, owner_user_id, provider_connection_id)
    REFERENCES private.kalshi_connection_credentials (id, owner_user_id, provider_connection_id)
);

-- One durable lifecycle per operation and owned connection. A future executor
-- must reconcile attempted/uncertain states; it must never create a replacement.
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_account_operation_attempts_once
  ON private.kalshi_account_operation_attempts (provider_connection_id, operation);

CREATE INDEX IF NOT EXISTS kalshi_account_operation_attempts_owner_idx
  ON private.kalshi_account_operation_attempts (owner_user_id, provider_connection_id);

ALTER TABLE private.kalshi_account_operation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.kalshi_account_operation_attempts FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_operation_attempts FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_operation_attempts FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_operation_attempts FROM service_role';
  END IF;
END $$;

COMMIT;
