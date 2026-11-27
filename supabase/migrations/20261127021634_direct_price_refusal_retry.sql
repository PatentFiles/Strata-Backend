-- Preserve every source/intent. One NEW crossing after a proven pre-intent price
-- refusal; never a wire retry. Deploy only with the matching qualified binary.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.strata_direct_entry_source ADD COLUMN entry_generation smallint NOT NULL DEFAULT 1 CHECK(entry_generation IN (1,2));
CREATE UNIQUE INDEX strata_direct_entry_source_generation_unique ON public.strata_direct_entry_source(account_id,crossing_key,entry_generation);
CREATE TABLE private.strata_direct_price_refusal (
 source_id text PRIMARY KEY,
 account_id text NOT NULL,
 crossing_key text NOT NULL,
 owner_user_id uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 release_sha text NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40}$'),
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
 reference_micros bigint NOT NULL CHECK(reference_micros>0 AND reference_micros<1000000),
 best_ask_micros bigint NOT NULL CHECK(best_ask_micros>reference_micros AND best_ask_micros<1000000),
 reason text NOT NULL CHECK(reason='live_money_best_ask_above_signal_ceiling'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(source_id,account_id,crossing_key) REFERENCES public.strata_direct_entry_source(id,account_id,crossing_key)
);
CREATE UNIQUE INDEX strata_direct_price_refusal_one_per_market ON private.strata_direct_price_refusal(account_id,crossing_key);
ALTER TABLE private.strata_direct_price_refusal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_direct_price_refusal FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_paper_runtime') THEN REVOKE ALL ON private.strata_direct_price_refusal FROM strata_paper_runtime; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
  GRANT SELECT,INSERT ON private.strata_direct_price_refusal TO strata_api_runtime;
  CREATE POLICY strata_price_refusal_api ON private.strata_direct_price_refusal TO strata_api_runtime USING(true) WITH CHECK(true);
 END IF;
END $$;

-- Invoker rights only. The existing trusted worker owns the account lock;
-- no new login, security-definer grant or client callable write is introduced.
CREATE FUNCTION private.strata_price_retry_scope_valid(account text,pin jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=a.kalshi_connection_id
  AND c.provider_connection_id=w.provider_connection_id AND c.vault_secret_id=w.vault_secret_id
  AND c.key_fingerprint=w.credential_fingerprint
 WHERE a.id=account AND a.owner_user_id IS NOT NULL AND a.subaccount=1 AND a.exchange_index=2
  AND w.financial_account_id=a.kalshi_connection_id AND a.commissioned AND a.cash_precision_verified
  AND a.execution_enabled AND NOT a.kill_switch AND a.blocked_reason IS NULL AND a.reserved_micros=0
  AND w.state='owned' AND w.arm_requested AND NOT w.account_kill
  AND w.holder_id=pin->>'holderId' AND w.fencing_token::text=pin->>'fencingToken'
  AND w.credential_fingerprint=pin->>'credentialFingerprint' AND a.key_fingerprint=w.credential_fingerprint
  AND w.heartbeat_at BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp()
  AND c.role='restricted_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
  AND c.verification_reason='credential_verified'
  AND NOT EXISTS(SELECT 1 FROM public.v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths<>0)
  AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=a.id
   AND (i.reserved_micros<>0 OR (i.state NOT IN ('TERMINAL','BLOCKED')
    AND NOT private.strata_has_economic_exit_discharge(i.account_id,i.client_order_id)))))
$$;
CREATE FUNCTION private.strata_direct_price_refusal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s public.strata_direct_entry_source%ROWTYPE; data jsonb; matched boolean;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'direct_price_refusal_immutable'; END IF;
 -- Same lock order as PREPARE and source admission: account then source proof.
 PERFORM 1 FROM public.v13_production_account WHERE id=NEW.account_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'direct_price_refusal_owner_mismatch'; END IF;
 SELECT * INTO STRICT s FROM public.strata_direct_entry_source WHERE id=NEW.source_id AND account_id=NEW.account_id;
 data:=s.evidence_bytes::jsonb;
 IF data->>'priceRetryProtocol' IS DISTINCT FROM 'PRICE_REFUSAL_V1'
  OR s.entry_generation<>1 OR data->'source'->>'price_retry_of' IS NOT NULL
  OR s.crossing_key<>NEW.crossing_key OR s.evidence_sha256<>NEW.source_sha256
  OR data->>'owner' IS DISTINCT FROM NEW.owner_user_id::text
  OR data->'source'->'worker_pin'->>'releaseSha' IS DISTINCT FROM NEW.release_sha
  OR (data->'source'->>'entry_offer')::numeric*1000000 IS DISTINCT FROM NEW.reference_micros
  OR clock_timestamp()<s.observed_at OR clock_timestamp()>=s.closes_at
  OR clock_timestamp()-s.oldest_source_at>interval '5 seconds'
  OR NOT private.strata_price_retry_scope_valid(NEW.account_id,data->'source'->'worker_pin')
  OR EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=NEW.account_id AND i.crossing_key=NEW.crossing_key)
 THEN RAISE EXCEPTION 'direct_price_refusal_not_proven'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id
  WHERE a.id=NEW.account_id AND p.execution_account_id=a.id AND p.state='APPROVED'
   AND p.policy_hash=NEW.policy_hash AND p.created_by=NEW.owner_user_id::text AND p.approved_by=NEW.owner_user_id::text) INTO matched;
 IF NOT matched THEN RAISE EXCEPTION 'direct_price_refusal_policy_changed'; END IF;
 NEW.recorded_at:=clock_timestamp(); -- never accept a caller-backdated refusal
 RETURN NEW;
END $$;
CREATE TRIGGER strata_direct_price_refusal_guard BEFORE INSERT OR UPDATE OR DELETE ON private.strata_direct_price_refusal
 FOR EACH ROW EXECUTE FUNCTION private.strata_direct_price_refusal_guard();

CREATE FUNCTION private.strata_direct_price_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE previous public.strata_direct_entry_source%ROWTYPE; n integer; data jsonb; old_data jsonb;
BEGIN
 PERFORM 1 FROM public.v13_production_account WHERE id=NEW.account_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT count(*) INTO n FROM (SELECT 1 FROM public.strata_direct_entry_source WHERE account_id=NEW.account_id AND crossing_key=NEW.crossing_key LIMIT 2) q;
 IF n=0 THEN NEW.entry_generation:=1; RETURN NEW; END IF;
 IF n<>1 THEN RETURN NULL; END IF;
 SELECT * INTO STRICT previous FROM public.strata_direct_entry_source WHERE account_id=NEW.account_id AND crossing_key=NEW.crossing_key;
 data:=NEW.evidence_bytes::jsonb;old_data:=previous.evidence_bytes::jsonb;
 IF data->>'priceRetryProtocol' IS DISTINCT FROM 'PRICE_REFUSAL_V1'
  OR old_data->>'priceRetryProtocol' IS DISTINCT FROM 'PRICE_REFUSAL_V1'
  OR data->'source'->>'price_retry_of' IS DISTINCT FROM previous.id
  OR data->>'owner' IS DISTINCT FROM old_data->>'owner'
  OR data->'source'->'worker_pin' IS DISTINCT FROM old_data->'source'->'worker_pin'
  OR NEW.market_ticker<>previous.market_ticker OR NEW.closes_at<>previous.closes_at
  OR NEW.observed_at<=previous.observed_at OR NEW.oldest_source_at<=previous.observed_at
  OR clock_timestamp()<NEW.observed_at OR clock_timestamp()>=NEW.closes_at
  OR clock_timestamp()-NEW.oldest_source_at>interval '5 seconds'
  OR NOT private.strata_price_retry_scope_valid(NEW.account_id,data->'source'->'worker_pin')
  OR EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=NEW.account_id AND i.crossing_key=NEW.crossing_key)
  OR NOT EXISTS(SELECT 1 FROM private.strata_direct_price_refusal r WHERE r.source_id=previous.id
    AND r.account_id=NEW.account_id AND r.source_sha256=previous.evidence_sha256
    AND r.owner_user_id::text=data->>'owner' AND r.release_sha=data->'source'->'worker_pin'->>'releaseSha'
    AND r.recorded_at<NEW.oldest_source_at)
 THEN RETURN NULL; END IF;
 NEW.entry_generation:=2;
 RETURN NEW;
END $$;
-- Observation uniqueness becomes a guarded two-generation admission. The
-- FINANCIAL account+crossing uniqueness on v13_production_intent is untouched.
ALTER TABLE public.strata_direct_entry_source DROP CONSTRAINT strata_direct_entry_source_account_id_crossing_key_key;
-- The generation unique index also covers the account/crossing lookup.
CREATE TRIGGER strata_direct_price_source_guard BEFORE INSERT ON public.strata_direct_entry_source
 FOR EACH ROW EXECUTE FUNCTION private.strata_direct_price_source_guard();
CREATE FUNCTION private.strata_direct_price_intent_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.kind='ENTRY' AND NEW.direct_source_id IS NOT NULL THEN
  PERFORM 1 FROM public.v13_production_account WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM private.strata_direct_price_refusal r WHERE r.source_id=NEW.direct_source_id)
  THEN RAISE EXCEPTION 'direct_price_refused_source_retired'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_direct_price_intent_guard BEFORE INSERT ON public.v13_production_intent
 FOR EACH ROW EXECUTE FUNCTION private.strata_direct_price_intent_guard();
REVOKE ALL ON FUNCTION private.strata_price_retry_scope_valid(text,jsonb),private.strata_direct_price_refusal_guard(),
 private.strata_direct_price_source_guard(),private.strata_direct_price_intent_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
 GRANT EXECUTE ON FUNCTION private.strata_price_retry_scope_valid(text,jsonb),private.strata_direct_price_refusal_guard(),
 private.strata_direct_price_source_guard(),private.strata_direct_price_intent_guard() TO strata_api_runtime;
END IF; END $$;
COMMIT;
