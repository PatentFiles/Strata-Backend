-- Preserve the original consent, immutability and deadline guards.
-- Signed recovery can leave a released, disarmed lease under an account KILL.
-- This permits renewal, not activation, ARM or START. No records are rewritten.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='12000ms';
CREATE OR REPLACE FUNCTION private.durable_fee_release_authorization_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'durable release history retained';END IF;
 IF TG_OP='INSERT' AND NEW.state<>'PENDING' THEN RAISE EXCEPTION 'durable release must begin pending';END IF;
 IF TG_OP='UPDATE' AND (OLD.state<>'PENDING' OR NEW.state NOT IN('RECORDED','REJECTED') OR
 (to_jsonb(OLD)-'state'-'reason'-'resolved_at'-'signed_deadline'-'market_deadline') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'reason'-'resolved_at'-'signed_deadline'-'market_deadline')) THEN RAISE EXCEPTION 'durable release immutable core or terminal state';END IF;
 IF NEW.state<>'RECORDED' AND (NEW.signed_deadline IS NOT NULL OR NEW.market_deadline IS NOT NULL) THEN RAISE EXCEPTION 'no evidence deadlines on incomplete authorization';END IF;
 IF NEW.state='REJECTED' THEN RETURN NEW;END IF;
 PERFORM 1 FROM private.strata_durable_owner_fee_model m
 JOIN private.strata_durable_owner_fee_state s USING(model_id)
 JOIN private.strata_durable_historical_baseline b ON b.baseline_id=m.historical_baseline_id
 JOIN public.v13_production_account a ON a.id=m.execution_account_id AND a.owner_user_id=m.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE m.model_id=NEW.model_id AND m.owner_user_id=NEW.owner_user_id AND m.execution_account_id=NEW.execution_account_id
 AND m.release_commit_sha=NEW.original_release_sha AND m.approved_policy_hash=NEW.policy_hash
 AND m.official_source_digest=NEW.source_digest AND m.source_kind='OWNER_ATTESTED_HISTORICAL_BASELINE'
 AND m.policy_version='owner_attested_historical_terms_v1' AND m.genuine_source_verified=false AND m.source_capture_id IS NULL
 AND b.content_sha256=m.official_source_digest AND b.formula_version=m.formula_version AND b.effective_date=m.effective_date
 AND s.entry_revoked=false AND s.known_publication_change=false AND p.state='APPROVED' AND p.policy_hash=m.approved_policy_hash
 AND p.fee_source_url='strata-durable-owner-fee://'||m.model_id::text AND p.fee_policy_version=m.policy_version AND p.fee_formula_version=m.formula_version
 AND a.fee_artifact_digest=m.official_source_digest AND a.commissioned=true AND a.execution_enabled=false AND a.kill_switch=true AND a.blocked_reason IS NULL
 AND a.reserved_micros=0 AND a.subaccount=1 AND a.exchange_index=2
 AND EXISTS(SELECT 1 FROM private.kalshi_account_worker_lease w WHERE w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id AND w.arm_requested=false AND ((w.state='killed' AND w.account_kill=true) OR (w.state='released' AND w.account_kill=false)) FOR SHARE OF w)
 AND NOT EXISTS(SELECT 1 FROM private.strata_railway_official_fee_capture_v5 c WHERE c.execution_account_id=a.id AND c.content_sha256<>m.official_source_digest)
 FOR SHARE OF m,s,a,p;
 IF NOT FOUND THEN RAISE EXCEPTION 'durable release exact historical stopped scope unavailable';END IF;
 RETURN NEW;
END $$;
COMMIT;
