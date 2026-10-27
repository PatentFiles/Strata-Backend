-- Owner-scoped recovery of a deleted or incorrectly scoped Kalshi restricted
-- trading key. REVIEW AND APPLY SEPARATELY. No financial orders or transfers.
-- All operations are immutable after the first exchange POST; failures require
-- independent exchange reconciliation, never an automatic second POST.
BEGIN;
CREATE TABLE IF NOT EXISTS private.kalshi_restricted_key_recovery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  financial_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  execution_account_id text NOT NULL,
  previous_fingerprint text NOT NULL CHECK (previous_fingerprint ~ '^[0-9a-f]{64}$'),
  setup_credential_id uuid NOT NULL,
  setup_fingerprint text NOT NULL CHECK (setup_fingerprint ~ '^[0-9a-f]{64}$'),
  verification_credential_id uuid NOT NULL,
  verification_fingerprint text NOT NULL CHECK (verification_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','attempted','response_received','uncertain','completed')),
  response_digest text CHECK (response_digest IS NULL OR response_digest ~ '^[0-9a-f]{64}$'),
  target_fingerprint text CHECK (target_fingerprint IS NULL OR target_fingerprint ~ '^[0-9a-f]{64}$'),
  target_credential_id uuid,
  reason text CHECK (reason IS NULL OR length(reason) < 180),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  response_received_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT kalshi_recovery_owner_fk FOREIGN KEY (financial_account_id,owner_user_id)
    REFERENCES public.financial_accounts(id,user_id),
  CONSTRAINT kalshi_recovery_connection_fk FOREIGN KEY (provider_connection_id,financial_account_id)
    REFERENCES private.provider_connections(id,financial_account_id),
  CONSTRAINT kalshi_recovery_setup_fk FOREIGN KEY (setup_credential_id,owner_user_id,provider_connection_id)
    REFERENCES private.kalshi_connection_credentials(id,owner_user_id,provider_connection_id),
  CONSTRAINT kalshi_recovery_verify_fk FOREIGN KEY (verification_credential_id,owner_user_id,provider_connection_id)
    REFERENCES private.kalshi_connection_credentials(id,owner_user_id,provider_connection_id),
  CONSTRAINT kalshi_recovery_target_fk FOREIGN KEY (target_credential_id,owner_user_id,provider_connection_id)
    REFERENCES private.kalshi_connection_credentials(id,owner_user_id,provider_connection_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS kalshi_recovery_one_unresolved_per_owner
  ON private.kalshi_restricted_key_recovery(owner_user_id)
  WHERE state IN ('prepared','attempted','response_received','uncertain');
CREATE INDEX IF NOT EXISTS kalshi_recovery_owner_history
  ON private.kalshi_restricted_key_recovery(owner_user_id, prepared_at DESC);
ALTER TABLE private.kalshi_restricted_key_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.kalshi_restricted_key_recovery FROM PUBLIC,anon,authenticated;
-- Only the trusted backend service accesses this table, with authenticated owner
-- scoping enforced at the route and inside every query.
COMMIT;
-- Rollback for an *unused* migration only:
-- DROP TABLE private.kalshi_restricted_key_recovery;
