-- Opt-in durable standing FEE model/delegation. No existing fee approval is
-- converted; legacy V1 records keep their 30-day maximum. Every actual
-- ORDER_ENTRY still requires a fresh provider observation and the 15m lease.
BEGIN;
ALTER TABLE private.strata_api_fee_standing_models
 ADD COLUMN IF NOT EXISTS standing_until_revoked boolean NOT NULL DEFAULT false;
ALTER TABLE private.strata_api_fee_standing_delegations
 ADD COLUMN IF NOT EXISTS standing_until_revoked boolean NOT NULL DEFAULT false;

ALTER TABLE private.strata_api_fee_standing_models DROP CONSTRAINT IF EXISTS standing_model_bounded;
ALTER TABLE private.strata_api_fee_standing_models ADD CONSTRAINT standing_model_bounded CHECK (
 (standing_until_revoked=false AND valid_until>signed_at
     AND valid_until<=signed_at+interval '30 days') OR
 (standing_until_revoked=true AND valid_until='infinity'::timestamptz)
);

ALTER TABLE private.strata_api_fee_standing_delegations
 DROP CONSTRAINT IF EXISTS owner_fee_delegation_bounded;
ALTER TABLE private.strata_api_fee_standing_delegations
 DROP CONSTRAINT IF EXISTS strata_api_fee_standing_delegations_confirmation_check;
ALTER TABLE private.strata_api_fee_standing_delegations
 ADD CONSTRAINT strata_api_fee_standing_delegations_confirmation_check CHECK (
 confirmation IN (
 'I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1',
 'I_AUTHORIZE_MY_ACCOUNT_FOR_CURRENT_REVIEWED_KXBTC15M_FEE_MODEL_UNTIL_REVOKED_V2')
);
ALTER TABLE private.strata_api_fee_standing_delegations ADD CONSTRAINT owner_fee_delegation_bounded CHECK (
 lease_expires_at<=valid_until AND (
 (standing_until_revoked=false AND valid_until>granted_at
     AND valid_until<=granted_at+interval '30 days'
     AND confirmation='I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1') OR
 (standing_until_revoked=true AND valid_until='infinity'::timestamptz
     AND confirmation='I_AUTHORIZE_MY_ACCOUNT_FOR_CURRENT_REVIEWED_KXBTC15M_FEE_MODEL_UNTIL_REVOKED_V2')
 ));
COMMENT ON COLUMN private.strata_api_fee_standing_delegations.standing_until_revoked
IS 'A separate AAL2 owner opt-in to reviewed exact-SHA fee model, revocable; only 15min provider-verified observation leases renew at each order.';
COMMIT;
