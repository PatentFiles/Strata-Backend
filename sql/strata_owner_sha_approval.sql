-- Owner-scoped, durable, revocable exact-SHA code release.
-- Deployment order: reviewed SQL, backend version, then Wallets UI.
-- This migration does not approve any release, arm, start, or move money.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_owner_sha_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[0-9a-f]{40}$'),
  qualification_id uuid NOT NULL REFERENCES private.strata_protective_release_qualification(qualification_id),
  qualification_digest text NOT NULL CHECK (qualification_digest ~ '^[0-9a-f]{64}$'),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT strata_owner_sha_approvals_unique UNIQUE(owner_user_id,execution_account_id,release_commit_sha),
  CONSTRAINT strata_owner_sha_approvals_revocation CHECK(revoked_at IS NULL OR revoked_at>=confirmed_at)
);
CREATE INDEX IF NOT EXISTS strata_owner_sha_approval_active
 ON private.strata_owner_sha_approvals(execution_account_id,release_commit_sha)
 WHERE revoked_at IS NULL;
ALTER TABLE private.strata_owner_sha_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_sha_approvals FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE private.strata_owner_sha_approvals IS
 'Owner MFA-authorized exact-backend-SHA release after verified production read-only qualification; no live activation or orders on migration.';
COMMIT;
