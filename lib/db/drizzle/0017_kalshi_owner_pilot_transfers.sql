-- Review-gated pilot transfer ledger. Do not use this migration to move funds.
-- Applying it only adds account-owned immutable transfer intent records.
-- No app startup migration. Apply separately before deploying the transfer UI.
BEGIN;
CREATE TABLE IF NOT EXISTS private.kalshi_owner_pilot_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Kalshi client_transfer_id
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  financial_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  authority_credential_id uuid NOT NULL,
  authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[0-9a-f]{64}$'),
  amount_cents integer NOT NULL DEFAULT 2500 CHECK (amount_cents = 2500),
  from_subaccount smallint NOT NULL DEFAULT 0 CHECK (from_subaccount = 0),
  to_subaccount smallint NOT NULL DEFAULT 1 CHECK (to_subaccount = 1),
  exchange_index smallint NOT NULL DEFAULT 2 CHECK (exchange_index = 2),
  primary_before_cents bigint NOT NULL CHECK (primary_before_cents >= 2500),
  bot_before_cents bigint NOT NULL CHECK (bot_before_cents = 0),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'attempted', 'uncertain', 'completed')),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  completed_at timestamptz,
  primary_after_cents bigint,
  bot_after_cents bigint,
  failure_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kalshi_owner_pilot_transfer_one_per_account UNIQUE (execution_account_id),
  CONSTRAINT kalshi_owner_pilot_transfer_owner_link FOREIGN KEY (financial_account_id,owner_user_id)
    REFERENCES public.financial_accounts(id,user_id),
  CONSTRAINT kalshi_owner_pilot_transfer_connection_link FOREIGN KEY (provider_connection_id,financial_account_id)
    REFERENCES private.provider_connections(id,financial_account_id),
  CONSTRAINT kalshi_owner_pilot_transfer_credential_link FOREIGN KEY (authority_credential_id,owner_user_id,provider_connection_id)
    REFERENCES private.kalshi_connection_credentials(id,owner_user_id,provider_connection_id),
  CONSTRAINT kalshi_owner_pilot_transfer_timing CHECK (
    (state = 'prepared' AND attempted_at IS NULL AND completed_at IS NULL)
    OR (state IN ('attempted','uncertain') AND attempted_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND attempted_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS kalshi_owner_pilot_transfers_owner_idx
  ON private.kalshi_owner_pilot_transfers (owner_user_id,prepared_at DESC);
-- No RLS policy: only trusted backend DB role may access private records.
COMMIT;
