-- Add auditable Kalshi receipt linkage for owner-scoped pilot transfer recovery.
-- No transfers, trading, strategy, or credential modifications.
BEGIN;
ALTER TABLE private.kalshi_owner_pilot_transfers
  ADD COLUMN IF NOT EXISTS verified_exchange_transfer_id text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_owner_pilot_verified_exchange_receipt_uq
  ON private.kalshi_owner_pilot_transfers (verified_exchange_transfer_id)
  WHERE verified_exchange_transfer_id IS NOT NULL;
COMMIT;
