-- Issue #134: public REST orderbook receipts observed AFTER paper action.
-- Research-only, append-only. NO INSERT/UPDATE of financial history or trade records.
-- Apply before deploying code that writes depth receipts. No browser SELECT policy.
BEGIN;
CREATE TABLE IF NOT EXISTS public.forward_test_book_snapshots (
 id text PRIMARY KEY,
 engine_id text NOT NULL,
 paper_position_id text NOT NULL,
 market_ticker text NOT NULL,
 phase text NOT NULL CHECK(phase IN ('ENTRY','EXIT')),
 position_direction text NOT NULL CHECK(position_direction IN ('UP','DOWN')),
 requested_contracts integer NOT NULL CHECK(requested_contracts BETWEEN 1 AND 1000000),
 event_at timestamptz NOT NULL,
 started_at timestamptz NOT NULL,
 received_at timestamptz,
 status text NOT NULL CHECK(status IN ('CAPTURED','UNAVAILABLE')),
 bid_levels jsonb,
 capacity jsonb,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT paper_depth_capture_status_check CHECK (
   (status='CAPTURED' AND received_at IS NOT NULL AND bid_levels IS NOT NULL
       AND capacity IS NOT NULL AND error_code IS NULL)
   OR (status='UNAVAILABLE' AND bid_levels IS NULL AND capacity IS NULL
       AND error_code IS NOT NULL)
 ),
 CONSTRAINT paper_depth_capture_time_check CHECK(
  started_at>=event_at AND (received_at IS NULL OR received_at>=started_at)
 )
);
CREATE UNIQUE INDEX IF NOT EXISTS paper_book_unique_position_phase
 ON public.forward_test_book_snapshots(paper_position_id,phase);
CREATE INDEX IF NOT EXISTS paper_book_engine_created
 ON public.forward_test_book_snapshots(engine_id,created_at DESC);
ALTER TABLE public.forward_test_book_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON public.forward_test_book_snapshots FROM PUBLIC, anon, authenticated;
-- No untrusted user access: only privileged backend/DB administrator operations.
COMMIT;
