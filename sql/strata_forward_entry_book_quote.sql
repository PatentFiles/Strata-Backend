-- Reviewed quote-source provenance only. Apply before the corresponding runtime.
-- No historical backfill, approval renewal, trade or policy-cap changes.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE public.forward_test_evaluations ADD COLUMN IF NOT EXISTS entry_quote_evidence jsonb;
COMMENT ON COLUMN public.forward_test_evaluations.entry_quote_evidence IS
 'Canonical prequalification public orderbook quote provenance; local clocks only, never fill evidence. NULL retains historical/detail source.';
COMMIT;
