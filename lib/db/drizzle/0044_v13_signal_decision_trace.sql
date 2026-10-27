-- Candidate schema; apply only after signed controlled cutover.
-- No trading authority and no orders originate from this audit ledger.
BEGIN;
CREATE TABLE IF NOT EXISTS private.strata_v13_signal_decisions (
 decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 execution_account_id text NOT NULL,
 evaluation_id uuid NOT NULL REFERENCES public.forward_test_evaluations(id),
 observed_at timestamptz NOT NULL DEFAULT now(),
 phase text NOT NULL CHECK (phase IN (
  'QUALIFYING_SEEN','PREPARE_REJECTED','ENTRY_PREPARED',
  'DISPATCH_COMPLETED','DISPATCH_REJECTED','STALE_AT_WORKER','UNSEEN_IN_WINDOW')),
 source_age_ms integer,
 reason text CHECK (reason IS NULL OR length(reason) <= 128),
 release_commit_sha text NOT NULL CHECK (release_commit_sha ~ '^[a-f0-9]{40}$'),
 UNIQUE(execution_account_id,evaluation_id,phase)
);
CREATE INDEX IF NOT EXISTS strata_v13_decisions_account_idx
 ON private.strata_v13_signal_decisions(execution_account_id,observed_at DESC);
ALTER TABLE private.strata_v13_signal_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_v13_signal_decisions FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE private.strata_v13_signal_decisions_decision_id_seq FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
