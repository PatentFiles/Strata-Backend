CREATE FUNCTION claim_fixture(a text,s text,age interval DEFAULT '10 ms')
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE snap timestamptz:=clock_timestamp()-age;
BEGIN
 INSERT INTO strata_direct_entry_source VALUES(s,a,'KXBTC15M-FIXTURE','KXBTC15M-FIXTURE:first',snap,snap,snap+interval '1 minute',s,encode(sha256(convert_to(s,'UTF8')),'hex'));
 RETURN FOUND;
END $$;
CREATE FUNCTION retire_fixture(a text,s text) RETURNS boolean LANGUAGE sql AS $$
 SELECT strata_record_first_market_fee_refusal(a,'KXBTC15M-FIXTURE:first',s,encode(sha256(convert_to(s,'UTF8')),'hex'));
$$;
CREATE FUNCTION prepare_fixture(a text,s text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO v13_production_intent(id,account_id,crossing_key,direct_source_id)
 VALUES(s,a,'KXBTC15M-FIXTURE:first',s);
 RETURN true;
EXCEPTION WHEN raise_exception OR unique_violation THEN RETURN false;
END $$;
DO $$ BEGIN
 IF NOT claim_fixture('s','s1') OR claim_fixture('s','s2') THEN RAISE EXCEPTION 'claim'; END IF;
 IF strata_record_first_market_fee_refusal('s','KXBTC15M-FIXTURE:first','s1',repeat('0',64)) THEN RAISE EXCEPTION 'wrong digest'; END IF;
 IF NOT retire_fixture('s','s1') OR prepare_fixture('s','s1') OR claim_fixture('s','stale','6 seconds') OR claim_fixture('s','replayed','1 second') THEN RAISE EXCEPTION 'retired source or stale successor'; END IF;
 IF NOT claim_fixture('s','s2','0 ms') OR NOT prepare_fixture('s','s2') OR claim_fixture('s','s3','0 ms') THEN RAISE EXCEPTION 'successor or duplicate'; END IF;
 IF retire_fixture('s','s2') THEN RAISE EXCEPTION 'retired reserved intent'; END IF;
 IF NOT claim_fixture('u','u1') THEN RAISE EXCEPTION 'unknown fixture'; END IF;
 UPDATE v13_production_account SET reserved_micros=100 WHERE id='u';
 IF retire_fixture('u','u1') THEN RAISE EXCEPTION 'retired account with reserved balance'; END IF;
END $$;
SELECT claim_fixture('b','b1'),claim_fixture('p','p1'),claim_fixture('r','r1');
BEGIN;
SELECT retire_fixture('b','b1');
ROLLBACK;
DO $$ BEGIN IF claim_fixture('b','b2','0 ms') THEN RAISE EXCEPTION 'rolled-back receipt rearmed'; END IF; END $$;
CREATE ROLE receipt_untrusted;
DO $$ BEGIN IF has_function_privilege('receipt_untrusted','strata_record_first_market_fee_refusal(text,text,text,text)','execute') THEN RAISE EXCEPTION 'receipt issuer open'; END IF; END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM strata_direct_entry_current WHERE account_id='legacy' AND source_id='old' AND generation=1)
  THEN RAISE EXCEPTION 'stopped activation did not backfill incumbent source'; END IF;
 IF NOT claim_fixture('cap','cap1') OR NOT retire_fixture('cap','cap1') OR NOT claim_fixture('cap','cap2','0 ms') THEN RAISE EXCEPTION 'first replacement absent'; END IF;
 IF retire_fixture('cap','cap2') OR claim_fixture('cap','cap3','0 ms') THEN RAISE EXCEPTION 'third attempt accepted'; END IF;
END $$;
SET ROLE receipt_untrusted;
DO $$
BEGIN
 BEGIN
  PERFORM public.strata_record_first_market_fee_refusal('legacy','KXBTC15M-FIXTURE:first','old',encode(sha256(convert_to('a','UTF8')),'hex'));
  RAISE EXCEPTION 'untrusted activated SECURITY DEFINER';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  INSERT INTO public.strata_direct_entry_refusal (source_id,account_id,crossing_key,source_sha256,reason)
  VALUES('old','legacy','KXBTC15M-FIXTURE:first',encode(sha256(convert_to('a','UTF8')),'hex'),'FIRST_MARKET_READ_EVENT_FEE_UNVERIFIED_BEFORE_TX');
  RAISE EXCEPTION 'untrusted inserted proof';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.strata_direct_entry_refusal WHERE source_id='old') THEN RAISE EXCEPTION 'untrusted persisted proof'; END IF; END $$;
