-- REVIEW ONLY. Records explicit, owner-scoped technical plan approval at the
-- existing prepared -> attempted claim. No transfer, key, account, or order.
-- Existing journal rows and separately reviewed operation routes remain valid.
BEGIN;
ALTER TABLE private.kalshi_account_operation_attempts
 ADD COLUMN owner_technical_plan_digest text,
 ADD COLUMN owner_technical_authorized_at timestamptz,
 ADD CONSTRAINT kalshi_account_operation_owner_technical_approval_check CHECK (
  (owner_technical_plan_digest IS NULL AND owner_technical_authorized_at IS NULL)
  OR (owner_technical_plan_digest IS NOT NULL AND owner_technical_plan_digest ~ '^[a-f0-9]{64}$' AND owner_technical_authorized_at IS NOT NULL)
 );
-- Once an attempt has been claimed, the reviewed digest cannot be overwritten.
CREATE FUNCTION private.strata_owner_technical_approval_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $technical_approval$
BEGIN
 IF OLD.state <> 'prepared' AND
    ROW(OLD.owner_technical_plan_digest,OLD.owner_technical_authorized_at)
    IS DISTINCT FROM ROW(NEW.owner_technical_plan_digest,NEW.owner_technical_authorized_at)
 THEN RAISE EXCEPTION 'owner_technical_approval_immutable'; END IF;
 RETURN NEW;
END $technical_approval$;
REVOKE ALL ON FUNCTION private.strata_owner_technical_approval_immutable() FROM PUBLIC;
CREATE TRIGGER strata_owner_technical_approval_immutable BEFORE UPDATE ON private.kalshi_account_operation_attempts
 FOR EACH ROW EXECUTE FUNCTION private.strata_owner_technical_approval_immutable();
COMMIT;
