CREATE SCHEMA IF NOT EXISTS private;

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

CREATE TRIGGER strata_v13_capture_intent AFTER INSERT OR UPDATE ON public.v13_production_intent
 FOR EACH ROW EXECUTE FUNCTION private.strata_v13_capture_intent();
