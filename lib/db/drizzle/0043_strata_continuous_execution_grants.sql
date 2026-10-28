-- Candidate only. Install during a controlled deployment, never while a live
-- SHA-bound worker owns the production lease.
-- Independent human review + authenticated owner grant remain separate events.
BEGIN;
-- A distinct explicit review; no old finite release is converted or extended.
CREATE TABLE private.strata_standing_execution_reviews (
 release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[0-9a-f]{40}$'),
 policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
 independent_reviewer_id uuid NOT NULL REFERENCES auth.users(id),
 qualification_id uuid NOT NULL,
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
 review_url text NOT NULL,
 review_note text NOT NULL CHECK (length(review_note) BETWEEN 120 AND 2500),
 confirmation text NOT NULL CHECK (confirmation = 'I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1'),
 state text NOT NULL DEFAULT 'approved' CHECK (state='approved'),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revocation_reason text,
 CHECK (independent_reviewer_id <> owner_user_id),
 CHECK ((revoked_at IS NULL AND revocation_reason IS NULL) OR
   (revoked_at IS NOT NULL AND revoked_at >= created_at AND revocation_reason IS NOT NULL AND length(trim(revocation_reason)) > 0))
);
CREATE UNIQUE INDEX strata_standing_review_current ON private.strata_standing_execution_reviews
 (owner_user_id,execution_account_id,release_commit_sha,policy_hash) WHERE revoked_at IS NULL;
ALTER TABLE private.strata_standing_execution_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_standing_execution_reviews FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS private.strata_continuous_execution_grants (
 grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[0-9a-f]{40}$'),
 policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
 reviewed_release_id uuid NOT NULL REFERENCES private.strata_standing_execution_reviews(release_id),
 independent_reviewer_id uuid NOT NULL REFERENCES auth.users(id),
 owner_confirmation text NOT NULL CHECK (
  owner_confirmation = 'I_AUTHORIZE_REVOCABLE_CONTINUOUS_EXECUTION_FOR_MY_REVIEWED_EXACT_SHA_V1'),
 consented_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revocation_reason text,
 CHECK (independent_reviewer_id <> owner_user_id),
 CHECK ((revoked_at IS NULL AND revocation_reason IS NULL) OR
   (revoked_at IS NOT NULL AND revoked_at >= consented_at AND
    revocation_reason IS NOT NULL AND length(trim(revocation_reason)) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_continuous_grants_unrevoked_unique
 ON private.strata_continuous_execution_grants(owner_user_id,execution_account_id,release_commit_sha)
 WHERE revoked_at IS NULL;
-- Scope is append-only; the only legal mutation is one-way revocation.
CREATE OR REPLACE FUNCTION private.strata_continuous_grant_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'standing_grant_delete_forbidden'; END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
   (to_jsonb(NEW)-'revoked_at'-'revocation_reason') IS DISTINCT FROM
   (to_jsonb(OLD)-'revoked_at'-'revocation_reason') THEN
   RAISE EXCEPTION 'standing_grant_scope_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_continuous_grant_guard
 BEFORE UPDATE OR DELETE ON private.strata_continuous_execution_grants
 FOR EACH ROW EXECUTE FUNCTION private.strata_continuous_grant_guard();
CREATE TRIGGER strata_standing_review_guard
 BEFORE UPDATE OR DELETE ON private.strata_standing_execution_reviews
 FOR EACH ROW EXECUTE FUNCTION private.strata_continuous_grant_guard();
REVOKE ALL ON FUNCTION private.strata_continuous_grant_guard()
 FROM PUBLIC,anon,authenticated,service_role;
-- Worker-managed rolling technical evidence. NOT a second human signature.
CREATE TABLE IF NOT EXISTS private.strata_continuous_execution_technical_lease (
 grant_id uuid PRIMARY KEY REFERENCES private.strata_continuous_execution_grants(grant_id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 observed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
 fencing_token bigint NOT NULL CHECK (fencing_token > 0),
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
