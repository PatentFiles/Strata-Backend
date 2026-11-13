-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Allows V13_PRODUCTION to become the master execution mode.
-- PAPER_ONLY and SHADOW_LIVE remain permanently execution-disabled.
-- This migration never enables live execution and never inserts an account or policy.
BEGIN;

ALTER TABLE live_execution_config
  DROP CONSTRAINT IF EXISTS live_execution_config_execution_disabled_check;

ALTER TABLE live_execution_config
  DROP CONSTRAINT IF EXISTS live_execution_config_mode_check;

ALTER TABLE live_execution_config
  ADD CONSTRAINT live_execution_config_mode_check
  CHECK (mode IN ('PAPER_ONLY', 'SHADOW_LIVE', 'V13_PRODUCTION'));

ALTER TABLE live_execution_config
  ADD CONSTRAINT live_execution_config_mode_execution_check
  CHECK (
    (mode IN ('PAPER_ONLY', 'SHADOW_LIVE') AND live_execution_enabled = false)
    OR mode = 'V13_PRODUCTION'
  );

ALTER TABLE live_execution_config
  ADD CONSTRAINT live_execution_config_execution_requires_kill_off_check
  CHECK (live_execution_enabled = false OR manual_kill_switch = false);

INSERT INTO live_execution_config (id, mode, live_execution_enabled, manual_kill_switch)
SELECT 'singleton', 'V13_PRODUCTION', false, true
WHERE NOT EXISTS (
  SELECT 1 FROM live_execution_config WHERE id = 'singleton'
);

COMMIT;
