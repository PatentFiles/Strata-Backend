-- Local candidate: historical audit progress only; grants no trading authority.
BEGIN;
CREATE TABLE private.strata_v13_signal_audit_progress (
 execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),
 cycle_cutoff timestamptz,
 cursor_evaluated_at timestamptz,
 cursor_evaluation_id text,
 cycle_started_at timestamptz,
 last_success_at timestamptz,
 last_completed_cycle_at timestamptz,
 completed_cycles bigint NOT NULL DEFAULT 0 CHECK(completed_cycles>=0),
 sources_examined bigint NOT NULL DEFAULT 0 CHECK(sources_examined>=0),
 decisions_inserted bigint NOT NULL DEFAULT 0 CHECK(decisions_inserted>=0),
 CHECK ((cursor_evaluated_at IS NULL)=(cursor_evaluation_id IS NULL)),
 CHECK (cursor_evaluated_at IS NULL OR cycle_cutoff IS NOT NULL)
);
ALTER TABLE private.strata_v13_signal_audit_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_v13_signal_audit_progress FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
