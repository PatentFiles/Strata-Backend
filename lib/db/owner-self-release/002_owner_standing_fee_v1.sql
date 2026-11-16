-- Versioned owner-only, SHA-bound monetary authority. This extends an
-- explicitly authenticated owner's short V3 fee consent WITHOUT changing its
-- 15-minute grant or two-hour issuer evidence records. Old V2 reviewer records
-- and protective release approvals are retained exactly as issued.
-- Apply in a stopped, qualified deployment. Recheck migration history before
-- retrying an ambiguous transaction.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='10000ms';
-- The original source identity is immutable and now has a composite FK for the
-- owner, account, deployment and real official issuer bytes.
ALTER TABLE private.strata_owner_fee_authority_v3
 ADD CONSTRAINT owner_v3_standing_source_identity UNIQUE
 (authority_id,owner_user_id,execution_account_id,release_commit_sha,official_source_digest);

CREATE TABLE private.strata_owner_standing_fee_v1 (
 consent_id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[a-f0-9]{40}$'),
 approved_policy_hash text NOT NULL CHECK (approved_policy_hash ~ '^[a-f0-9]{64}$'),
 source_authority_id uuid NOT NULL,
 official_source_digest text NOT NULL CHECK (official_source_digest ~ '^[a-f0-9]{64}$'),
 fee_policy_version text NOT NULL CHECK (fee_policy_version='strata_owner_official_monetary_fee_v3'),
 formula_version text NOT NULL CHECK (formula_version='standard-quadratic-0.07-v1'),
 scope text NOT NULL CHECK (scope='KXBTC15M:INDEX2:SUBACCOUNT1'),
 confirmation text NOT NULL CHECK (confirmation='I_AUTHORIZE_MY_OWN_STANDING_OFFICIAL_KALSHI_FEE_MODEL_V1'),
 consent_digest text NOT NULL CHECK (consent_digest ~ '^[a-f0-9]{64}$'),
 consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revocation_reason text,
 CONSTRAINT owner_standing_fee_source_identity_fk
 FOREIGN KEY (source_authority_id,owner_user_id,execution_account_id,
  release_commit_sha,official_source_digest)
 REFERENCES private.strata_owner_fee_authority_v3
 (authority_id,owner_user_id,execution_account_id,release_commit_sha,official_source_digest),
 CONSTRAINT owner_standing_fee_ttl
 CHECK(expires_at>consented_at AND expires_at<=consented_at+interval '24 hours'),
 CONSTRAINT owner_standing_fee_revoke_clock
 CHECK(revoked_at IS NULL OR (revoked_at>=consented_at AND revoked_at<=clock_timestamp()+interval '2 seconds')),
 CONSTRAINT owner_standing_fee_revocation_fields
 CHECK((revoked_at IS NULL AND revocation_reason IS NULL) OR
       (revoked_at IS NOT NULL AND length(revocation_reason) BETWEEN 8 AND 160))
);
-- Only one currently unrevoked standing consent is admitted per exact owner's
-- versioned policy. Expired rows are explicitly superseded in the same
-- transaction as the next owner AAL2 consent; no automatic extension.
CREATE UNIQUE INDEX owner_standing_fee_one_unrevoked_scope
 ON private.strata_owner_standing_fee_v1
 (owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash)
 WHERE revoked_at IS NULL;
CREATE INDEX owner_standing_fee_expiry_lookup ON private.strata_owner_standing_fee_v1
 (owner_user_id,execution_account_id,expires_at DESC);
ALTER TABLE private.strata_owner_standing_fee_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_owner_standing_fee_v1 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_standing_fee_v1 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON private.strata_owner_standing_fee_v1 TO service_role;

CREATE FUNCTION private.owner_standing_fee_immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'owner_standing_fee_delete_forbidden';
 END IF;
 -- The only permitted mutation is ONE-WAY revocation. This permits expiry
 -- supersession without rewriting the originally approved model or expiry.
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
    NEW.revoked_at<OLD.consented_at OR
    ROW(NEW.consent_id,NEW.owner_user_id,NEW.execution_account_id,
        NEW.release_commit_sha,NEW.approved_policy_hash,NEW.source_authority_id,
        NEW.official_source_digest,NEW.fee_policy_version,NEW.formula_version,
        NEW.scope,NEW.confirmation,NEW.consent_digest,NEW.consented_at,NEW.expires_at)
    IS DISTINCT FROM
    ROW(OLD.consent_id,OLD.owner_user_id,OLD.execution_account_id,
        OLD.release_commit_sha,OLD.approved_policy_hash,OLD.source_authority_id,
        OLD.official_source_digest,OLD.fee_policy_version,OLD.formula_version,
        OLD.scope,OLD.confirmation,OLD.consent_digest,OLD.consented_at,OLD.expires_at)
 THEN
  RAISE EXCEPTION 'owner_standing_fee_immutable_scope';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_standing_fee_update_immutable_v1
 BEFORE UPDATE OR DELETE ON private.strata_owner_standing_fee_v1
 FOR EACH ROW EXECUTE FUNCTION private.owner_standing_fee_immutable_v1();

-- No retroactive grants, account activation, fee records or historical
-- reviewer identities are created by this schema change.
COMMIT;
