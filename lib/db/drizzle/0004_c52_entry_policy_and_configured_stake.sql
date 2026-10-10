-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization. NULL means
-- historical/unversioned. No backfill and no policy rehash.
BEGIN;
ALTER TABLE forward_test_windows ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE forward_test_evaluations ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE forward_test_positions ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE v13_strategy_shadow_evaluation ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE v13_live_money_policy ADD COLUMN IF NOT EXISTS entry_policy_version text;

ALTER TABLE v13_strategy_shadow_evaluation
  DROP CONSTRAINT IF EXISTS v13_strategy_shadow_eval_entry_check;
ALTER TABLE v13_strategy_shadow_evaluation
  ADD CONSTRAINT v13_strategy_shadow_eval_entry_check CHECK (
    would_enter = false OR (
      (first_cross = true OR (
        COALESCE(entry_policy_version = 'v13-first-qualifying-cross-v2', false) AND
        previous_buffer IS NOT NULL AND
        ((previous_buffer <= 0 AND signed_buffer > 0) OR
         (previous_buffer >= 0 AND signed_buffer < 0))
      )) AND qualifying_trigger = true AND signal IN ('SCOUT','CONFIRM') AND
      direction IN ('UP','DOWN') AND entry_offer IS NOT NULL
    )
  );

CREATE TABLE IF NOT EXISTS strata_configured_stake (
  id text PRIMARY KEY,
  configured_stake_cents integer NOT NULL,
  revision integer NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT strata_configured_stake_singleton CHECK (id = 'production'),
  CONSTRAINT strata_configured_stake_cents CHECK (configured_stake_cents >= 1),
  CONSTRAINT strata_configured_stake_revision CHECK (revision >= 1)
);
COMMIT;
