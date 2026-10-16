-- REVIEW-ONLY MIGRATION: emergency exit PREPARATION ledger.
-- This does not authorize a POST, provide a fee grant, change any kill switch
-- or turn on execution. Apply ONLY after independent migration security review.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_emergency_exit_reservations (
  reservation_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  market_ticker text NOT NULL CHECK (market_ticker ~ '^KXBTC15M-[A-Za-z0-9-]+$'),
  client_order_id text NOT NULL UNIQUE
    CHECK (client_order_id ~ '^v13p-[a-f0-9-]{36}$'),
  reducing_side text NOT NULL CHECK (reducing_side IN ('YES','NO')),
  quantity_hundredths bigint NOT NULL CHECK (quantity_hundredths > 0),
  order_digest text NOT NULL CHECK (order_digest ~ '^[0-9a-f]{64}$'),
  worker_fencing_token bigint NOT NULL CHECK (worker_fencing_token > 0),
  worker_holder_id text NOT NULL CHECK (length(worker_holder_id) BETWEEN 1 AND 128),
  state text NOT NULL DEFAULT 'PREPARED'
    CHECK (state IN ('PREPARED','DISPATCHED','UNKNOWN','RECONCILED','VOID')),
  -- Not order authorization: preparing evidence NEVER grants execution.
  trading_authorized boolean NOT NULL DEFAULT false CHECK (trading_authorized=false),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_emergency_exit_single_unresolved_market
ON private.strata_emergency_exit_reservations(execution_account_id,market_ticker)
WHERE state IN ('PREPARED','DISPATCHED','UNKNOWN');

ALTER TABLE private.strata_emergency_exit_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_emergency_exit_reservations FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_emergency_exit_reservations IS
'Private recovery reservation/audit ledger. A PREPARED row has no trading authority; no public write access.';
COMMIT;
