-- New owner-controlled variable top-ups. No data changes, transfers or permissions.
-- Apply this migration before deploying the matching backend. No browser grants.
BEGIN;
CREATE TABLE IF NOT EXISTS private.kalshi_owner_topups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 authority_credential_id uuid NOT NULL,
 authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[0-9a-f]{64}$'),
 amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 100 AND 2500000),
 source_exchange_index smallint NOT NULL CHECK (source_exchange_index IN (0,2)),
 prior_blocked_reason text,
 state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 cancelled_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topup_completion_consistency CHECK
  ((state='active' AND completed_at IS NULL AND cancelled_at IS NULL) OR
   (state='completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL) OR
   (state='cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_owner_one_active_topup_per_account
 ON private.kalshi_owner_topups(execution_account_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS kalshi_owner_topups_by_owner
 ON private.kalshi_owner_topups(owner_user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS private.kalshi_owner_topup_legs (
 id uuid PRIMARY KEY, -- immutable provider client_transfer_id
 topup_id uuid NOT NULL REFERENCES private.kalshi_owner_topups(id),
 leg smallint NOT NULL CHECK (leg IN (1,2)),
 kind text NOT NULL CHECK(kind IN ('shard','bot')),
 state text NOT NULL DEFAULT 'prepared'
   CHECK(state IN ('prepared','claimed','uncertain','completed')),
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 100 AND 2500000),
 -- Exact signed balances are fixed microdollars and preserve fractional cents.
 shard_zero_before_micros bigint NOT NULL CHECK(shard_zero_before_micros>=0),
 primary_two_before_micros bigint NOT NULL CHECK(primary_two_before_micros>=0),
 bot_two_before_micros bigint NOT NULL CHECK(bot_two_before_micros>=0),
 exchange_transfer_id text,
 attempted_at timestamptz,
 verified_at timestamptz,
 shard_zero_after_micros bigint,
 primary_two_after_micros bigint,
 bot_two_after_micros bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT kalshi_owner_topup_leg_order UNIQUE(topup_id,leg),
 CONSTRAINT kalshi_owner_topup_leg_times CHECK
  ((state='prepared' AND attempted_at IS NULL AND verified_at IS NULL) OR
   (state IN ('claimed','uncertain') AND attempted_at IS NOT NULL AND verified_at IS NULL) OR
   (state='completed' AND attempted_at IS NOT NULL AND verified_at IS NOT NULL)),
 CONSTRAINT kalshi_owner_topup_leg_index CHECK
  ((kind='shard' AND leg=1) OR (kind='bot' AND leg IN (1,2)))
);
CREATE INDEX IF NOT EXISTS kalshi_owner_topup_leg_history
 ON private.kalshi_owner_topup_legs(topup_id,leg);
-- Defensive security parity with existing private financial ledgers:
-- no direct browser/user-role access, even if private schema exposure changes.
ALTER TABLE private.kalshi_owner_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.kalshi_owner_topup_legs ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE private.kalshi_owner_topups FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE private.kalshi_owner_topup_legs FROM PUBLIC, anon, authenticated;
-- Private-schema backend-only access. No browser grants or SELECT policies.
COMMIT;
