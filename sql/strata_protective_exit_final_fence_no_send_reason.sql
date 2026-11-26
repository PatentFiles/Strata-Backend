-- REVIEW REQUIRED. Deploy only with matching application readback and
-- tests. No approval, exchange evidence, activation or trading authorization.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE private.strata_protective_exit_local_no_send
 DROP CONSTRAINT strata_protective_exit_local_no_send_reason_check,
 ADD CONSTRAINT strata_protective_exit_local_no_send_reason_check
 CHECK(reason IN ('final_evidence_expired','final_fee_rejected','final_fee_unavailable',
                  'final_fence_no_exact_row_before_commit'));
COMMIT;
