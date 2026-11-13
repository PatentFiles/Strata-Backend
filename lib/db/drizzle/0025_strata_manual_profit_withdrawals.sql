-- Owner-scoped, fail-closed manual cash withdrawal ledger.
-- New financial history is append-only by user intent; never rewrite prior transfers.
CREATE TABLE IF NOT EXISTS private.strata_manual_profit_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  state text NOT NULL CHECK (state IN ('prepared','attempted','pending','uncertain','completed','expired')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  retain_cents bigint NOT NULL CHECK (retain_cents >= 0),
  bot_before_cents bigint NOT NULL CHECK (bot_before_cents >= 0),
  cashier_before_cents bigint NOT NULL CHECK (cashier_before_cents >= 0),
  authority_fingerprint text NOT NULL,
  exchange_transfer_id text UNIQUE,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  attempted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_profit_withdrawal_one_active_per_account
  ON private.strata_manual_profit_withdrawals(execution_account_id)
  WHERE state IN ('prepared','attempted','pending','uncertain');
CREATE INDEX IF NOT EXISTS strata_profit_withdrawal_owner_history
  ON private.strata_manual_profit_withdrawals(owner_user_id,created_at DESC);
ALTER TABLE private.strata_manual_profit_withdrawals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_manual_profit_withdrawals FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE private.strata_manual_profit_withdrawals IS 'Kalshi cash sweep ledger; only authenticated server-side operations with explicit owner checks. A claim is durably committed before the single Kalshi POST, and ambiguous attempts are never retried.';
