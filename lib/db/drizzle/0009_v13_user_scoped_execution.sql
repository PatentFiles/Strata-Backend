-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Additive ownership for the existing V13 bot. This file does not assign the
-- legacy account, does not rewrite financial history, and does not enable execution.
-- Kalshi private keys stay in the existing Supabase Vault mapping
-- (private.provider_connections.vault_secret_id). No second secret copy is stored.
BEGIN;

ALTER TABLE v13_production_account
  ADD COLUMN IF NOT EXISTS owner_user_id uuid,
  ADD COLUMN IF NOT EXISTS kalshi_connection_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v13_production_account_connection_fk'
  ) THEN
    ALTER TABLE v13_production_account
      ADD CONSTRAINT v13_production_account_connection_fk
      FOREIGN KEY (kalshi_connection_id) REFERENCES public.financial_accounts(id);
  END IF;
END $$;

DROP INDEX IF EXISTS v13_production_account_pair;
CREATE UNIQUE INDEX IF NOT EXISTS v13_production_account_owned_pair
  ON v13_production_account (owner_user_id, subaccount, exchange_index)
  WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS v13_production_account_legacy_pair
  ON v13_production_account (subaccount, exchange_index)
  WHERE owner_user_id IS NULL;

ALTER TABLE v13_live_money_policy
  ADD COLUMN IF NOT EXISTS execution_account_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v13_live_money_policy_account_fk'
  ) THEN
    ALTER TABLE v13_live_money_policy
      ADD CONSTRAINT v13_live_money_policy_account_fk
      FOREIGN KEY (execution_account_id) REFERENCES v13_production_account(id);
  END IF;
END $$;

DROP INDEX IF EXISTS v13_live_money_policy_version_unique;
DROP INDEX IF EXISTS v13_live_money_policy_one_approved;
CREATE UNIQUE INDEX IF NOT EXISTS v13_live_money_policy_legacy_version
  ON v13_live_money_policy (version)
  WHERE execution_account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS v13_live_money_policy_account_version
  ON v13_live_money_policy (execution_account_id, version)
  WHERE execution_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS v13_live_money_policy_one_legacy_approved
  ON v13_live_money_policy (state)
  WHERE state = 'APPROVED' AND execution_account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS v13_live_money_policy_one_approved_per_account
  ON v13_live_money_policy (execution_account_id)
  WHERE state = 'APPROVED' AND execution_account_id IS NOT NULL;

ALTER TABLE strata_configured_stake
  ADD COLUMN IF NOT EXISTS execution_account_id text;

ALTER TABLE strata_configured_stake
  DROP CONSTRAINT IF EXISTS strata_configured_stake_singleton;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strata_configured_stake_account_fk'
  ) THEN
    ALTER TABLE strata_configured_stake
      ADD CONSTRAINT strata_configured_stake_account_fk
      FOREIGN KEY (execution_account_id) REFERENCES v13_production_account(id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS strata_configured_stake_account
  ON strata_configured_stake (execution_account_id)
  WHERE execution_account_id IS NOT NULL;

ALTER TABLE public.financial_accounts
  ADD COLUMN IF NOT EXISTS api_usage_tier text,
  ADD COLUMN IF NOT EXISTS bot_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bot_eligibility_reason text;

CREATE TABLE IF NOT EXISTS v13_shared_preset (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  creator_user_id uuid NOT NULL,
  creator_display_name text,
  capital_limit_cents integer NOT NULL,
  max_entry_stake_cents integer NOT NULL,
  max_entry_all_in_cents integer NOT NULL,
  max_daily_loss_cents integer NOT NULL,
  max_total_loss_cents integer NOT NULL,
  max_quote_age_ms integer NOT NULL,
  max_fee_evidence_age_ms integer NOT NULL,
  minimum_exit_micros integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v13_shared_preset_name CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT v13_shared_preset_limits CHECK (
    capital_limit_cents > 0 AND
    max_entry_stake_cents >= 1 AND max_entry_stake_cents <= 2500000 AND
    max_entry_all_in_cents >= max_entry_stake_cents AND
    max_entry_all_in_cents <= capital_limit_cents AND
    max_daily_loss_cents >= 1 AND max_daily_loss_cents <= capital_limit_cents AND
    max_total_loss_cents >= 1 AND max_total_loss_cents <= capital_limit_cents AND
    max_quote_age_ms BETWEEN 1 AND 15000 AND
    max_fee_evidence_age_ms BETWEEN 1 AND 15000 AND
    minimum_exit_micros BETWEEN 1 AND 999999 AND
    revision >= 1
  )
);

COMMIT;
