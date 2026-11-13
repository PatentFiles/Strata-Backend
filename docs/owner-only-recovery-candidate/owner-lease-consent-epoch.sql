-- Review-only candidate. NOT a production migration. Lease-local version means
-- no extra lock ordering and does not change fencing/holding of protective exits.
ALTER TABLE private.kalshi_account_worker_lease ADD COLUMN consent_epoch bigint NOT NULL DEFAULT 0 CHECK(consent_epoch>=0);
CREATE FUNCTION private.advance_lease_consent_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.consent_epoch:=OLD.consent_epoch+1; RETURN NEW;
END $$;
CREATE TRIGGER strata_lease_control_epoch BEFORE UPDATE OF
 state,account_kill,arm_requested,fencing_token,holder_id,credential_fingerprint,
 vault_secret_id,provider_connection_id,financial_account_id,owner_user_id,consent_epoch
 ON private.kalshi_account_worker_lease FOR EACH ROW EXECUTE FUNCTION private.advance_lease_consent_epoch();
REVOKE ALL ON FUNCTION private.advance_lease_consent_epoch() FROM PUBLIC;
-- Every explicit control write, including same-value HOLD, advances epoch.
-- HEARTBEAT_LEASE_SQL only names heartbeat_at, so does not invalidate consent.
-- DELETE/reprovision and table replacement require separate lifecycle protection.
