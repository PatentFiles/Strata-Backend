-- OPTIONAL ORDERS-OFF REVIEW ARTIFACT. Do not add to an automatic migration
-- journal. This restriction wraps retry-candidate.sql; it does not activate it.
BEGIN;
CREATE TABLE private.strata_direct_retry_release (
 account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),
 owner_id uuid NOT NULL,
 release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
 receipt_enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.strata_direct_retry_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_direct_retry_release FROM PUBLIC;

CREATE FUNCTION private.strata_record_worker_first_market_fee_refusal(
 a text, o uuid, release text, holder text, fence bigint, fingerprint text,
 k text, s text, h text
) RETURNS boolean SECURITY DEFINER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM 1 FROM public.v13_production_account
 WHERE id=a AND owner_user_id=o AND key_fingerprint=fingerprint AND kill_switch=false AND execution_enabled=true FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM private.strata_direct_retry_release r
 WHERE r.account_id=a AND r.owner_id=o AND r.release_sha=release AND r.receipt_enabled FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM private.kalshi_account_worker_lease l
 JOIN public.v13_production_account ac ON ac.id=l.execution_account_id AND ac.owner_user_id=l.owner_user_id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=ac.owner_user_id AND c.financial_account_id=ac.kalshi_connection_id
   AND c.provider_connection_id=l.provider_connection_id AND c.vault_secret_id=l.vault_secret_id AND c.key_fingerprint=l.credential_fingerprint
 WHERE l.execution_account_id=a AND l.owner_user_id=o AND l.holder_id=holder AND l.fencing_token=fence
  AND l.credential_fingerprint=fingerprint AND l.state='owned' AND NOT l.account_kill AND l.arm_requested
  AND l.heartbeat_at BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp()
  AND c.role='restricted_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 FOR SHARE OF l,c;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN public.strata_record_first_market_fee_refusal(a,k,s,h);
END $$;
REVOKE ALL ON FUNCTION private.strata_record_worker_first_market_fee_refusal(text,uuid,text,text,bigint,text,text,text,text) FROM PUBLIC;
-- Grant the *wrapper only* after the DB role and exact-worker process boundary
-- have been reviewed. No grant to the generic API/worker or any PUBLIC role.
COMMIT;
