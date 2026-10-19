-- Disposable PostgreSQL ONLY. Run after base and three candidate migrations.
DO $$
DECLARE n integer;
BEGIN
 FOR n IN 1..3 LOOP
   EXIT WHEN n > 3;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_emergency_exit_reservations'::regclass)
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_protective_exit_reconciliations'::regclass)
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='private.strata_protective_exit_release'::regclass)
 THEN RAISE EXCEPTION 'RLS missing'; END IF;
 IF has_table_privilege('anon','private.strata_protective_exit_release','SELECT')
 OR has_table_privilege('authenticated','private.strata_protective_exit_reconciliations','INSERT')
 THEN RAISE EXCEPTION 'unsafe web grants'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='private.strata_emergency_exit_reservations'::regclass AND tgname='strata_protective_exit_baseline_guard' AND NOT tgisinternal)<>1
 THEN RAISE EXCEPTION 'baseline guard missing'; END IF;
END $$;
INSERT INTO auth.users(id) VALUES ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
INSERT INTO public.v13_production_account(id) VALUES ('isolated-1');
INSERT INTO private.strata_emergency_exit_reservations(
 reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,
 reducing_side,quantity_hundredths,order_digest,worker_fencing_token,worker_holder_id,
 initial_position_fp,position_observed_at_ms)
VALUES('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
 'isolated-1','KXBTC15M-TEST','v13p-44444444-4444-4444-8444-444444444444',
 'YES',100,repeat('a',64),1,'w-1','2.00',100000);
DO $$
BEGIN
 BEGIN
 UPDATE private.strata_emergency_exit_reservations SET initial_position_fp='3.00'
 WHERE reservation_id='33333333-3333-4333-8333-333333333333';
 RAISE EXCEPTION 'baseline mutation accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
 END;
END $$;
UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN', updated_at=now()
WHERE reservation_id='33333333-3333-4333-8333-333333333333';
INSERT INTO private.strata_protective_exit_reconciliations(
 reservation_id,owner_user_id,execution_account_id,client_order_id,market_ticker,
 evidence_sha256,filled_hundredths,remaining_hundredths,observed_position_fp)
VALUES('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
 'isolated-1','v13p-44444444-4444-4444-8444-444444444444','KXBTC15M-TEST',
 repeat('b',64),100,0,'1.00');
DO $$
BEGIN
 BEGIN
 UPDATE private.strata_protective_exit_reconciliations SET filled_hundredths=0;
 RAISE EXCEPTION 'reconciliation mutation accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
 END;
 BEGIN
 DELETE FROM private.strata_protective_exit_reconciliations;
 RAISE EXCEPTION 'reconciliation deletion accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
 END;
 BEGIN
 INSERT INTO private.strata_protective_exit_reconciliations(
 reservation_id,owner_user_id,execution_account_id,client_order_id,market_ticker,
 evidence_sha256,filled_hundredths,remaining_hundredths,observed_position_fp)
 SELECT reservation_id,owner_user_id,execution_account_id,client_order_id,market_ticker,
 evidence_sha256,filled_hundredths,remaining_hundredths,observed_position_fp
 FROM private.strata_protective_exit_reconciliations;
 RAISE EXCEPTION 'duplicate reconciliation accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
END $$;
INSERT INTO private.strata_protective_exit_release(
 release_commit_sha,independent_reviewer_id,operator_approver_id,review_url,
 release_evidence_digest,expires_at)
VALUES(repeat('c',40),'11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222',
 'https://github.com/PatentFiles/Strata-Backend/pull/99',repeat('d',64),now()+interval '2 hours');
DO $$
BEGIN
 BEGIN
 UPDATE private.strata_protective_exit_release SET release_commit_sha=repeat('e',40);
 RAISE EXCEPTION 'release identity mutation accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
 END;
 BEGIN
 INSERT INTO private.strata_protective_exit_release(
 release_commit_sha,independent_reviewer_id,operator_approver_id,review_url,
 release_evidence_digest,expires_at)
 VALUES(repeat('f',40),'11111111-1111-4111-8111-111111111111',
 '11111111-1111-4111-8111-111111111111',
 'https://github.com/PatentFiles/Strata-Backend/pull/99',repeat('d',64),now()+interval '1 hour');
 RAISE EXCEPTION 'same-actor release accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
UPDATE private.strata_protective_exit_release SET revoked_at=now();
DO $$
BEGIN
 BEGIN
 UPDATE private.strata_protective_exit_release SET revoked_at=NULL;
 RAISE EXCEPTION 'release unrevocation accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
 END;
END $$;
SELECT 'CANDIDATE_PROTECTIVE_EXIT_SQL_ISOLATED_PASS' AS result;
