-- Disposable PostgreSQL regression for bounded review coordination.
-- Intentionally rolls back all fixture inserts; no production state or order.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES
 ('99999999-9999-4999-8999-999999999991'),
 ('99999999-9999-4999-8999-999999999992') ON CONFLICT DO NOTHING;
INSERT INTO public.v13_production_account(id) VALUES ('coordination-test-1')
ON CONFLICT DO NOTHING;
DO $$
DECLARE qid uuid; q_start timestamptz; q_expiry timestamptz;
        r_start timestamptz; r_expiry timestamptz; 
BEGIN
  -- New attestations get an eight-hour coordination deadline, not perpetual.
  INSERT INTO private.strata_protective_release_qualification
    (release_commit_sha,owner_user_id,execution_account_id,evidence_digest)
  VALUES(repeat('a',40),'99999999-9999-4999-8999-999999999991',
    'coordination-test-1',repeat('b',64))
  RETURNING qualification_id,observed_at,expires_at INTO qid,q_start,q_expiry;
  IF q_expiry-q_start <> interval '8 hours' THEN
    RAISE EXCEPTION 'new signed qualification does not have exactly eight-hour review window';
  END IF;
  INSERT INTO private.strata_protective_release_reviews
    (qualification_id,release_commit_sha,reviewer_user_id,owner_user_id,review_url,review_note,evidence_digest)
  VALUES(qid,repeat('a',40),'99999999-9999-4999-8999-999999999992',
    '99999999-9999-4999-8999-999999999991',
    'https://github.com/PatentFiles/Strata-Backend/pull/99',
    repeat('A',140),repeat('c',64))
  RETURNING approved_at,expires_at INTO r_start,r_expiry;
  IF r_expiry-r_start <> interval '8 hours' THEN
    RAISE EXCEPTION 'new independent review does not have exactly eight-hour owner coordination window';
  END IF;
  -- The original immutable 15-minute receipts must remain allowed unchanged.
  INSERT INTO private.strata_protective_release_qualification
    (release_commit_sha,owner_user_id,execution_account_id,evidence_digest,observed_at,expires_at)
  VALUES(repeat('a',40),'99999999-9999-4999-8999-999999999991',
    'coordination-test-1',repeat('d',64),now(),now()+interval '15 minutes');
  -- More than eight hours is still prohibited.
  BEGIN
    INSERT INTO private.strata_protective_release_qualification
      (release_commit_sha,owner_user_id,execution_account_id,evidence_digest,observed_at,expires_at)
    VALUES(repeat('a',40),'99999999-9999-4999-8999-999999999991',
      'coordination-test-1',repeat('e',64),now(),now()+interval '9 hours');
    RAISE EXCEPTION 'oversized qualification was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.strata_protective_release_qualification
    SET expires_at=now()+interval '7 hours'
    WHERE qualification_id=qid;
    RAISE EXCEPTION 'immutable signed proof could be silently edited';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.strata_protective_release_reviews
      (qualification_id,release_commit_sha,reviewer_user_id,owner_user_id,review_url,review_note,evidence_digest)
    VALUES(qid,repeat('a',40),'99999999-9999-4999-8999-999999999991',
      '99999999-9999-4999-8999-999999999991',
      'https://github.com/PatentFiles/Strata-Backend/pull/99',repeat('A',140),repeat('f',64));
    RAISE EXCEPTION 'reviewer can attest own evidence';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
