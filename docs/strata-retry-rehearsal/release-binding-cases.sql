CREATE FUNCTION scoped_fixture(sha text DEFAULT repeat('b',40),fence bigint DEFAULT 11) RETURNS boolean LANGUAGE SQL AS $$
 SELECT private.strata_record_worker_first_market_fee_refusal('w','10000000-0000-4000-a000-000000000001',sha,'worker',fence,repeat('a',64),'KXBTC15M-FIXTURE:first','w1',encode(sha256(convert_to('w1','UTF8')),'hex'));
$$;
DO $$ BEGIN
 IF NOT claim_fixture('w','w1') OR scoped_fixture() THEN RAISE EXCEPTION 'missing release binding accepted'; END IF;
 INSERT INTO private.strata_direct_retry_release(account_id,owner_id,release_sha) VALUES('w','10000000-0000-4000-a000-000000000001',repeat('b',40));
 IF scoped_fixture() THEN RAISE EXCEPTION 'default-off binding accepted'; END IF;
 UPDATE private.strata_direct_retry_release SET receipt_enabled=true WHERE account_id='w';
 IF scoped_fixture(repeat('c',40)) OR scoped_fixture(repeat('b',40),10) THEN RAISE EXCEPTION 'wrong scope accepted'; END IF;
 UPDATE private.kalshi_account_worker_lease SET heartbeat_at=clock_timestamp()-interval '6 seconds' WHERE execution_account_id='w';
 IF scoped_fixture() THEN RAISE EXCEPTION 'stale heartbeat accepted'; END IF;
 UPDATE private.kalshi_account_worker_lease SET heartbeat_at=clock_timestamp(),arm_requested=false WHERE execution_account_id='w';
 IF scoped_fixture() THEN RAISE EXCEPTION 'stopped worker accepted'; END IF;
 UPDATE private.kalshi_account_worker_lease SET arm_requested=true WHERE execution_account_id='w';
 UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp();
 IF scoped_fixture() THEN RAISE EXCEPTION 'revoked credential accepted'; END IF;
 UPDATE private.kalshi_connection_credentials SET revoked_at=NULL;
 IF NOT scoped_fixture() OR scoped_fixture() THEN RAISE EXCEPTION 'valid pin failed or duplicate allowed'; END IF;
END $$;
GRANT USAGE ON SCHEMA private TO receipt_untrusted;
SET ROLE receipt_untrusted;
DO $$ BEGIN
 BEGIN
  PERFORM scoped_fixture();
  RAISE EXCEPTION 'untrusted scoped writer can execute';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET ROLE;
