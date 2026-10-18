-- Disposable PostgreSQL schema test only. NEVER run against production.
-- Run after creating stub auth.users, public.v13_production_account,
-- and after applying both reviewed private exit migrations.
DO $$
DECLARE
  has_rls boolean;
  demo_count integer;
BEGIN
  SELECT c.relrowsecurity INTO has_rls FROM pg_class c
    WHERE c.oid='private.strata_demo_ioc_attempt'::regclass;
  IF has_rls IS DISTINCT FROM true THEN RAISE EXCEPTION 'demo IOC RLS disabled'; END IF;
  SELECT c.relrowsecurity INTO has_rls FROM pg_class c
    WHERE c.oid='private.strata_emergency_exit_reservations'::regclass;
  IF has_rls IS DISTINCT FROM true THEN RAISE EXCEPTION 'prod exit RLS disabled'; END IF;
  IF has_schema_privilege('anon','private','USAGE') OR
     has_schema_privilege('authenticated','private','USAGE') OR
     has_table_privilege('anon','private.strata_demo_ioc_attempt','INSERT') OR
     has_table_privilege('authenticated','private.strata_demo_ioc_attempt','SELECT') OR
     has_table_privilege('anon','private.strata_emergency_exit_reservations','UPDATE') THEN
     RAISE EXCEPTION 'private ledger exposed to web roles';
  END IF;
  IF to_regclass('private.strata_demo_ioc_attempt') IS NULL OR
     to_regclass('private.strata_emergency_exit_reservations') IS NULL THEN
     RAISE EXCEPTION 'required ledger table absent';
  END IF;
  SELECT count(*) INTO demo_count FROM pg_trigger
   WHERE tgrelid='private.strata_demo_ioc_attempt'::regclass
     AND tgname='strata_demo_ioc_transition_guard' AND NOT tgisinternal;
  IF demo_count<>1 THEN RAISE EXCEPTION 'demo one-shot trigger absent'; END IF;
END $$;

INSERT INTO auth.users(id) VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.v13_production_account(id) VALUES ('test-account');
INSERT INTO private.strata_demo_ioc_attempt (
 attempt_id,owner_user_id,demo_account_id,signer_fingerprint,
 client_order_id,market_ticker,reducing_side,requested_hundredths,
 price_dollars,fee_fingerprint,operator_approval_id,
 worker_holder_id,worker_fencing_token,expires_at
) VALUES (
 '22222222-2222-4222-8222-222222222222',
 '11111111-1111-4111-8111-111111111111',
 'demo-1',repeat('a',64),
 'v13p-33333333-3333-4333-8333-333333333333',
 'KXBTC15M-26OCT180000-15','ask',100,
 '0.5000',repeat('b',64),
 '44444444-4444-4444-8444-444444444444',
 'worker-1',1,now()+interval '1 hour'
);

UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN',
 updated_at=now() WHERE attempt_id='22222222-2222-4222-8222-222222222222';
DO $$
BEGIN
  BEGIN
    UPDATE private.strata_demo_ioc_attempt SET state='PREPARED'
      WHERE attempt_id='22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'accepted unsafe UNKNOWN to PREPARED reset';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    UPDATE private.strata_demo_ioc_attempt SET
      fee_fingerprint=repeat('c',64),updated_at=now()
      WHERE attempt_id='22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'accepted immutable attempt modification';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;
UPDATE private.strata_demo_ioc_attempt SET state='RECONCILED',updated_at=now()
 WHERE attempt_id='22222222-2222-4222-8222-222222222222';
DO $$
BEGIN
  BEGIN
    UPDATE private.strata_demo_ioc_attempt SET state='UNKNOWN',updated_at=now()
      WHERE attempt_id='22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'accepted terminal state regression';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;

INSERT INTO private.strata_emergency_exit_reservations (
 reservation_id,owner_user_id,execution_account_id,market_ticker,
 client_order_id,reducing_side,quantity_hundredths,order_digest,
 worker_fencing_token,worker_holder_id
) VALUES (
 '55555555-5555-4555-8555-555555555555',
 '11111111-1111-4111-8111-111111111111',
 'test-account','KXBTC15M-26OCT180000-15',
 'v13p-66666666-6666-4666-8666-666666666666',
 'YES',100,repeat('d',64),1,'worker-1'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO private.strata_emergency_exit_reservations (
      reservation_id,owner_user_id,execution_account_id,market_ticker,
      client_order_id,reducing_side,quantity_hundredths,order_digest,
      worker_fencing_token,worker_holder_id
    ) VALUES (
      '77777777-7777-4777-8777-777777777777',
      '11111111-1111-4111-8111-111111111111',
      'test-account','KXBTC15M-26OCT180000-15',
      'v13p-88888888-8888-4888-8888-888888888888',
      'YES',100,repeat('e',64),1,'worker-1'
    );
    RAISE EXCEPTION 'accepted concurrent unresolved reservations';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
-- Production reservation state changes remain one-way, including for the
-- privileged database role. No reset to PREPARED or forged identity is allowed.
UPDATE private.strata_emergency_exit_reservations
  SET state='UNKNOWN',updated_at=now()
  WHERE reservation_id='55555555-5555-4555-8555-555555555555';
DO $$
DECLARE trigger_count int;
BEGIN
  SELECT count(*) INTO trigger_count FROM pg_trigger
    WHERE tgrelid='private.strata_emergency_exit_reservations'::regclass
      AND tgname='strata_emergency_exit_transition_guard' AND NOT tgisinternal;
  IF trigger_count<>1 THEN RAISE EXCEPTION 'production exit state trigger absent'; END IF;
  BEGIN
    UPDATE private.strata_emergency_exit_reservations
      SET state='PREPARED',updated_at=now()
      WHERE reservation_id='55555555-5555-4555-8555-555555555555';
    RAISE EXCEPTION 'accepted unsafe production UNKNOWN reset';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    UPDATE private.strata_emergency_exit_reservations
      SET order_digest=repeat('f',64),updated_at=now()
      WHERE reservation_id='55555555-5555-4555-8555-555555555555';
    RAISE EXCEPTION 'accepted production immutable order modification';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    DELETE FROM private.strata_emergency_exit_reservations
      WHERE reservation_id='55555555-5555-4555-8555-555555555555';
    RAISE EXCEPTION 'accepted production reservation deletion';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;
UPDATE private.strata_emergency_exit_reservations
  SET state='RECONCILED',updated_at=now()
  WHERE reservation_id='55555555-5555-4555-8555-555555555555';
DO $$
BEGIN
  BEGIN
    UPDATE private.strata_emergency_exit_reservations
      SET state='UNKNOWN',updated_at=now()
      WHERE reservation_id='55555555-5555-4555-8555-555555555555';
    RAISE EXCEPTION 'accepted terminal production exit regression';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;

SELECT 'DISPOSABLE_PRIVATE_EXIT_LEDGER_SQL_TESTS_PASSED' AS result;
