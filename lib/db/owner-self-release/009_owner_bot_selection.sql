-- Independent owner bot choice. No mutation of the C52/C53 approved parameter set.
-- Applied only after native tests; private schema has no client grants.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='12000ms';
CREATE TABLE IF NOT EXISTS private.strata_owner_bot_selection (
 execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 bot_id text NOT NULL CHECK (bot_id IN ('v13-champion-2-c52-confirm53','warren-buffett-delayed-cross-v1')),
 bot_fingerprint text NOT NULL CHECK (bot_fingerprint ~ '^[a-f0-9]{64}$'),
 policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
 release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 request_id uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (owner_user_id,request_id),
 UNIQUE (owner_user_id,execution_account_id)
);
CREATE TABLE IF NOT EXISTS private.strata_owner_bot_selection_history (
 id uuid PRIMARY KEY,
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 revision bigint NOT NULL CHECK (revision>0),
 from_bot_id text NOT NULL,
 to_bot_id text NOT NULL,
 bot_fingerprint text NOT NULL CHECK (bot_fingerprint ~ '^[a-f0-9]{64}$'),
 policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
 release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (execution_account_id,revision),
 UNIQUE (owner_user_id,id)
);
ALTER TABLE private.strata_owner_bot_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_owner_bot_selection_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_bot_selection FROM PUBLIC,anon,authenticated;
REVOKE ALL ON private.strata_owner_bot_selection_history FROM PUBLIC,anon,authenticated;
COMMIT;
