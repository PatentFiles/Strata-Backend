-- Reliable Kalshi balance bucket allocation and owner withdrawal maintenance.
-- Slots are DB-serialized; no secrets, credentials, or balances are persisted here.
CREATE TABLE IF NOT EXISTS private.strata_kalshi_balance_read_slots (
  budget_key text PRIMARY KEY CHECK (length(budget_key)=64),
  next_slot_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON private.strata_kalshi_balance_read_slots FROM PUBLIC, anon, authenticated;
ALTER TABLE private.strata_kalshi_balance_read_slots ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE private.strata_kalshi_balance_read_slots IS
 'Cross-process allocation of Kalshi balance-only quota slots. Key is SHA-256 of owner or API key ID, not an actual credential.';

CREATE TABLE IF NOT EXISTS private.strata_auto_withdrawal_maintenance (
  execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  rule_id uuid NOT NULL REFERENCES private.strata_auto_profit_withdrawal_rules(id),
  rule_revision bigint NOT NULL CHECK (rule_revision > 0),
  cycle bigint NOT NULL DEFAULT 1 CHECK (cycle > 0),
  state text NOT NULL DEFAULT 'pause_requested' CHECK (
    state IN ('pause_requested','waiting_flat','ready_to_transfer','reconciling',
              'resume_requested','completed','blocked')),
  was_running boolean NOT NULL DEFAULT false,
  was_armed boolean NOT NULL DEFAULT false,
  initial_kill_switch boolean NOT NULL DEFAULT true,
  operator_interrupted boolean NOT NULL DEFAULT false,
  transfer_id uuid REFERENCES private.strata_manual_profit_withdrawals(id),
  last_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT strata_auto_maintenance_owner_unique UNIQUE (owner_user_id,execution_account_id)
);
CREATE INDEX IF NOT EXISTS strata_auto_withdrawal_pending
 ON private.strata_auto_withdrawal_maintenance(changed_at)
 WHERE state IN ('pause_requested','waiting_flat','ready_to_transfer','reconciling','resume_requested');
REVOKE ALL ON private.strata_auto_withdrawal_maintenance FROM PUBLIC, anon, authenticated;
ALTER TABLE private.strata_auto_withdrawal_maintenance ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE private.strata_auto_withdrawal_maintenance IS
 'Durable pause->flat->cash sweep->receipt->reconcile->conditionally resume state. Pauses forbid new entries. No emergency kill switch is ever auto-cleared.';
