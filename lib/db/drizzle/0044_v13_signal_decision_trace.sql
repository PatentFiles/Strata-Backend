-- Candidate schema; apply only after signed controlled cutover.
-- No trading authority and no orders originate from this audit ledger.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_v13_signal_decisions (
 decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 execution_account_id text NOT NULL,
 evaluation_id text NOT NULL REFERENCES public.forward_test_evaluations(id),
 observed_at timestamptz NOT NULL DEFAULT now(),
 phase text NOT NULL CHECK (phase IN (
  'QUALIFYING_SEEN','PREPARE_REJECTED','ENTRY_PREPARED',
  'DISPATCH_COMPLETED','DISPATCH_REJECTED','STALE_AT_WORKER','UNSEEN_IN_WINDOW')),
 source_age_ms integer CHECK (source_age_ms IS NULL OR source_age_ms >= 0),
 reason text CHECK (reason IS NULL OR length(reason) <= 128),
 release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[a-f0-9]{40}$'),
 UNIQUE(execution_account_id,evaluation_id,phase)
);
CREATE INDEX IF NOT EXISTS strata_v13_decisions_account_idx
 ON private.strata_v13_signal_decisions(execution_account_id,observed_at DESC);
ALTER TABLE private.strata_v13_signal_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_v13_signal_decisions FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE private.strata_v13_signal_decisions_decision_id_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER strata_v13_signal_decisions_immutable
 BEFORE UPDATE OR DELETE ON private.strata_v13_signal_decisions
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_approval_audit_immutable();
-- Start the audit horizon at migration, not at the next worker restart.
CREATE TABLE private.strata_v13_signal_trace_scope (
 execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),
 started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO private.strata_v13_signal_trace_scope(execution_account_id)
 SELECT id FROM public.v13_production_account;
CREATE FUNCTION private.strata_v13_begin_trace_scope() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO private.strata_v13_signal_trace_scope(execution_account_id) VALUES(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER strata_v13_begin_trace_scope AFTER INSERT ON public.v13_production_account
 FOR EACH ROW EXECUTE FUNCTION private.strata_v13_begin_trace_scope();
REVOKE ALL ON FUNCTION private.strata_v13_begin_trace_scope() FROM PUBLIC,anon,authenticated,service_role;
-- Transactional outbox: the trace commits or rolls back with the intent/fill.
-- Never use these rows as authorization to replay an exchange POST.
CREATE TABLE private.strata_v13_execution_trace (
 trace_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 execution_account_id text NOT NULL,
 evaluation_id text,
 intent_id text NOT NULL,
 client_order_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('INTENT_STATE','EXCHANGE_EVENT','TRANSPORT_OBSERVATION')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 details jsonb NOT NULL
);
CREATE INDEX strata_v13_trace_signal ON private.strata_v13_execution_trace
 (execution_account_id,evaluation_id,trace_id);
CREATE INDEX strata_v13_trace_intent ON private.strata_v13_execution_trace(intent_id,trace_id);
CREATE FUNCTION private.strata_v13_capture_intent() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE source_id text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.state,NEW.exchange_order_id,NEW.filled_hundredths,NEW.terminal,
   NEW.cancel_attempted) IS NOT DISTINCT FROM
   (OLD.state,OLD.exchange_order_id,OLD.filled_hundredths,OLD.terminal,OLD.cancel_attempted)
   THEN RETURN NEW; END IF;
 source_id:=NEW.evaluation_id;
 IF source_id IS NULL THEN SELECT evaluation_id INTO source_id
   FROM public.v13_production_intent WHERE id=NEW.parent_id AND account_id=NEW.account_id; END IF;
 INSERT INTO private.strata_v13_execution_trace
 (execution_account_id,evaluation_id,intent_id,client_order_id,kind,details)
 VALUES(NEW.account_id,source_id,NEW.id,NEW.client_order_id,'INTENT_STATE',
 jsonb_build_object('operation',TG_OP,'state',NEW.state,'orderKind',NEW.kind,
 'exchangeOrderId',NEW.exchange_order_id,'filledHundredths',NEW.filled_hundredths::text,
 'terminal',NEW.terminal,'cancelAttempted',NEW.cancel_attempted,'policyHash',NEW.policy_hash,
 'dispatchAt',NEW.dispatch_at));
 RETURN NEW;
END $$;
CREATE FUNCTION private.strata_v13_capture_event() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i public.v13_production_intent; source_id text;
BEGIN
 SELECT * INTO STRICT i FROM public.v13_production_intent
  WHERE id=NEW.intent_id AND account_id=NEW.account_id;
 source_id:=i.evaluation_id;
 IF source_id IS NULL THEN SELECT evaluation_id INTO source_id
  FROM public.v13_production_intent WHERE id=i.parent_id AND account_id=i.account_id; END IF;
 INSERT INTO private.strata_v13_execution_trace
 (execution_account_id,evaluation_id,intent_id,client_order_id,kind,details)
 VALUES(NEW.account_id,source_id,i.id,i.client_order_id,'EXCHANGE_EVENT',
 jsonb_build_object('eventId',NEW.event_id,'eventKind',NEW.kind,'digest',NEW.digest,
 'cashDeltaMicros',NEW.cash_delta_micros::text,'pnlMicros',NEW.pnl_micros::text,
 'occurredAt',NEW.occurred_at));
 RETURN NEW;
END $$;
CREATE FUNCTION private.strata_v13_capture_transport() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i public.v13_production_intent; source_id text;
BEGIN
 IF NEW.kind NOT IN ('POST_ATTEMPT','POST_UNCERTAIN','PROVEN_NOT_POSTED','CANCEL_ATTEMPT') THEN RETURN NEW; END IF;
 SELECT * INTO STRICT i FROM public.v13_production_intent
  WHERE id=NEW.payload->>'id' AND account_id=NEW.account_id;
 source_id:=i.evaluation_id;
 IF source_id IS NULL THEN SELECT evaluation_id INTO source_id
  FROM public.v13_production_intent WHERE id=i.parent_id AND account_id=i.account_id; END IF;
 INSERT INTO private.strata_v13_execution_trace
 (execution_account_id,evaluation_id,intent_id,client_order_id,kind,details)
 VALUES(NEW.account_id,source_id,i.id,i.client_order_id,'TRANSPORT_OBSERVATION',
 jsonb_build_object('observationId',NEW.id,'observationKind',NEW.kind,'digest',NEW.digest,
 'outcome',NEW.payload->>'outcome'));
 RETURN NEW;
END $$;
CREATE TRIGGER strata_v13_capture_transport AFTER INSERT ON public.v13_production_observation
 FOR EACH ROW EXECUTE FUNCTION private.strata_v13_capture_transport();
CREATE TRIGGER strata_v13_capture_intent AFTER INSERT OR UPDATE ON public.v13_production_intent
 FOR EACH ROW EXECUTE FUNCTION private.strata_v13_capture_intent();
CREATE TRIGGER strata_v13_capture_event AFTER INSERT ON public.v13_production_event
 FOR EACH ROW EXECUTE FUNCTION private.strata_v13_capture_event();
CREATE TRIGGER strata_v13_execution_trace_immutable BEFORE UPDATE OR DELETE ON private.strata_v13_execution_trace
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_approval_audit_immutable();
CREATE TRIGGER strata_v13_trace_scope_immutable BEFORE UPDATE OR DELETE ON private.strata_v13_signal_trace_scope
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_approval_audit_immutable();
ALTER TABLE private.strata_v13_execution_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_v13_signal_trace_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_v13_execution_trace,private.strata_v13_signal_trace_scope
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE private.strata_v13_execution_trace_trace_id_seq FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.strata_v13_capture_intent(),private.strata_v13_capture_event(),private.strata_v13_capture_transport()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS forward_test_live_crosses ON public.forward_test_evaluations(evaluated_at,id)
 WHERE evaluation_source='paper' AND qualifying_trigger=true AND fresh_cross=true AND signal IN ('SCOUT','CONFIRM');
COMMIT;
