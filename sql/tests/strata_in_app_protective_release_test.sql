\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.v13_production_account(id) VALUES('owned-execution-1') ON CONFLICT DO NOTHING;
DO $$
DECLARE
 qid uuid;
 rid uuid;
 sha text:=repeat('a',40);
BEGIN
 IF (SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_protective_release_qualification'::regclass) IS NOT TRUE
  THEN RAISE EXCEPTION 'qualification must have RLS'; END IF;
 IF (SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_protective_release_reviews'::regclass) IS NOT TRUE
  THEN RAISE EXCEPTION 'reviews must have RLS'; END IF;
 IF has_table_privilege('authenticated','private.strata_protective_release_reviews','INSERT')
  THEN RAISE EXCEPTION 'authenticated cannot write review table'; END IF;
 INSERT INTO private.strata_protective_release_qualification
 (release_commit_sha,owner_user_id,execution_account_id,evidence_digest)
 VALUES(sha,'11111111-1111-4111-8111-111111111111','owned-execution-1',repeat('a',64))
 RETURNING qualification_id INTO qid;
 INSERT INTO private.strata_protective_release_reviews
 (qualification_id,release_commit_sha,reviewer_user_id,owner_user_id,
 review_url,review_note,evidence_digest)
 VALUES(qid,sha,'22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',
 'https://github.com/PatentFiles/Strata-Backend/pull/107',
 repeat('Reviewed execution invariants and actual production scoped API evidence. ',3),repeat('c',64))
 RETURNING review_id INTO rid;
 BEGIN
  UPDATE private.strata_protective_release_reviews SET review_note='change' WHERE review_id=rid;
  RAISE EXCEPTION 'review update should have been refused';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  DELETE FROM private.strata_protective_release_qualification WHERE qualification_id=qid;
  RAISE EXCEPTION 'qualification delete should have been refused';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO private.strata_protective_release_reviews
   (qualification_id,release_commit_sha,reviewer_user_id,owner_user_id,
   review_url,review_note,evidence_digest)
  VALUES(qid,sha,'11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',
  'https://github.com/PatentFiles/Strata-Backend/pull/107',repeat('d',150),repeat('d',64));
  RAISE EXCEPTION 'same user reviewer/owner must be rejected';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
ROLLBACK;
