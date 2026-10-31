-- REVIEW REQUIRED. Apply before deploying the owned local-no-send finalizer.
-- No exchange evidence, approval or trading authority is created.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_protective_exit_local_no_send (
 reservation_id uuid PRIMARY KEY REFERENCES private.strata_emergency_exit_reservations(reservation_id),
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 client_order_id text NOT NULL UNIQUE,
 order_digest text NOT NULL CHECK(order_digest ~ '^[0-9a-f]{64}$'),
 signer_fingerprint text NOT NULL CHECK(signer_fingerprint ~ '^[0-9a-f]{64}$'),
 market_ticker text NOT NULL,
 reducing_side text NOT NULL CHECK(reducing_side IN ('YES','NO')),
 quantity_hundredths bigint NOT NULL CHECK(quantity_hundredths>0),
 limit_micros bigint NOT NULL CHECK(limit_micros>0 AND limit_micros<1000000),
 worker_holder_id text NOT NULL,
 worker_fencing_token bigint NOT NULL CHECK(worker_fencing_token>0),
 reason text NOT NULL CHECK(reason IN ('final_evidence_expired','final_fee_rejected','final_fee_unavailable')),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION private.strata_protective_exit_local_no_send_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'protective exit local no-send audit is immutable' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM private.strata_emergency_exit_reservations r
  JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
  JOIN public.v13_production_intent i ON i.account_id=r.execution_account_id AND i.client_order_id=r.client_order_id
  JOIN public.v13_production_position pos ON pos.id=i.parent_id AND pos.account_id=i.account_id
  JOIN public.v13_production_intent parent ON parent.id=i.parent_id AND parent.account_id=i.account_id
  JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=r.execution_account_id AND w.owner_user_id=r.owner_user_id
  WHERE r.reservation_id=NEW.reservation_id AND r.owner_user_id=NEW.owner_user_id
   AND r.execution_account_id=NEW.execution_account_id AND r.client_order_id=NEW.client_order_id
   AND r.order_digest=NEW.order_digest AND r.worker_holder_id=NEW.worker_holder_id
   AND r.worker_fencing_token=NEW.worker_fencing_token AND r.state='UNKNOWN' AND r.trading_authorized=false
   AND w.holder_id=NEW.worker_holder_id AND w.fencing_token=NEW.worker_fencing_token AND w.state='owned'
   AND w.credential_fingerprint=NEW.signer_fingerprint AND a.key_fingerprint=NEW.signer_fingerprint
   AND a.subaccount=1 AND a.exchange_index=2
   AND i.market=r.market_ticker AND i.request->>'clientOrderId'=r.client_order_id
   AND i.request->>'reduceOnly'='true' AND i.request->>'action'='SELL' AND i.request->>'timeInForce'='IOC'
   AND r.market_ticker=NEW.market_ticker AND r.reducing_side=NEW.reducing_side AND r.quantity_hundredths=NEW.quantity_hundredths
   AND i.request->>'market'=r.market_ticker AND i.side=r.reducing_side AND i.request->>'side'=r.reducing_side
   AND i.request->>'contracts' ~ '^[0-9]{1,9}$' AND (i.request->>'contracts')::bigint*100=r.quantity_hundredths
   AND i.request->>'limitMicros'=NEW.limit_micros::text
   AND pos.market=r.market_ticker AND pos.side=r.reducing_side AND pos.quantity_hundredths>=r.quantity_hundredths
   AND parent.kind='ENTRY' AND parent.terminal=true
   AND i.kind='EXIT' AND i.state='DISPATCHED' AND i.terminal=false
   AND i.exchange_order_id IS NULL AND i.filled_hundredths=0 AND i.reserved_micros=0
 ) THEN RAISE EXCEPTION 'local no-send scope or state mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS strata_protective_exit_local_no_send_guard ON private.strata_protective_exit_local_no_send;
CREATE TRIGGER strata_protective_exit_local_no_send_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private.strata_protective_exit_local_no_send FOR EACH ROW EXECUTE FUNCTION private.strata_protective_exit_local_no_send_guard();
ALTER TABLE private.strata_protective_exit_local_no_send ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_protective_exit_local_no_send FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.strata_protective_exit_local_no_send_guard() FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_protective_exit_local_no_send IS
 'Immutable trusted-backend exact-invocation non-submission audit; NOT authenticated exchange reconciliation or permission to replay an old order.';
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
       OR (OLD.state='UNKNOWN' AND NEW.state='RECONCILED' AND NOT EXISTS (
         SELECT 1 FROM private.strata_protective_exit_local_no_send n WHERE n.reservation_id=OLD.reservation_id))
       OR (OLD.state='UNKNOWN' AND NEW.state='VOID' AND EXISTS (
         SELECT 1 FROM private.strata_protective_exit_local_no_send n
         JOIN public.v13_production_intent i ON i.account_id=n.execution_account_id AND i.client_order_id=n.client_order_id
         WHERE n.reservation_id=OLD.reservation_id AND n.owner_user_id=OLD.owner_user_id
          AND n.execution_account_id=OLD.execution_account_id AND n.client_order_id=OLD.client_order_id
          AND n.order_digest=OLD.order_digest AND n.worker_holder_id=OLD.worker_holder_id
          AND n.worker_fencing_token=OLD.worker_fencing_token
          AND i.kind='EXIT' AND i.state='BLOCKED' AND i.terminal=true
          AND i.exchange_order_id IS NULL AND i.filled_hundredths=0 AND i.reserved_micros=0))) THEN
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
REVOKE ALL ON FUNCTION private.strata_emergency_exit_transition_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
