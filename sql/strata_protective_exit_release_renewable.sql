-- Permit reviewed re-authorization on the SAME deployed binary after expiry.
-- Old release rows remain fully immutable and preserved for financial audit.
BEGIN;
ALTER TABLE private.strata_protective_exit_release
 DROP CONSTRAINT IF EXISTS strata_protective_exit_release_release_commit_sha_key;
CREATE INDEX IF NOT EXISTS strata_protective_exit_release_sha_expiry
 ON private.strata_protective_exit_release(release_commit_sha,expires_at DESC);
-- A renewal must not overlap another active approved release, even if two
-- operators concurrently submit against different API server instances.
CREATE OR REPLACE FUNCTION private.strata_protective_release_no_overlap()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.release_commit_sha)::bigint);
 IF EXISTS(
   SELECT 1 FROM private.strata_protective_exit_release v
   WHERE v.release_commit_sha=NEW.release_commit_sha
     AND v.revoked_at IS NULL
     AND v.expires_at>NEW.created_at
 ) THEN
   RAISE EXCEPTION 'a valid reviewed release already exists for this deployed commit'
     USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS strata_protective_release_no_overlap
 ON private.strata_protective_exit_release;
CREATE TRIGGER strata_protective_release_no_overlap
 BEFORE INSERT ON private.strata_protective_exit_release
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_release_no_overlap();
REVOKE ALL ON FUNCTION private.strata_protective_release_no_overlap() FROM PUBLIC,anon,authenticated;
COMMIT;
