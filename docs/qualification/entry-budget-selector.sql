-- REVIEW CANDIDATE / disposable staging only. No application startup or grants.
CREATE TABLE private.strata_entry_budget_choices (
  owner_user_id text NOT NULL CHECK(owner_user_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  account_id text NOT NULL CHECK(account_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  credential_fingerprint text NOT NULL CHECK(credential_fingerprint ~ '^[a-f0-9]{64}$'),
  release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
  policy_hash text NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
  policy_revision integer NOT NULL CHECK(policy_revision > 0),
  stake_revision integer NOT NULL CHECK(stake_revision > 0),
  fee_approval_id text NOT NULL CHECK(fee_approval_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  fee_approval_digest text NOT NULL CHECK(fee_approval_digest ~ '^[a-f0-9]{64}$'),
  choice_id text NOT NULL CHECK(choice_id = ('gross-' || gross_cents::text)),
  choice_revision integer NOT NULL CHECK(choice_revision > 0),
  gross_cents integer NOT NULL CHECK(gross_cents IN (500,1500,2500,5000,10000,15000,20000,25000,50000)),
  all_in_cents integer NOT NULL CHECK(all_in_cents BETWEEN gross_cents AND 2000000000),
  approval_digest text NOT NULL CHECK(approval_digest ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at > approved_at),
  revoked_at timestamptz CHECK(revoked_at >= approved_at),
  PRIMARY KEY(account_id, choice_id, choice_revision)
);
ALTER TABLE private.strata_entry_budget_choices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_entry_budget_choices FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.fence_entry_budget_choice_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,private AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'entry budget history is immutable';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'entry budget authority changes require READ COMMITTED';
  END IF;
  IF TG_OP = 'UPDATE' AND (
      OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_at > clock_timestamp() OR
      (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')) THEN
    RAISE EXCEPTION 'entry budget terms are immutable; revocation only';
  END IF;
  PERFORM 1 FROM public.v13_production_account a
    WHERE a.id=NEW.account_id AND a.owner_user_id::text=NEW.owner_user_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry budget owner or account mismatch'; END IF;
  IF TG_OP = 'INSERT' AND (
      NEW.revoked_at IS NOT NULL OR NEW.approved_at > clock_timestamp() OR
      EXISTS(SELECT 1 FROM private.strata_entry_budget_choices t WHERE
        t.account_id=NEW.account_id AND t.choice_id=NEW.choice_id AND t.choice_revision>=NEW.choice_revision)) THEN
    RAISE EXCEPTION 'entry budget revision must increase and require approved active terms';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION private.fence_entry_budget_choice_changes() FROM PUBLIC;
CREATE TRIGGER strata_entry_budget_choice_row_fence BEFORE INSERT OR UPDATE OR DELETE ON private.strata_entry_budget_choices
FOR EACH ROW EXECUTE FUNCTION private.fence_entry_budget_choice_changes();
CREATE TRIGGER strata_entry_budget_choice_truncate_fence BEFORE TRUNCATE ON private.strata_entry_budget_choices
FOR EACH STATEMENT EXECUTE FUNCTION private.fence_entry_budget_choice_changes();

-- Deliberately no SELECT policies or grants in this review artifact. A caller needs reviewed
-- server-only access. No user, API role, or test may create live approvals through this candidate.
