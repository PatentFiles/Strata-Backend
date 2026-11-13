-- Configured per-owner cash sweeps. Disarmed by default; no transfer on migration.
CREATE TABLE IF NOT EXISTS private.strata_auto_profit_withdrawal_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL UNIQUE REFERENCES public.v13_production_account(id),
  enabled boolean NOT NULL DEFAULT false,
  trigger_cents bigint NOT NULL CHECK (trigger_cents > 0 AND trigger_cents <= 100000000000),
  withdraw_cents bigint NOT NULL CHECK (withdraw_cents > 0 AND withdraw_cents <= 100000000000),
  retain_cents bigint NOT NULL CHECK (retain_cents >= 0 AND retain_cents <= 100000000000),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  latched boolean NOT NULL DEFAULT false,
  last_triggered_at timestamptz,
  last_completed_at timestamptz,
  last_observed_below_at timestamptz,
  last_attempt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strata_auto_sweep_threshold_fits_cash
    CHECK (trigger_cents >= withdraw_cents + retain_cents)
);
CREATE INDEX IF NOT EXISTS strata_auto_sweep_enabled_rules
  ON private.strata_auto_profit_withdrawal_rules(updated_at)
  WHERE enabled;
ALTER TABLE private.strata_auto_profit_withdrawal_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_auto_profit_withdrawal_rules FROM PUBLIC, anon, authenticated;

ALTER TABLE private.strata_manual_profit_withdrawals
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual','automatic')),
  ADD COLUMN IF NOT EXISTS auto_rule_id uuid REFERENCES private.strata_auto_profit_withdrawal_rules(id),
  ADD COLUMN IF NOT EXISTS auto_rule_revision bigint,
  ADD CONSTRAINT strata_withdrawal_automatic_origin_provenance
    CHECK ((origin='manual' AND auto_rule_id IS NULL AND auto_rule_revision IS NULL)
      OR (origin='automatic' AND auto_rule_id IS NOT NULL AND auto_rule_revision>0));

COMMENT ON TABLE private.strata_auto_profit_withdrawal_rules IS
  'Owner-authorized auto cash sweep threshold. Separate from strategy; does not permit funds movement until approved routing, safe flat stopped account, and exchange reconciliation.';
COMMENT ON COLUMN private.strata_auto_profit_withdrawal_rules.latched IS
  'One sweep per balance threshold crossing; never rearm while an automatic attempt is unresolved.';
