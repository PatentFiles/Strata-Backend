-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Raises only the absolute max_entry_stake_cents check from 500000 to 2500000.
-- Does not insert, update, approve, or backfill any policy row.
BEGIN;
ALTER TABLE v13_live_money_policy
  DROP CONSTRAINT IF EXISTS v13_live_money_policy_limits_check;
ALTER TABLE v13_live_money_policy
  ADD CONSTRAINT v13_live_money_policy_limits_check CHECK (
    capital_limit_cents >= 0 AND capital_limit_cents <= 2000000000 AND
    max_entry_stake_cents >= 0 AND max_entry_stake_cents <= 2500000 AND
    max_entry_all_in_cents >= 0 AND max_entry_all_in_cents <= 2000000000 AND
    max_open_positions >= 0 AND max_open_positions <= 1 AND
    max_daily_loss_cents >= 0 AND max_daily_loss_cents <= 2000000000 AND
    max_total_loss_cents >= 0 AND max_total_loss_cents <= 2000000000 AND
    max_quote_age_ms >= 0 AND max_quote_age_ms <= 15000 AND
    max_fee_evidence_age_ms >= 0 AND max_fee_evidence_age_ms <= 15000
  );
COMMIT;
