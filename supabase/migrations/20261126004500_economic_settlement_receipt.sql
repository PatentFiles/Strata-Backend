-- Accounting-only recovery: adds no execution authority and changes no account.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE private.strata_economic_settlement_cancel (
 owner_user_id uuid NOT NULL REFERENCES auth.users(id), request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_user_id,request_id)
);
ALTER TABLE private.strata_economic_settlement_cancel ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_economic_settlement_cancel FROM PUBLIC,anon,authenticated;
CREATE FUNCTION private.strata_economic_settlement_cancel_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 RAISE EXCEPTION 'economic settlement cancellation tombstones are immutable';
END $$;
REVOKE ALL ON FUNCTION private.strata_economic_settlement_cancel_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER strata_economic_settlement_cancel_guard BEFORE UPDATE OR DELETE
 ON private.strata_economic_settlement_cancel FOR EACH ROW EXECUTE FUNCTION private.strata_economic_settlement_cancel_guard();
CREATE TABLE private.strata_economic_settlement_receipt (
 request_id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 entry_intent_id text NOT NULL REFERENCES public.v13_production_intent(id),
 exit_intent_id text NOT NULL REFERENCES public.v13_production_intent(id),
 reservation_id uuid NOT NULL REFERENCES private.strata_emergency_exit_reservations(reservation_id),
 settlement_event_id text NOT NULL,
 settlement_digest text NOT NULL CHECK (settlement_digest ~ '^[a-f0-9]{64}$'),
 scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
 release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
 prior_revision bigint NOT NULL CHECK (prior_revision>=0),
 posted_revision bigint NOT NULL CHECK (posted_revision=prior_revision+1),
 control_epoch bigint NOT NULL CHECK (control_epoch>=0),
 worker_fencing_token bigint NOT NULL CHECK (worker_fencing_token>=0),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
 transport_outcome text NOT NULL DEFAULT 'UNKNOWN' CHECK (transport_outcome='UNKNOWN'),
 trading_authorized boolean NOT NULL DEFAULT false CHECK (trading_authorized=false),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (execution_account_id,settlement_event_id),
 UNIQUE (reservation_id),
 FOREIGN KEY (execution_account_id,settlement_event_id)
  REFERENCES public.v13_production_event(account_id,event_id)
);
ALTER TABLE private.strata_economic_settlement_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_economic_settlement_receipt FROM PUBLIC,anon,authenticated;
CREATE FUNCTION private.strata_economic_settlement_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'economic settlement receipts are immutable'; END IF;
 PERFORM 1 FROM public.v13_production_account a
 JOIN public.v13_production_intent entry ON entry.id=NEW.entry_intent_id AND entry.account_id=a.id
 JOIN public.v13_production_intent uncertain ON uncertain.id=NEW.exit_intent_id AND uncertain.account_id=a.id
  AND uncertain.parent_id=entry.id AND uncertain.kind='EXIT' AND uncertain.state IN ('DISPATCHED','UNKNOWN')
  AND NOT uncertain.terminal AND uncertain.exchange_order_id IS NULL AND uncertain.filled_hundredths=0
 JOIN public.v13_production_position position ON position.id=entry.id AND position.account_id=a.id
  AND position.quantity_hundredths=0 AND position.basis_micros=0
 JOIN private.strata_emergency_exit_reservations r ON r.reservation_id=NEW.reservation_id
  AND r.execution_account_id=a.id AND r.owner_user_id=a.owner_user_id
  AND r.client_order_id=uncertain.client_order_id AND r.state='UNKNOWN' AND NOT r.trading_authorized
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
  AND NOT w.arm_requested AND w.fencing_token=NEW.worker_fencing_token
 JOIN public.v13_production_event e ON e.account_id=a.id AND e.event_id=NEW.settlement_event_id
  AND e.intent_id=entry.id AND e.kind='SETTLEMENT' AND e.digest=NEW.settlement_digest
 WHERE a.id=NEW.execution_account_id AND a.owner_user_id=NEW.owner_user_id
  AND a.revision=NEW.posted_revision AND a.owner_control_epoch=NEW.control_epoch
  AND a.cash_micros::text=NEW.payload->>'cashAfterMicros'
  AND a.reserved_micros::text=NEW.payload->>'reservedMicros'
  AND NEW.payload->>'accountId'=a.id AND NEW.payload->>'ownerId'=a.owner_user_id::text
  AND NEW.payload->>'eventId'=e.event_id AND NEW.payload->>'exitId'=uncertain.id
  AND NEW.payload->>'parentId'=entry.id AND NEW.payload->>'reservationId'=r.reservation_id::text
  AND NEW.payload->>'transportOutcome'='UNKNOWN' AND NEW.payload->>'tradingAuthorized'='false';
 IF NOT FOUND THEN RAISE EXCEPTION 'economic settlement receipt scope or accounting mismatch'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_economic_settlement_receipt_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER strata_economic_settlement_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private.strata_economic_settlement_receipt FOR EACH ROW EXECUTE FUNCTION private.strata_economic_settlement_receipt_guard();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
  GRANT SELECT,INSERT ON private.strata_economic_settlement_cancel TO strata_api_runtime;
  CREATE POLICY strata_api_runtime_economic_cancel ON private.strata_economic_settlement_cancel TO strata_api_runtime USING(true) WITH CHECK(true);
  GRANT SELECT,INSERT ON private.strata_economic_settlement_receipt TO strata_api_runtime;
  GRANT EXECUTE ON FUNCTION private.strata_economic_settlement_receipt_guard() TO strata_api_runtime;
  CREATE POLICY strata_api_runtime_economic_settlement ON private.strata_economic_settlement_receipt
   TO strata_api_runtime USING (true) WITH CHECK (true);
 END IF;
END $$;
COMMIT;