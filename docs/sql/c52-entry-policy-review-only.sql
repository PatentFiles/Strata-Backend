-- REVIEW ONLY. Never run at application startup or against a connected database
-- without separate authorization. NULL means historical/unversioned; no backfill.
BEGIN;
ALTER TABLE forward_test_windows ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE forward_test_evaluations ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE forward_test_positions ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE v13_strategy_shadow_evaluation ADD COLUMN IF NOT EXISTS entry_policy_version text;
ALTER TABLE v13_live_money_policy ADD COLUMN IF NOT EXISTS entry_policy_version text;

-- Drizzle push may leave an existing same-named CHECK unchanged. Replace explicitly
-- in a separately reviewed rollout; historical rows keep the original labels.
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
COMMIT;
