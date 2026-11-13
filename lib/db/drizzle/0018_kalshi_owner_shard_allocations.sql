-- Owner-scoped $25 primary shard 0 -> primary shard 2 allocation ledger.
-- No Kalshi operation occurs from this migration; apply separately after review.
-- Record exactly one attempt per owned execution account, and never retry a
-- POST whose result may be unknown. Live transfers have a separate server flag.
BEGIN;
CREATE TABLE IF NOT EXISTS private.kalshi_owner_shard_allocations (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL UNIQUE REFERENCES public.v13_production_account(id),
  financial_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  authority_credential_id uuid NOT NULL,
  authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[0-9a-f]{64}$'),
  amount_cents integer NOT NULL DEFAULT 2500 CHECK (amount_cents=2500),
  from_subaccount smallint NOT NULL DEFAULT 0 CHECK (from_subaccount=0),
  to_subaccount smallint NOT NULL DEFAULT 0 CHECK (to_subaccount=0),
  source_exchange_index smallint NOT NULL DEFAULT 0 CHECK (source_exchange_index=0),
  destination_exchange_index smallint NOT NULL DEFAULT 2 CHECK (destination_exchange_index=2),
  source_before_cents bigint NOT NULL CHECK (source_before_cents>=2500),
  destination_before_cents bigint NOT NULL CHECK (destination_before_cents=0),
  bot_before_cents bigint NOT NULL CHECK (bot_before_cents=0),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','attempted','uncertain','completed')),
  exchange_transfer_id text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  completed_at timestamptz,
  verified_at timestamptz,
  source_after_cents bigint,
  destination_after_cents bigint,
  bot_after_cents bigint,
  failure_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shard_allocation_owner_account_fk
    FOREIGN KEY (financial_account_id,owner_user_id)
      REFERENCES public.financial_accounts(id,user_id),
  CONSTRAINT shard_allocation_connection_fk
    FOREIGN KEY (provider_connection_id,financial_account_id)
      REFERENCES private.provider_connections(id,financial_account_id),
  CONSTRAINT shard_allocation_credential_fk
    FOREIGN KEY (authority_credential_id,owner_user_id,provider_connection_id)
      REFERENCES private.kalshi_connection_credentials(id,owner_user_id,provider_connection_id),
  CONSTRAINT shard_allocation_state_time CHECK (
    (state='prepared' AND attempted_at IS NULL AND completed_at IS NULL)
    OR (state IN ('attempted','uncertain') AND attempted_at IS NOT NULL AND completed_at IS NULL)
    OR (state='completed' AND attempted_at IS NOT NULL AND completed_at IS NOT NULL
         AND verified_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS shard_allocations_owner_idx
  ON private.kalshi_owner_shard_allocations(owner_user_id,prepared_at DESC);
-- Private role only. No public RLS/grants, no auto-transfer trigger or job.
COMMIT;
