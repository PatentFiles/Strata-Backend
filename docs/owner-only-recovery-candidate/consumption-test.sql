\set ON_ERROR_STOP on
\i owner-only-assurance-prototype/consumption.sql
INSERT INTO prototype.control_head VALUES('account','owner',1,5,false);
INSERT INTO prototype.evidence VALUES('e1','account','owner',1,5,clock_timestamp()+interval '5 minutes'),('e2','account','owner',1,5,clock_timestamp()+interval '5 minutes');
DO $$ BEGIN
 IF prototype.consume('e1','foreign','r1')<>'scope_refused' THEN RAISE EXCEPTION 'foreign scope'; END IF;
 IF prototype.consume('e1','owner','r1')<>'consumed_evidence_only' THEN RAISE EXCEPTION 'first consume'; END IF;
 IF prototype.consume('e1','owner','r1')<>'already_consumed_readback' THEN RAISE EXCEPTION 'idempotent readback'; END IF;
 IF prototype.consume('e1','owner','r2')<>'replay_refused' THEN RAISE EXCEPTION 'replay'; END IF;
 IF prototype.consume('e2','owner','r1')<>'request_reused' THEN RAISE EXCEPTION 'request reuse'; END IF;
END $$;
BEGIN;
SELECT prototype.consume('e2','owner','r2');
ROLLBACK;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM prototype.consumption WHERE evidence_id='e2') THEN RAISE EXCEPTION 'rollback failure'; END IF; END $$;
UPDATE prototype.control_head SET sequence=sequence+1,stopped=true WHERE account_id='account';
DO $$ BEGIN
 IF prototype.consume('e2','owner','r2')<>'superseded' THEN RAISE EXCEPTION 'STOP lost'; END IF;
 IF (SELECT count(*) FROM prototype.consumption)<>1 THEN RAISE EXCEPTION 'receipt changed'; END IF;
END $$;
SELECT 'PASS scope, consume, exact retry readback, replay, request reuse, rollback, STOP supersession';
