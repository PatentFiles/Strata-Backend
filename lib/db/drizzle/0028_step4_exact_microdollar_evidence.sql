-- Preserve precise Kalshi balances for the $25 primary Exchange 0 -> Exchange 2 pilot.
-- Historic attempted/uncertain records remain immutable. A prior prepared row
-- without precise source evidence must be replaced by a new read-only preflight.
-- This migration does not transfer funds, authorize funding, or modify balances.
ALTER TABLE private.kalshi_owner_shard_allocations
  ADD COLUMN IF NOT EXISTS source_before_microdollars bigint,
  ADD COLUMN IF NOT EXISTS source_after_microdollars bigint,
  ADD COLUMN IF NOT EXISTS destination_after_microdollars bigint,
  ADD COLUMN IF NOT EXISTS bot_after_microdollars bigint;

COMMENT ON COLUMN private.kalshi_owner_shard_allocations.source_before_microdollars IS
  'Exact signed USD amount in millionths of a dollar before transfer. Never round up into transferable cents.';
COMMENT ON COLUMN private.kalshi_owner_shard_allocations.source_after_microdollars IS
  'Full precision source cash after separately verified Kalshi transfer receipt.';
