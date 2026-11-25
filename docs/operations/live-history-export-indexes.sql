-- Online, additive indexes for the authenticated history/export readers.
-- Run each statement separately OUTSIDE a transaction. Do not run on API startup.
-- Existing names must be inspected for exact definition and indisvalid=true;
-- IF NOT EXISTS is not proof that an existing same-named index is correct.
-- These indexes confer no authority and change no ledger/history rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS strata_observation_proven_not_posted_lookup_v1
 ON public.v13_production_observation(account_id, (payload->>'id'), observed_at DESC, id DESC)
 WHERE kind='PROVEN_NOT_POSTED';
CREATE INDEX CONCURRENTLY IF NOT EXISTS strata_history_intent_account_time_v1
 ON public.v13_production_intent(account_id, created_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS strata_history_intent_time_v1
 ON public.v13_production_intent(created_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS strata_history_event_intent_v1
 ON public.v13_production_event(account_id, intent_id, occurred_at, event_id);