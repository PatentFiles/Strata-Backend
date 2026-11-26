-- Additive immutable accounting receipt. No transfer, trade, policy or kill-switch change.
BEGIN;
SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='12000ms';
CREATE TABLE private.strata_capital_credit_repair(
 repair_id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 release_commit_sha text NOT NULL CHECK(release_commit_sha~'^[a-f0-9]{40}$'),
 receipt_id text NOT NULL CHECK(receipt_id~'^[A-Za-z0-9_-]{8,128}$'),
 scope_digest text NOT NULL CHECK(scope_digest~'^[a-f0-9]{64}$'),scope jsonb NOT NULL,
 FOREIGN KEY(execution_account_id,owner_user_id) REFERENCES public.v13_production_account(id,owner_user_id),
 confirmation text NOT NULL CHECK(confirmation='I_RECORD_THIS_VERIFIED_PAST_FUNDING_CREDIT_AS_CAPITAL_NOT_PROFIT_V1'),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','RECORDED','REJECTED')),
 reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),resolved_at timestamptz,evidence_deadline timestamptz,
 CHECK(jsonb_typeof(scope)='object' AND scope ?& ARRAY['ownerId','accountId','sha','policyHash','checkpointId','checkpointDigest','receiptId','receiptDigest','receiptCreatedAt','oldInitialCashMicros','newInitialCashMicros','cashMicros','accountRevision','scopeDigest','amountCents'] AND
 jsonb_typeof(scope->'ownerId')='string' AND jsonb_typeof(scope->'accountId')='string' AND jsonb_typeof(scope->'sha')='string' AND jsonb_typeof(scope->'policyHash')='string' AND jsonb_typeof(scope->'checkpointId')='string' AND jsonb_typeof(scope->'checkpointDigest')='string' AND jsonb_typeof(scope->'receiptId')='string' AND jsonb_typeof(scope->'receiptDigest')='string' AND jsonb_typeof(scope->'receiptCreatedAt')='string' AND jsonb_typeof(scope->'oldInitialCashMicros')='string' AND jsonb_typeof(scope->'newInitialCashMicros')='string' AND jsonb_typeof(scope->'cashMicros')='string' AND jsonb_typeof(scope->'accountRevision')='string' AND jsonb_typeof(scope->'scopeDigest')='string' AND jsonb_typeof(scope->'amountCents')='number'),
 CHECK(scope->>'ownerId'=owner_user_id::text AND scope->>'accountId'=execution_account_id AND scope->>'sha'=release_commit_sha AND scope->>'receiptId'=receipt_id AND scope->>'scopeDigest'=scope_digest),
 CHECK((state='PENDING' AND reason IS NULL AND resolved_at IS NULL AND evidence_deadline IS NULL) OR
 (state='REJECTED' AND reason IS NOT NULL AND resolved_at IS NOT NULL AND evidence_deadline IS NULL) OR
 (state='RECORDED' AND reason IS NOT NULL AND resolved_at IS NOT NULL AND evidence_deadline IS NOT NULL))
);
CREATE UNIQUE INDEX capital_credit_one_receipt ON private.strata_capital_credit_repair(owner_user_id,receipt_id) WHERE state IN('PENDING','RECORDED');
CREATE UNIQUE INDEX capital_credit_one_pending_account ON private.strata_capital_credit_repair(execution_account_id) WHERE state='PENDING';
CREATE FUNCTION private.capital_credit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'capital credit history retained';END IF;
 IF TG_OP='INSERT' AND NOT(NEW.state='PENDING' OR (NEW.state='REJECTED' AND NEW.reason='capital_owner_canceled_exact_repair')) THEN RAISE EXCEPTION 'capital credit must begin pending or canceled';END IF;
 IF TG_OP='UPDATE' AND (OLD.state<>'PENDING' OR NEW.state NOT IN('RECORDED','REJECTED') OR
 (to_jsonb(OLD)-'state'-'reason'-'resolved_at'-'evidence_deadline') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'reason'-'resolved_at'-'evidence_deadline')) THEN RAISE EXCEPTION 'capital credit immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capital_credit_immutable BEFORE INSERT OR UPDATE OR DELETE ON private.strata_capital_credit_repair FOR EACH ROW EXECUTE FUNCTION private.capital_credit_immutable();
CREATE FUNCTION private.capital_credit_commit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.v13_production_account%ROWTYPE;ec bigint;ep bigint;pb bigint;pp bigint;ir bigint;
BEGIN
 IF NEW.state<>'RECORDED' THEN RETURN NEW;END IF;
 IF NEW.evidence_deadline<clock_timestamp() OR NEW.evidence_deadline>clock_timestamp()+interval '15 seconds' THEN RAISE EXCEPTION 'capital evidence expired';END IF;
 SELECT * INTO a FROM public.v13_production_account WHERE id=NEW.execution_account_id AND owner_user_id=NEW.owner_user_id;
 IF NOT FOUND OR a.initial_cash_micros::text<>NEW.scope->>'newInitialCashMicros' OR a.cash_micros::text<>NEW.scope->>'cashMicros' OR a.revision<>(NEW.scope->>'accountRevision')::bigint+1 OR a.execution_enabled OR NOT a.kill_switch OR a.blocked_reason IS NOT NULL OR a.reserved_micros<>0 THEN RAISE EXCEPTION 'capital account changed';END IF;
 IF (NEW.scope->>'amountCents')::bigint<=0 OR (NEW.scope->>'amountCents')::bigint>2500000 OR (NEW.scope->>'newInitialCashMicros')::bigint<>(NEW.scope->>'oldInitialCashMicros')::bigint+(NEW.scope->>'amountCents')::bigint*10000 THEN RAISE EXCEPTION 'capital amount mismatch';END IF;
 SELECT coalesce(sum(cash_delta_micros),0),coalesce(sum(pnl_micros),0) INTO ec,ep FROM public.v13_production_event WHERE account_id=a.id;
 SELECT coalesce(sum(basis_micros),0),coalesce(sum(realized_pnl_micros),0) INTO pb,pp FROM public.v13_production_position WHERE account_id=a.id;
 SELECT coalesce(sum(reserved_micros),0) INTO ir FROM public.v13_production_intent WHERE account_id=a.id;
 IF a.cash_micros<>a.initial_cash_micros+ec OR a.cash_micros+pb<>a.initial_cash_micros+ep OR pp<>ep OR ir<>a.reserved_micros THEN RAISE EXCEPTION 'capital conservation failed';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER capital_credit_commit_guard AFTER UPDATE ON private.strata_capital_credit_repair DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.capital_credit_commit_guard();
ALTER TABLE private.strata_capital_credit_repair ENABLE ROW LEVEL SECURITY;ALTER TABLE private.strata_capital_credit_repair FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_capital_credit_repair FROM PUBLIC,anon,authenticated;
COMMIT;
