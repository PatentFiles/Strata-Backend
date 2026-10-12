-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Adds one durable worker lease per owned execution account.
-- This file does not start a worker, does not arm execution, does not copy Vault
-- secrets, does not change historical fills or orders, and does not assign the
-- legacy singleton account.
--
-- Rollback, in this order:
--   DROP TABLE IF EXISTS private.kalshi_account_worker_lease;
--   DROP INDEX IF EXISTS public.v13_production_account_id_owner_uidx;
BEGIN;

-- id is already unique. This gives the lease a composite owner reference.
CREATE UNIQUE INDEX IF NOT EXISTS v13_production_account_id_owner_uidx
  ON public.v13_production_account (id, owner_user_id);

-- Present when 0012 has been reviewed. Repeated here so the connection foreign
-- key has its required unique target.
CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_id_financial_account_uidx
  ON private.provider_connections (id, financial_account_id);

CREATE TABLE IF NOT EXISTS private.kalshi_account_worker_lease (
  execution_account_id text PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  financial_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  holder_id text NOT NULL,
  fencing_token bigint NOT NULL,
  state text NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  account_kill boolean NOT NULL DEFAULT false,
  arm_requested boolean NOT NULL DEFAULT false,
  credential_fingerprint text NOT NULL,
  vault_secret_id uuid NOT NULL,
  CONSTRAINT kalshi_account_worker_lease_holder_check CHECK (
    char_length(holder_id) BETWEEN 1 AND 200
    AND holder_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT kalshi_account_worker_lease_fence_check CHECK (fencing_token > 0),
  CONSTRAINT kalshi_account_worker_lease_state_check CHECK (
    state IN ('owned', 'released', 'killed')
  ),
  CONSTRAINT kalshi_account_worker_lease_lifecycle_check CHECK (
    (state = 'owned' AND released_at IS NULL AND account_kill = false)
    OR (state = 'released' AND released_at IS NOT NULL AND account_kill = false)
    OR (state = 'killed' AND released_at IS NOT NULL AND account_kill = true)
  ),
  CONSTRAINT kalshi_account_worker_lease_fingerprint_check CHECK (
    credential_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT kalshi_account_worker_lease_owner_fk
    FOREIGN KEY (execution_account_id, owner_user_id)
    REFERENCES public.v13_production_account (id, owner_user_id),
  CONSTRAINT kalshi_account_worker_lease_account_owner_fk
    FOREIGN KEY (financial_account_id, owner_user_id)
    REFERENCES public.financial_accounts (id, user_id),
  CONSTRAINT kalshi_account_worker_lease_connection_fk
    FOREIGN KEY (provider_connection_id, financial_account_id)
    REFERENCES private.provider_connections (id, financial_account_id)
);

CREATE INDEX IF NOT EXISTS kalshi_account_worker_lease_owner_idx
  ON private.kalshi_account_worker_lease (owner_user_id, provider_connection_id);

ALTER TABLE private.kalshi_account_worker_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.kalshi_account_worker_lease FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_worker_lease FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_worker_lease FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_worker_lease FROM service_role';
  END IF;
END $$;

COMMIT;
