-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Keeps an already-created qualification order visible after Advanced
-- verification when its cancellation was not proven and the user accepted
-- the residual one-cent order. Does not place an order, move money, or
-- change bot eligibility.
BEGIN;

ALTER TABLE private.kalshi_api_qualification_guard
  ADD COLUMN IF NOT EXISTS residual_risk_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS advanced_verified_at timestamptz;

ALTER TABLE private.kalshi_api_qualification_guard
  DROP CONSTRAINT IF EXISTS kalshi_api_qualification_guard_state_check;

ALTER TABLE private.kalshi_api_qualification_guard
  ADD CONSTRAINT kalshi_api_qualification_guard_state_check
  CHECK (state IN (
    'inflight', 'order_uncertain', 'unexpected_fill', 'cancel_uncertain',
    'upgrade_uncertain', 'upgrade_rejected', 'canceled',
    'advanced_verified_with_cancel_uncertain'
  ));

COMMIT;
