-- Additive economic finality. This migration changes no existing account or financial state.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE private.strata_economic_exit_discharge_cancel (
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_user_id,request_id)
);
CREATE TABLE private.strata_economic_exit_discharge (
 request_id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 booking_request_id uuid NOT NULL UNIQUE REFERENCES private.strata_economic_settlement_receipt(request_id),
 booking_digest text NOT NULL CHECK(booking_digest ~ '^[a-f0-9]{64}$'),
 entry_intent_id text NOT NULL REFERENCES public.v13_production_intent(id),
 exit_intent_id text NOT NULL UNIQUE REFERENCES public.v13_production_intent(id),
 reservation_id uuid NOT NULL UNIQUE REFERENCES private.strata_emergency_exit_reservations(reservation_id),
 client_order_id text NOT NULL,settlement_event_id text NOT NULL,
 settlement_digest text NOT NULL CHECK(settlement_digest ~ '^[a-f0-9]{64}$'),
 exit_request jsonb NOT NULL CHECK(jsonb_typeof(exit_request)='object'),
 exit_capability_digest text NOT NULL CHECK(exit_capability_digest ~ '^[a-f0-9]{64}$'),
 exit_dispatch_at timestamptz NOT NULL,marker_order_digest text NOT NULL CHECK(marker_order_digest ~ '^[a-f0-9]{64}$'),
 scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
 released_reserve_micros bigint NOT NULL CHECK(released_reserve_micros>0),
 prior_revision bigint NOT NULL CHECK(prior_revision>=0),posted_revision bigint NOT NULL CHECK(posted_revision=prior_revision+1),
 prior_control_epoch bigint NOT NULL CHECK(prior_control_epoch>=0),control_epoch bigint NOT NULL CHECK(control_epoch=prior_control_epoch+1),
 prior_worker_fence bigint NOT NULL CHECK(prior_worker_fence>=0),worker_fence bigint NOT NULL CHECK(worker_fence=prior_worker_fence+1),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 transport_outcome text NOT NULL DEFAULT 'UNKNOWN' CHECK(transport_outcome='UNKNOWN'),
 trading_authorized boolean NOT NULL DEFAULT false CHECK(NOT trading_authorized),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(execution_account_id,client_order_id),
 FOREIGN KEY(execution_account_id,settlement_event_id) REFERENCES public.v13_production_event(account_id,event_id)
);
ALTER TABLE private.strata_economic_exit_discharge ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_economic_exit_discharge_cancel ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_economic_exit_discharge,private.strata_economic_exit_discharge_cancel FROM PUBLIC,anon,authenticated;
CREATE FUNCTION private.strata_economic_exit_discharge_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'economic discharge history is immutable'; END $$;
REVOKE ALL ON FUNCTION private.strata_economic_exit_discharge_immutable() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER strata_economic_exit_discharge_immutable BEFORE UPDATE OR DELETE ON private.strata_economic_exit_discharge
 FOR EACH ROW EXECUTE FUNCTION private.strata_economic_exit_discharge_immutable();
CREATE TRIGGER strata_economic_exit_discharge_cancel_immutable BEFORE UPDATE OR DELETE ON private.strata_economic_exit_discharge_cancel
 FOR EACH ROW EXECUTE FUNCTION private.strata_economic_exit_discharge_immutable();
-- Recognition requires a positive exact join, never absence, age or market name.
-- Changed intent/event/receipt or reopened parent restores the uncertainty gate.
CREATE FUNCTION private.strata_has_economic_exit_discharge(account_id text,client_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM private.strata_economic_exit_discharge d
 JOIN private.strata_economic_settlement_receipt b ON b.request_id=d.booking_request_id
  AND b.execution_account_id=d.execution_account_id AND b.owner_user_id=d.owner_user_id
  AND b.entry_intent_id=d.entry_intent_id AND b.exit_intent_id=d.exit_intent_id AND b.reservation_id=d.reservation_id
  AND b.settlement_event_id=d.settlement_event_id AND b.settlement_digest=d.settlement_digest AND b.payload_digest=d.booking_digest
  AND b.transport_outcome='UNKNOWN' AND NOT b.trading_authorized
 JOIN public.v13_production_account a ON a.id=d.execution_account_id AND a.owner_user_id=d.owner_user_id
 JOIN public.v13_production_intent i ON i.id=d.exit_intent_id AND i.account_id=a.id
  AND i.parent_id=d.entry_intent_id AND i.client_order_id=d.client_order_id AND i.kind='EXIT'
  AND i.state IN ('DISPATCHED','UNKNOWN') AND NOT i.terminal AND i.exchange_order_id IS NULL
  AND i.filled_hundredths=0 AND i.reserved_micros=0 AND i.request=d.exit_request
  AND i.capability_digest=d.exit_capability_digest AND i.dispatch_at=d.exit_dispatch_at
 JOIN private.strata_emergency_exit_reservations r ON r.reservation_id=d.reservation_id AND r.execution_account_id=a.id
  AND r.owner_user_id=d.owner_user_id AND r.client_order_id=i.client_order_id AND r.state='UNKNOWN'
  AND NOT r.trading_authorized AND r.order_digest=d.marker_order_digest
 JOIN public.v13_production_intent parent ON parent.id=d.entry_intent_id AND parent.account_id=a.id
  AND parent.kind='ENTRY' AND parent.state='TERMINAL' AND parent.terminal AND parent.reserved_micros=0
 JOIN public.v13_production_position p ON p.id=parent.id AND p.account_id=a.id AND p.quantity_hundredths=0 AND p.basis_micros=0
 JOIN public.v13_production_event e ON e.account_id=a.id AND e.event_id=d.settlement_event_id
  AND e.intent_id=parent.id AND e.kind='SETTLEMENT' AND e.digest=d.settlement_digest AND e.payload=b.payload->'settlement'
  AND e.cash_delta_micros::text=b.payload->>'cashDeltaMicros'
  AND e.pnl_micros::text=b.payload->>'pnlMicros'
  AND extract(epoch FROM e.occurred_at)*1000=(b.payload->'settlement'->>'occurredAtMs')::numeric
 WHERE d.execution_account_id=$1 AND d.client_order_id=$2 AND d.transport_outcome='UNKNOWN' AND NOT d.trading_authorized)
$$;
REVOKE ALL ON FUNCTION private.strata_has_economic_exit_discharge(text,text) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION private.strata_economic_exit_discharge_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM private.strata_economic_exit_discharge_cancel c WHERE c.owner_user_id=NEW.owner_user_id AND c.request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'economic discharge request canceled'; END IF;
 PERFORM 1 FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 JOIN private.strata_economic_settlement_receipt b ON b.request_id=NEW.booking_request_id AND b.execution_account_id=a.id
  AND b.owner_user_id=a.owner_user_id AND b.payload_digest=NEW.booking_digest AND b.exit_intent_id=NEW.exit_intent_id
  AND b.entry_intent_id=NEW.entry_intent_id AND b.reservation_id=NEW.reservation_id
 JOIN public.v13_production_intent i ON i.id=NEW.exit_intent_id AND i.account_id=a.id AND i.parent_id=NEW.entry_intent_id
  AND i.state IN ('DISPATCHED','UNKNOWN') AND NOT i.terminal AND i.exchange_order_id IS NULL AND i.filled_hundredths=0
  AND i.reserved_micros=0 AND i.request=NEW.exit_request AND i.capability_digest=NEW.exit_capability_digest AND i.dispatch_at=NEW.exit_dispatch_at
 JOIN public.v13_production_intent parent ON parent.id=NEW.entry_intent_id AND parent.account_id=a.id AND parent.reserved_micros=0
 JOIN public.v13_production_position p ON p.id=parent.id AND p.account_id=a.id AND p.quantity_hundredths=0 AND p.basis_micros=0
 JOIN private.strata_emergency_exit_reservations r ON r.reservation_id=NEW.reservation_id AND r.execution_account_id=a.id
  AND r.owner_user_id=a.owner_user_id AND r.client_order_id=i.client_order_id AND r.state='UNKNOWN' AND NOT r.trading_authorized
  AND r.order_digest=NEW.marker_order_digest
 JOIN public.v13_production_event e ON e.account_id=a.id AND e.event_id=NEW.settlement_event_id AND e.intent_id=parent.id
  AND e.kind='SETTLEMENT' AND e.digest=NEW.settlement_digest AND e.payload=b.payload->'settlement'
  AND e.cash_delta_micros::text=b.payload->>'cashDeltaMicros'
  AND e.pnl_micros::text=b.payload->>'pnlMicros'
  AND extract(epoch FROM e.occurred_at)*1000=(b.payload->'settlement'->>'occurredAtMs')::numeric
 WHERE a.id=NEW.execution_account_id AND a.owner_user_id=NEW.owner_user_id AND a.subaccount=1 AND a.exchange_index=2
  AND NOT a.execution_enabled AND a.kill_switch AND a.blocked_reason IS NULL AND a.reserved_micros=0
  AND a.revision=NEW.posted_revision AND a.owner_control_epoch=NEW.control_epoch
  AND a.cash_micros::text=NEW.payload->>'cashMicros' AND a.initial_cash_micros::text=NEW.payload->>'initialCashMicros'
  AND w.state IN ('released','killed') AND NOT w.arm_requested AND w.fencing_token=NEW.worker_fence
  AND NEW.payload->>'accountId'=a.id AND NEW.payload->>'ownerId'=a.owner_user_id::text
  AND NEW.payload->>'bookingRequestId'=b.request_id::text AND NEW.payload->>'bookingDigest'=b.payload_digest
  AND NEW.payload->>'parentId'=parent.id AND NEW.payload->>'exitId'=i.id AND NEW.payload->>'reservationId'=r.reservation_id::text
  AND NEW.payload->>'settlementEventId'=e.event_id AND NEW.payload->>'settlementDigest'=e.digest
  AND NEW.payload->>'releaseReserveMicros'=NEW.released_reserve_micros::text
  AND NEW.payload->>'transportOutcome'='UNKNOWN' AND NEW.payload->>'tradingAuthorized'='false';
 IF NOT FOUND THEN RAISE EXCEPTION 'economic discharge accounting or stopped scope invalid'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_economic_exit_discharge_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER strata_economic_exit_discharge_guard BEFORE INSERT ON private.strata_economic_exit_discharge
 FOR EACH ROW EXECUTE FUNCTION private.strata_economic_exit_discharge_guard();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
  GRANT SELECT,INSERT ON private.strata_economic_exit_discharge,private.strata_economic_exit_discharge_cancel TO strata_api_runtime;
  GRANT EXECUTE ON FUNCTION private.strata_has_economic_exit_discharge(text,text),private.strata_economic_exit_discharge_guard() TO strata_api_runtime;
  CREATE POLICY strata_api_economic_discharge ON private.strata_economic_exit_discharge TO strata_api_runtime USING(true) WITH CHECK(true);
  CREATE POLICY strata_api_economic_discharge_cancel ON private.strata_economic_exit_discharge_cancel TO strata_api_runtime USING(true) WITH CHECK(true);
 END IF;
END $$;
COMMENT ON TABLE private.strata_economic_exit_discharge IS 'Owner-confirmed financial discharge after finalized market and signed complete settlement proof. Exit transport remains UNKNOWN. Never order, fee, or worker-start authority.';
COMMIT;
