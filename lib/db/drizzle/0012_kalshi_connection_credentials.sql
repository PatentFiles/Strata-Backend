-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Adds role-scoped Kalshi credential bindings for a later commissioning phase.
-- This file does not insert bindings, does not copy provider_connections.vault_secret_id,
-- does not change v13_production_account, and does not enable execution.
--
-- Rollback, in this order:
--   DROP TRIGGER IF EXISTS kalshi_connection_credentials_vault_reuse ON private.kalshi_connection_credentials;
--   DROP FUNCTION IF EXISTS private.reject_reused_kalshi_vault_secret();
--   DROP TABLE IF EXISTS private.kalshi_connection_credentials;
--   DROP INDEX IF EXISTS private.provider_connections_id_financial_account_uidx;
BEGIN;

-- Required so a credential row can reference both the connection and its financial account.
-- id is already unique, so this adds no new row distinction.
CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_id_financial_account_uidx
  ON private.provider_connections (id, financial_account_id);

CREATE TABLE IF NOT EXISTS private.kalshi_connection_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  financial_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  role text NOT NULL,
  vault_secret_id uuid NOT NULL,
  key_fingerprint text,
  verified_at timestamptz,
  verification_reason text,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kalshi_connection_credentials_role_check CHECK (
    role IN ('provisioning', 'verification', 'restricted_execution')
  ),
  CONSTRAINT kalshi_connection_credentials_fingerprint_check CHECK (
    key_fingerprint IS NULL OR key_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT kalshi_connection_credentials_reason_check CHECK (
    verification_reason IS NULL OR (
      char_length(verification_reason) BETWEEN 1 AND 200
      AND verification_reason !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT kalshi_connection_credentials_lifecycle_check CHECK (
    (revoked_at IS NULL AND replaced_by IS NULL) OR revoked_at IS NOT NULL
  ),
  CONSTRAINT kalshi_connection_credentials_owner_account_fk
    FOREIGN KEY (financial_account_id, owner_user_id)
    REFERENCES public.financial_accounts (id, user_id),
  CONSTRAINT kalshi_connection_credentials_connection_fk
    FOREIGN KEY (provider_connection_id, financial_account_id)
    REFERENCES private.provider_connections (id, financial_account_id),
  CONSTRAINT kalshi_connection_credentials_replaced_by_fk
    FOREIGN KEY (replaced_by)
    REFERENCES private.kalshi_connection_credentials (id),
  CONSTRAINT kalshi_connection_credentials_vault_fk
    FOREIGN KEY (vault_secret_id)
    REFERENCES vault.secrets (id)
);

-- A Vault secret can belong to one binding, including a revoked historical row.
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_connection_credentials_vault_secret_uidx
  ON private.kalshi_connection_credentials (vault_secret_id);

-- Zero, one, or more roles may be absent. Only one active row is allowed per role.
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_connection_credentials_one_active_role
  ON private.kalshi_connection_credentials (provider_connection_id, role)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS kalshi_connection_credentials_owner_idx
  ON private.kalshi_connection_credentials (owner_user_id, provider_connection_id);

-- Not security definer and not granted to API roles. It only rejects reuse of the
-- wallet secret already stored on provider_connections.
CREATE OR REPLACE FUNCTION private.reject_reused_kalshi_vault_secret()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, private, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM private.provider_connections AS pc
    WHERE pc.vault_secret_id = NEW.vault_secret_id
  ) THEN
    RAISE EXCEPTION 'vault_secret_reused_from_provider_connection'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kalshi_connection_credentials_vault_reuse
  ON private.kalshi_connection_credentials;
CREATE TRIGGER kalshi_connection_credentials_vault_reuse
  BEFORE INSERT OR UPDATE OF vault_secret_id
  ON private.kalshi_connection_credentials
  FOR EACH ROW
  EXECUTE FUNCTION private.reject_reused_kalshi_vault_secret();

ALTER TABLE private.kalshi_connection_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.kalshi_connection_credentials FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reject_reused_kalshi_vault_secret() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_connection_credentials FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION private.reject_reused_kalshi_vault_secret() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_connection_credentials FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION private.reject_reused_kalshi_vault_secret() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_connection_credentials FROM service_role';
    EXECUTE 'REVOKE ALL ON FUNCTION private.reject_reused_kalshi_vault_secret() FROM service_role';
  END IF;
END $$;

COMMIT;
