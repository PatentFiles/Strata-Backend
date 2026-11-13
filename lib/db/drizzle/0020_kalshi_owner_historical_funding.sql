-- Review-gated historical Kalshi receipt evidence for pre-migration funding only.
-- NO Kalshi funds are moved, no 0017/0018 transfer attempts are fabricated.
-- Apply with approved migration process BEFORE deploying the verifier.
BEGIN;
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.kalshi_owner_historical_funding (
  execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  exchange_transfer_id text NOT NULL,
  transfer_created_at timestamptz NOT NULL,
  primary_after_cents bigint NOT NULL,
  bot_after_cents bigint NOT NULL,
  verified_at timestamptz NOT NULL,
  CONSTRAINT kalshi_owner_historical_funding_primary_cash_check CHECK (primary_after_cents = 0),
  CONSTRAINT kalshi_owner_historical_funding_bot_cash_check CHECK (bot_after_cents = 2500),
  CONSTRAINT kalshi_owner_historical_funding_receipt_len_check
    CHECK (char_length(exchange_transfer_id) BETWEEN 8 AND 128)
);
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_owner_historical_funding_receipt_uq
  ON private.kalshi_owner_historical_funding (exchange_transfer_id);
CREATE INDEX IF NOT EXISTS kalshi_owner_historical_funding_owner_idx
  ON private.kalshi_owner_historical_funding (owner_user_id);
ALTER TABLE private.kalshi_owner_historical_funding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.kalshi_owner_historical_funding FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE private.kalshi_owner_historical_funding IS
  'Verified historical Kalshi transfer receipt; not a new transfer or trading approval. Writes only from privileged scoped backend verification.';
COMMIT;
