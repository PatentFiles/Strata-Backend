-- Optional online production operation; NOT an application migration.
-- Apply once from a dedicated database-admin session in autocommit mode.
-- Keep the API and workers running; do not change execution or transfer flags.
-- Preflight in separate queries: confirm the exact serving release and table,
-- no concurrent index build on this table, no sustained load or long open
-- transactions, and no existing index of this name (including invalid ones).
-- Set short session lock_timeout and bounded statement_timeout separately;
-- watch pg_stat_progress_create_index and the active worker heartbeat.
-- Do not wrap this statement in BEGIN and do not apply on API startup.
CREATE INDEX CONCURRENTLY strata_observation_reserve_evidence_lookup_v1
 ON public.v13_production_observation(account_id, (payload->>'id'))
 WHERE kind IN ('PROVEN_NOT_POSTED','POST_ATTEMPT','POST_UNCERTAIN','CANCEL_ATTEMPT');

-- Read-only postcheck, in a separate query:
-- SELECT indisready,indisvalid,pg_get_indexdef(indexrelid)
-- FROM pg_index WHERE indexrelid=to_regclass('public.strata_observation_reserve_evidence_lookup_v1');
-- Verify both booleans and exact definition, then EXPLAIN (not EXPLAIN ANALYZE
-- in production) for the existing release evidence query and verify the index
-- is chosen. If interrupted/invalid, stop and inspect; do not silently rerun.
-- No changes to receipts, money, rules, row locks, deadline, or permissions.
