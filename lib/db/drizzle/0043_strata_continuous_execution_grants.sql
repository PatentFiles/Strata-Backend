-- Candidate only. Install during a controlled deployment, never while a live
-- SHA-bound worker owns the production lease.
-- Independent human review + authenticated owner grant remain separate events.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_continuous_execution_grants (
 grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[0-9a-f]{40}$'),
 policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
 reviewed_release_id uuid NOT NULL REFERENCES private.strata_protective_exit_release(release_id),
 independent_reviewer_id uuid NOT NULL REFERENCES auth.users(id),
 owner_confirmation text NOT NULL CHECK (
  owner_confirmation = 'I_AUTHORIZE_REVOCABLE_CONTINUOUS_EXECUTION_FOR_MY_REVIEWED_EXACT_SHA_V1'),
 consented_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revocation_reason text,
 CHECK (revoked_at IS NULL OR revoked_at >= consented_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_continuous_grants_unrevoked_unique
 ON private.strata_continuous_execution_grants(owner_user_id,execution_account_id,release_commit_sha)
 WHERE revoked_at IS NULL;
-- Worker-managed rolling technical evidence. NOT a second human signature.
CREATE TABLE IF NOT EXISTS private.strata_continuous_execution_technical_lease (
 grant_id uuid PRIMARY KEY REFERENCES private.strata_continuous_execution_grants(grant_id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 observed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
 generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
 CHECK (expires_at > observed_at AND expires_at <= observed_at + interval '5 minutes')
);
-- Durable immutable grant, renewal, revocation, and decision evidence.
CREATE TABLE IF NOT EXISTS private.strata_continuous_execution_audit (
 audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 grant_id uuid REFERENCES private.strata_continuous_execution_grants(grant_id),
 execution_account_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN
  ('GRANT_AUTHORIZED','GRANT_REVOKED','LEASE_RENEWED','LEASE_REJECTED','ENTRY_DENIED')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 evidence_digest text CHECK(evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
 reason text NOT NULL
);
CREATE INDEX IF NOT EXISTS strata_continuous_execution_audit_account_idx
 ON private.strata_continuous_execution_audit(execution_account_id,recorded_at DESC);
ALTER TABLE private.strata_continuous_execution_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_continuous_execution_technical_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_continuous_execution_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_continuous_execution_grants FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON private.strata_continuous_execution_technical_lease FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON private.strata_continuous_execution_audit FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE private.strata_continuous_execution_audit_audit_id_seq FROM PUBLIC,anon,authenticated,service_role;
-- Review claims and audit history may never be silently rewritten.
CREATE TRIGGER strata_continuous_execution_audit_immutable
 BEFORE UPDATE OR DELETE ON private.strata_continuous_execution_audit
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_approval_audit_immutable();
COMMIT;
