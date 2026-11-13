-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without separate staged authorization.
-- Adds one optional, independently Vault-bound credential role for explicitly
-- authorized account-setup mutations. Existing Provisioning, Verification,
-- and Restricted Execution bindings are not changed, revoked, or copied.
-- This migration does not call Kalshi, create a subaccount, enable trading,
-- change a kill switch, transfer funds, or place an order.
--
-- Rollback is safe only while no account_setup_execution row exists:
--   ALTER TABLE private.kalshi_connection_credentials
--     DROP CONSTRAINT IF EXISTS kalshi_connection_credentials_role_check;
--   ALTER TABLE private.kalshi_connection_credentials
--     ADD CONSTRAINT kalshi_connection_credentials_role_check CHECK (
--       role IN ('provisioning', 'verification', 'restricted_execution')
--     );
BEGIN;

ALTER TABLE private.kalshi_connection_credentials
  DROP CONSTRAINT IF EXISTS kalshi_connection_credentials_role_check;

ALTER TABLE private.kalshi_connection_credentials
  ADD CONSTRAINT kalshi_connection_credentials_role_check CHECK (
    role IN (
      'provisioning',
      'verification',
      'account_setup_execution',
      'restricted_execution'
    )
  );

COMMIT;
