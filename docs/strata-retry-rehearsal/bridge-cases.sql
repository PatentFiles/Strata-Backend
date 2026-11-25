INSERT INTO v13_production_account(id) VALUES ('bridge'),('race_stop'),('race_capture');
INSERT INTO private.strata_direct_retry_release(account_id,owner_id,release_sha,receipt_enabled,replacement_enabled)
 SELECT id,'10000000-0000-4000-a000-000000000001',repeat('b',40),true,true
 FROM v13_production_account WHERE id IN ('bridge','race_stop','race_capture');
DO $$ BEGIN
 IF NOT claim_fixture('bridge','bridge1') OR NOT retire_fixture('bridge','bridge1')
    OR NOT claim_fixture('bridge','bridge2','0 ms') THEN RAISE EXCEPTION 'bridge setup'; END IF;
 IF NOT private.strata_stop_worker_direct_retry('bridge') OR prepare_fixture('bridge','bridge2')
  THEN RAISE EXCEPTION 'existing replacement prepared after stop'; END IF;
 IF (SELECT count(*) FROM strata_direct_entry_source WHERE account_id='bridge')<>2
    OR NOT EXISTS(SELECT 1 FROM strata_direct_entry_refusal WHERE source_id='bridge1')
  THEN RAISE EXCEPTION 'rollback bridge changed history'; END IF;
 IF NOT claim_fixture('race_stop','stop1') OR NOT retire_fixture('race_stop','stop1')
    OR NOT claim_fixture('race_capture','race1') OR NOT retire_fixture('race_capture','race1')
  THEN RAISE EXCEPTION 'race setup'; END IF;
 -- Scope writer fixture had one committed receipt before these triggers. Its
 -- default-off replacement setting must deny consuming that receipt.
 IF claim_fixture('w','w2','0 ms') THEN RAISE EXCEPTION 'old receipt ignored default off'; END IF;
END $$;
