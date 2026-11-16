-- LOCAL REVIEW CANDIDATE ONLY. Not in automatic migration manifests.
-- Preserve historical independent releases. No approvals or controls written.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='5000ms';
ALTER TABLE private.strata_protective_exit_release
 ADD COLUMN release_authority text NOT NULL DEFAULT 'INDEPENDENT_V1',
 ADD COLUMN owner_authorizer_id uuid REFERENCES auth.users(id),
 ADD COLUMN execution_account_id text REFERENCES public.v13_production_account(id),
 ADD COLUMN policy_hash text,
 ADD COLUMN standing_review_id uuid REFERENCES private.strata_standing_execution_reviews(release_id),
 ADD COLUMN qualification_id uuid REFERENCES private.strata_protective_release_qualification(qualification_id);
ALTER TABLE private.strata_protective_exit_release
 ALTER COLUMN independent_reviewer_id DROP NOT NULL,
 DROP CONSTRAINT protective_exit_segregation_of_duties,
 DROP CONSTRAINT strata_protective_exit_release_review_url_check,
 ADD CONSTRAINT protective_exit_explicit_authority CHECK(
  (release_authority='INDEPENDENT_V1' AND independent_reviewer_id IS NOT NULL
   AND independent_reviewer_id<>operator_approver_id AND owner_authorizer_id IS NULL
   AND execution_account_id IS NULL AND policy_hash IS NULL AND standing_review_id IS NULL AND qualification_id IS NULL)
  OR (release_authority='OWNER_SELF_V1' AND independent_reviewer_id IS NULL
   AND owner_authorizer_id IS NOT NULL AND owner_authorizer_id=operator_approver_id
   AND execution_account_id IS NOT NULL AND policy_hash IS NOT NULL AND policy_hash ~ '^[0-9a-f]{64}$'
   AND standing_review_id IS NOT NULL AND qualification_id IS NOT NULL));
ALTER TABLE private.strata_protective_exit_release ADD CONSTRAINT protective_exit_explicit_review_url CHECK(
 (release_authority='INDEPENDENT_V1' AND review_url ~ '^https://github.com/PatentFiles/Strata-Backend/pull/[0-9]+$')
 OR (release_authority='OWNER_SELF_V1' AND review_url='https://github.com/PatentFiles/Strata-Backend/commit/'||release_commit_sha));
CREATE OR REPLACE FUNCTION private.strata_protective_release_no_overlap()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.release_authority||':'||NEW.release_commit_sha||':'||
  CASE WHEN NEW.release_authority='OWNER_SELF_V1' THEN NEW.owner_authorizer_id::text||':'||NEW.execution_account_id ELSE '' END,0));
 IF EXISTS(SELECT 1 FROM private.strata_protective_exit_release v
 WHERE v.release_commit_sha=NEW.release_commit_sha AND v.release_authority=NEW.release_authority
 AND (NEW.release_authority='INDEPENDENT_V1' OR (v.owner_authorizer_id=NEW.owner_authorizer_id AND v.execution_account_id=NEW.execution_account_id))
 AND v.revoked_at IS NULL AND v.expires_at>NEW.created_at)
 THEN RAISE EXCEPTION 'overlapping explicit protective release authority' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
CREATE INDEX strata_owner_final_release_scope ON private.strata_protective_exit_release
 (release_commit_sha,owner_authorizer_id,execution_account_id) WHERE release_authority='OWNER_SELF_V1';
CREATE FUNCTION private.strata_owner_final_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.release_authority,NEW.owner_authorizer_id,NEW.execution_account_id,NEW.policy_hash,NEW.standing_review_id,NEW.qualification_id)
 IS DISTINCT FROM ROW(OLD.release_authority,OLD.owner_authorizer_id,OLD.execution_account_id,OLD.policy_hash,OLD.standing_review_id,OLD.qualification_id)
 THEN RAISE EXCEPTION 'owner final authority identity immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NEW.release_authority='OWNER_SELF_V1' AND NOT EXISTS(
 SELECT 1 FROM private.strata_standing_execution_reviews r
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=NEW.qualification_id
 JOIN public.v13_production_account a ON a.id=NEW.execution_account_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE r.release_id=NEW.standing_review_id AND r.qualification_id=NEW.qualification_id
 AND r.owner_user_id=NEW.owner_authorizer_id
 AND r.execution_account_id=NEW.execution_account_id AND r.release_commit_sha=NEW.release_commit_sha
 AND r.policy_hash=NEW.policy_hash AND r.state='approved' AND r.revoked_at IS NULL
 AND r.review_authority='OWNER_SELF_V1' AND r.owner_authorizer_id=NEW.owner_authorizer_id AND r.independent_reviewer_id IS NULL
 AND r.confirmation='I_AUTHORIZE_OWNER_ONLY_STANDING_EXECUTION_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1'
 AND q.owner_user_id=NEW.owner_authorizer_id AND q.execution_account_id=NEW.execution_account_id
 AND q.release_commit_sha=NEW.release_commit_sha AND q.observed_at<=now() AND q.expires_at>now()+interval '60 seconds'
 AND a.owner_user_id=NEW.owner_authorizer_id AND p.policy_hash=NEW.policy_hash AND p.state='APPROVED'
 FOR SHARE OF r,q,a,p)
 THEN RAISE EXCEPTION 'owner final authority evidence invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_owner_final_identity_guard BEFORE INSERT OR UPDATE ON private.strata_protective_exit_release
 FOR EACH ROW EXECUTE FUNCTION private.strata_owner_final_identity_guard();
REVOKE ALL ON FUNCTION private.strata_owner_final_identity_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
