-- DISPOSABLE TEST SCHEMA ONLY. Not a production migration or authority source.
CREATE SCHEMA prototype;
CREATE TABLE prototype.control_head(account_id text PRIMARY KEY,owner_id text NOT NULL,sequence bigint NOT NULL,worker_fence bigint NOT NULL,stopped boolean NOT NULL);
CREATE TABLE prototype.evidence(id text PRIMARY KEY,account_id text NOT NULL,owner_id text NOT NULL,sequence bigint NOT NULL,worker_fence bigint NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE prototype.consumption(evidence_id text PRIMARY KEY REFERENCES prototype.evidence(id),request_id text UNIQUE NOT NULL,consumed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION prototype.evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable_evidence'; END $$;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON prototype.evidence FOR EACH ROW EXECUTE FUNCTION prototype.evidence_immutable();
CREATE TABLE prototype.evidence_revocation(evidence_id text PRIMARY KEY REFERENCES prototype.evidence(id), revoked_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER immutable_revocation BEFORE UPDATE OR DELETE ON prototype.evidence_revocation FOR EACH ROW EXECUTE FUNCTION prototype.evidence_immutable();
CREATE FUNCTION prototype.revocation_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM prototype.control_head h JOIN prototype.evidence e ON e.account_id=h.account_id AND e.owner_id=h.owner_id WHERE e.id=NEW.evidence_id FOR UPDATE OF h;
 IF NOT FOUND THEN RAISE EXCEPTION 'revocation_scope_missing'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revocation_barrier BEFORE INSERT ON prototype.evidence_revocation FOR EACH ROW EXECUTE FUNCTION prototype.revocation_barrier();
CREATE FUNCTION prototype.revoke(eid text, actor text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE e prototype.evidence; h prototype.control_head;
BEGIN
 SELECT * INTO e FROM prototype.evidence WHERE id=eid;
 IF NOT FOUND OR e.owner_id<>actor THEN RETURN 'scope_refused'; END IF;
 SELECT * INTO h FROM prototype.control_head WHERE account_id=e.account_id FOR UPDATE;
 IF NOT FOUND OR h.owner_id<>actor THEN RETURN 'scope_refused'; END IF;
 INSERT INTO prototype.evidence_revocation(evidence_id) VALUES(eid) ON CONFLICT DO NOTHING;
 RETURN 'revoked';
END $$;
CREATE FUNCTION prototype.consume(eid text, actor text, request text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE e prototype.evidence; h prototype.control_head; prior text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RETURN 'unsupported_isolation'; END IF;
 SELECT * INTO e FROM prototype.evidence WHERE id=eid;
 IF NOT FOUND OR e.owner_id<>actor THEN RETURN 'scope_refused'; END IF;
 -- Durable account head serializes consumers with STOP in this synthetic protocol.
 SELECT * INTO h FROM prototype.control_head WHERE account_id=e.account_id FOR UPDATE;
 IF NOT FOUND OR h.owner_id<>actor THEN RETURN 'scope_refused'; END IF;
 -- Evidence is immutable; revocation writers share this exact account lock.
 IF EXISTS(SELECT 1 FROM prototype.evidence_revocation WHERE evidence_id=eid) THEN RETURN 'revoked'; END IF;
 SELECT request_id INTO prior FROM prototype.consumption WHERE evidence_id=eid;
 IF FOUND THEN RETURN CASE WHEN prior=request THEN 'already_consumed_readback' ELSE 'replay_refused' END; END IF;
 IF h.stopped OR h.sequence<>e.sequence OR h.worker_fence<>e.worker_fence THEN RETURN 'superseded'; END IF;
 IF e.expires_at<=clock_timestamp() THEN RETURN 'expired'; END IF;
 IF EXISTS(SELECT 1 FROM prototype.consumption WHERE request_id=request) THEN RETURN 'request_reused'; END IF;
 INSERT INTO prototype.consumption VALUES(eid,request,clock_timestamp());
 RETURN 'consumed_evidence_only';
END $$;
REVOKE ALL ON SCHEMA prototype FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA prototype FROM PUBLIC;
REVOKE ALL ON FUNCTION prototype.consume(text,text,text) FROM PUBLIC;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA prototype FROM PUBLIC;
