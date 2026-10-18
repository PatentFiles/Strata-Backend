-- REVIEW-ONLY MIGRATION: emergency exit PREPARATION ledger.
-- This does not authorize a POST, provide a fee grant, change any kill switch
-- or turn on execution. Apply ONLY after independent migration security review.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_emergency_exit_reservations (
  reservation_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  market_ticker text NOT NULL CHECK (market_ticker ~ '^KXBTC15M-[A-Za-z0-9-]+$'),
  client_order_id text NOT NULL UNIQUE
    CHECK (client_order_id ~ '^v13p-[a-f0-9-]{36}$'),
  reducing_side text NOT NULL CHECK (reducing_side IN ('YES','NO')),
  quantity_hundredths bigint NOT NULL CHECK (quantity_hundredths > 0),
  order_digest text NOT NULL CHECK (order_digest ~ '^[0-9a-f]{64}$'),
  worker_fencing_token bigint NOT NULL CHECK (worker_fencing_token > 0),
  worker_holder_id text NOT NULL CHECK (length(worker_holder_id) BETWEEN 1 AND 128),
  state text NOT NULL DEFAULT 'PREPARED'
    CHECK (state IN ('PREPARED','DISPATCHED','UNKNOWN','RECONCILED','VOID')),
  -- Not order authorization: preparing evidence NEVER grants execution.
  trading_authorized boolean NOT NULL DEFAULT false CHECK (trading_authorized=false),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A privileged backend role must never reset an attempted exit to PREPARED
-- or rewrite its fixed order/reservation identity. PREPARED is a diagnostic
-- reservation, not authorization to submit an order.
CREATE OR REPLACE FUNCTION private.strata_emergency_exit_transition_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $exit_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'emergency-exit audit reservations cannot be deleted'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PREPARED' OR NEW.trading_authorized <> false THEN
      RAISE EXCEPTION 'emergency-exit reservation must begin unarmed'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.reservation_id,NEW.owner_user_id,NEW.execution_account_id,
         NEW.market_ticker,NEW.client_order_id,NEW.reducing_side,
         NEW.quantity_hundredths,NEW.order_digest,NEW.worker_fencing_token,
         NEW.worker_holder_id,NEW.trading_authorized,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.reservation_id,OLD.owner_user_id,OLD.execution_account_id,
         OLD.market_ticker,OLD.client_order_id,OLD.reducing_side,
         OLD.quantity_hundredths,OLD.order_digest,OLD.worker_fencing_token,
         OLD.worker_holder_id,OLD.trading_authorized,OLD.created_at) THEN
    RAISE EXCEPTION 'emergency-exit reservation identity is immutable'
      USING ERRCODE='23514';
  END IF;
  IF NOT ((OLD.state='PREPARED' AND NEW.state IN ('UNKNOWN','VOID'))
       OR (OLD.state='UNKNOWN' AND NEW.state='RECONCILED')) THEN
    RAISE EXCEPTION 'emergency-exit state regression or unauthorized transition'
      USING ERRCODE='23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'emergency-exit updated_at cannot regress'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$exit_guard$;
DROP TRIGGER IF EXISTS strata_emergency_exit_transition_guard
  ON private.strata_emergency_exit_reservations;
CREATE TRIGGER strata_emergency_exit_transition_guard
  BEFORE INSERT OR UPDATE OR DELETE ON private.strata_emergency_exit_reservations
  FOR EACH ROW EXECUTE FUNCTION private.strata_emergency_exit_transition_guard();
REVOKE ALL ON FUNCTION private.strata_emergency_exit_transition_guard()
  FROM PUBLIC, anon, authenticated;

CREATE UNIQUE INDEX IF NOT EXISTS strata_emergency_exit_single_unresolved_market
ON private.strata_emergency_exit_reservations(execution_account_id,market_ticker)
WHERE state IN ('PREPARED','DISPATCHED','UNKNOWN');

ALTER TABLE private.strata_emergency_exit_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_emergency_exit_reservations FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_emergency_exit_reservations IS
'Private recovery reservation/audit ledger. A PREPARED row has no trading authority; no public write access.';
COMMIT;
