-- Stopped-account accounting disposition. No trading authority is created.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE private.strata_settled_exit_reserve_disposition (
 settlement_request_id uuid PRIMARY KEY REFERENCES private.strata_economic_settlement_receipt(request_id),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 entry_intent_id text NOT NULL REFERENCES public.v13_production_intent(id),
 exit_intent_id text NOT NULL UNIQUE REFERENCES public.v13_production_intent(id),
 reservation_id uuid NOT NULL UNIQUE REFERENCES private.strata_emergency_exit_reservations(reservation_id),
 request_id uuid NOT NULL UNIQUE,
 scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
 release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
 released_micros bigint NOT NULL CHECK (released_micros>0),
 prior_revision bigint NOT NULL CHECK (prior_revision>=0),
 applied_revision bigint NOT NULL CHECK (applied_revision=prior_revision+1),
 control_epoch bigint NOT NULL CHECK (control_epoch>=0),
 worker_fencing_token bigint NOT NULL CHECK (worker_fencing_token>=0),
 transport_outcome text NOT NULL DEFAULT 'UNKNOWN' CHECK (transport_outcome='UNKNOWN'),
 trading_authorized boolean NOT NULL DEFAULT false CHECK (NOT trading_authorized),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.strata_settled_exit_reserve_disposition ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_settled_exit_reserve_disposition FROM PUBLIC,anon,authenticated;
CREATE FUNCTION private.strata_settled_exit_reserve_disposition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'settled exit reserve dispositions are immutable'; END IF;
 PERFORM 1 FROM private.strata_economic_settlement_receipt s
 JOIN public.v13_production_account a ON a.id=s.execution_account_id AND a.owner_user_id=s.owner_user_id
 JOIN public.v13_production_intent parent ON parent.id=s.entry_intent_id AND parent.account_id=a.id
 JOIN public.v13_production_intent child ON child.id=s.exit_intent_id AND child.account_id=a.id AND child.parent_id=parent.id
 JOIN public.v13_production_position p ON p.id=parent.id AND p.account_id=a.id
 JOIN private.strata_emergency_exit_reservations m ON m.reservation_id=s.reservation_id AND m.execution_account_id=a.id
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 WHERE s.request_id=NEW.settlement_request_id AND s.owner_user_id=NEW.owner_user_id
 AND s.execution_account_id=NEW.execution_account_id AND s.entry_intent_id=NEW.entry_intent_id
 AND s.exit_intent_id=NEW.exit_intent_id AND s.reservation_id=NEW.reservation_id
 AND s.posted_revision=NEW.prior_revision AND s.control_epoch=NEW.control_epoch
 AND s.worker_fencing_token=NEW.worker_fencing_token
 AND a.revision=NEW.applied_revision AND a.owner_control_epoch=NEW.control_epoch
 AND a.cash_micros::text=s.payload->>'cashAfterMicros'
 AND a.reserved_micros=0 AND parent.terminal AND parent.kind='ENTRY' AND parent.reserved_micros=0
 AND NEW.released_micros::text=s.payload->>'reservedMicros'
 AND p.quantity_hundredths=0 AND p.basis_micros=0
 AND child.kind='EXIT' AND child.state IN ('DISPATCHED','UNKNOWN') AND NOT child.terminal
 AND child.exchange_order_id IS NULL AND child.filled_hundredths=0 AND child.reserved_micros=0
 AND m.owner_user_id=a.owner_user_id AND m.client_order_id=child.client_order_id AND m.state='UNKNOWN' AND NOT m.trading_authorized
 AND NOT w.arm_requested AND w.fencing_token=NEW.worker_fencing_token
 AND (w.state='released' OR (w.state IN ('owned','killed') AND w.heartbeat_at<=clock_timestamp()-interval '30 seconds'));
 IF NOT FOUND THEN RAISE EXCEPTION 'settled exit reserve disposition scope mismatch'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_settled_exit_reserve_disposition_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER strata_settled_exit_reserve_disposition_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private.strata_settled_exit_reserve_disposition FOR EACH ROW EXECUTE FUNCTION private.strata_settled_exit_reserve_disposition_guard();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
  GRANT SELECT,INSERT ON private.strata_settled_exit_reserve_disposition TO strata_api_runtime;
  GRANT EXECUTE ON FUNCTION private.strata_settled_exit_reserve_disposition_guard() TO strata_api_runtime;
  CREATE POLICY strata_api_runtime_reserve_disposition ON private.strata_settled_exit_reserve_disposition
   TO strata_api_runtime USING (true) WITH CHECK (true);
 END IF;
END $$;
COMMIT;
