-- Apply AFTER strata_protective_exit_local_no_send.sql and BEFORE exact-quantity code.
-- Additive, backward-compatible EXIT request parser and audit trigger replacement.
-- No row rewrites, account/grant mutation or new trading authority.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
CREATE OR REPLACE FUNCTION private.strata_exit_request_quantity_hundredths(request jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SECURITY INVOKER SET search_path=pg_catalog AS $quantity$
DECLARE quantity bigint;
BEGIN
 IF jsonb_typeof(request)<>'object' OR request->>'action' IS DISTINCT FROM 'SELL'
    OR request->'reduceOnly' IS DISTINCT FROM 'true'::jsonb
    OR request->>'timeInForce' IS DISTINCT FROM 'IOC' THEN RETURN NULL; END IF;
 IF request ? 'quantityVersion' OR request ? 'quantityHundredths' THEN
  IF request->>'quantityVersion' IS DISTINCT FROM 'EXIT_HUNDREDTHS_V1'
     OR request ? 'contracts'
     OR jsonb_typeof(request->'quantityHundredths') IS DISTINCT FROM 'string'
     OR NOT (request->>'quantityHundredths' ~ '^[1-9][0-9]{0,5}$') THEN RETURN NULL; END IF;
  quantity:=(request->>'quantityHundredths')::bigint;
  IF quantity>100000 THEN RETURN NULL; END IF;
  RETURN quantity;
 END IF;
 IF jsonb_typeof(request->'contracts') IS DISTINCT FROM 'number'
    OR NOT (request->>'contracts' ~ '^[1-9][0-9]{0,8}$') THEN RETURN NULL; END IF;
 RETURN (request->>'contracts')::bigint*100;
END;
$quantity$;
REVOKE ALL ON FUNCTION private.strata_exit_request_quantity_hundredths(jsonb) FROM PUBLIC,anon,authenticated;
COMMENT ON FUNCTION private.strata_exit_request_quantity_hundredths(jsonb) IS
 'Strict EXIT-only quantity decoding; NULL rejects malformed/mixed/unsupported requests. No order authority.';
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
   AND private.strata_exit_request_quantity_hundredths(i.request)=r.quantity_hundredths
   AND i.request->>'limitMicros'=NEW.limit_micros::text
   AND pos.market=r.market_ticker AND pos.side=r.reducing_side AND pos.quantity_hundredths>=r.quantity_hundredths
   AND parent.kind='ENTRY' AND parent.terminal=true
   AND i.kind='EXIT' AND i.state='DISPATCHED' AND i.terminal=false
   AND i.exchange_order_id IS NULL AND i.filled_hundredths=0 AND i.reserved_micros=0
 ) THEN RAISE EXCEPTION 'local no-send scope or state mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION private.strata_protective_exit_local_no_send_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
