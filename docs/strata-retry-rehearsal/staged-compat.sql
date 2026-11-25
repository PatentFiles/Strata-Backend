-- Confirm staging without activation does not alter the incumbent source writer.
INSERT INTO v13_production_account(id) VALUES('legacy');
DO $$ DECLARE snap timestamptz:=clock_timestamp(); BEGIN
 INSERT INTO strata_direct_entry_source VALUES('old','legacy','KXBTC15M-FIXTURE','KXBTC15M-FIXTURE:first',snap,snap,snap+interval '1 minute','a',encode(sha256(convert_to('a','UTF8')),'hex')) ON CONFLICT(account_id,crossing_key) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'incumbent first write failed'; END IF;
 INSERT INTO strata_direct_entry_source VALUES('old2','legacy','KXBTC15M-FIXTURE','KXBTC15M-FIXTURE:first',snap,snap,snap+interval '1 minute','b',encode(sha256(convert_to('b','UTF8')),'hex')) ON CONFLICT(account_id,crossing_key) DO NOTHING;
 IF FOUND THEN RAISE EXCEPTION 'incumbent uniqueness failed'; END IF;
 IF EXISTS(SELECT 1 FROM strata_direct_entry_current) THEN RAISE EXCEPTION 'staging changed active pointer'; END IF;
END $$;
