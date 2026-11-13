\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222') ON CONFLICT DO NOTHING;
DO $$
DECLARE
 r uuid;
 sha text:=repeat('b',40);
BEGIN
 INSERT INTO private.strata_protective_exit_release(
  release_commit_sha,independent_reviewer_id,operator_approver_id,
  review_url,release_evidence_digest,state,expires_at)
 VALUES(sha,'22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',
  'https://github.com/PatentFiles/Strata-Backend/pull/107',repeat('d',64),'approved',
  now()+interval '2 hours') RETURNING release_id INTO r;
 BEGIN
  INSERT INTO private.strata_protective_exit_release(
   release_commit_sha,independent_reviewer_id,operator_approver_id,
   review_url,release_evidence_digest,state,expires_at)
  VALUES(sha,'22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',
   'https://github.com/PatentFiles/Strata-Backend/pull/107',repeat('e',64),'approved',
   now()+interval '2 hours');
  RAISE EXCEPTION 'overlapping release should not be permitted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 UPDATE private.strata_protective_exit_release SET revoked_at=now() WHERE release_id=r;
 INSERT INTO private.strata_protective_exit_release(
  release_commit_sha,independent_reviewer_id,operator_approver_id,
  review_url,release_evidence_digest,state,expires_at)
 VALUES(sha,'22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',
  'https://github.com/PatentFiles/Strata-Backend/pull/107',repeat('f',64),'approved',
  now()+interval '2 hours');
 IF (SELECT count(*) FROM private.strata_protective_exit_release
    WHERE release_commit_sha=sha AND revoked_at IS NULL)<>1
 THEN RAISE EXCEPTION 'renewal must leave exactly one active version'; END IF;
END $$;
ROLLBACK;
