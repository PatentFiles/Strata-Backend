-- REVIEW-REQUIRED: immutable exchange-reconciled IOC evidence.
-- No execution, approvals, secrets, or trade permission are created.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_protective_exit_reconciliations (
  reservation_id uuid PRIMARY KEY
    REFERENCES private.strata_emergency_exit_reservations(reservation_id),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
  client_order_id text NOT NULL UNIQUE,
  market_ticker text NOT NULL,
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  filled_hundredths bigint NOT NULL CHECK(filled_hundredths >= 0),
  remaining_hundredths bigint NOT NULL CHECK(remaining_hundredths >= 0),
  observed_position_fp text NOT NULL
    CHECK(observed_position_fp ~ '^-?[0-9]{1,9}\.[0-9]{2}$'),
  reconciled_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION private.strata_protective_exit_reconciliation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'protective exit reconciliations are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS strata_protective_exit_reconciliation_guard
 ON private.strata_protective_exit_reconciliations;
CREATE TRIGGER strata_protective_exit_reconciliation_guard
 BEFORE UPDATE OR DELETE ON private.strata_protective_exit_reconciliations
 FOR EACH ROW EXECUTE FUNCTION private.strata_protective_exit_reconciliation_guard();
ALTER TABLE private.strata_protective_exit_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_protective_exit_reconciliations FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.strata_protective_exit_reconciliation_guard()
 FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE private.strata_protective_exit_reconciliations IS
 'Immutable authenticated exit outcome only. Exactly one per original reservation; no retry and no execution authority.';
COMMIT;
