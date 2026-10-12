-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- One in-flight Advanced API qualification attempt per Kalshi provider connection.
-- This file does not place an order, move money, or change bot eligibility.
BEGIN;

CREATE TABLE IF NOT EXISTS private.kalshi_api_qualification_guard (
  provider_connection_id uuid PRIMARY KEY REFERENCES private.provider_connections(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN (
    'inflight', 'order_uncertain', 'unexpected_fill', 'cancel_uncertain',
    'upgrade_uncertain', 'upgrade_rejected', 'canceled'
  )),
  client_order_id text,
  order_id text,
  ticker text,
  fill_count text,
  average_fill_price text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.kalshi_api_qualification_guard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.kalshi_api_qualification_guard FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON private.kalshi_api_qualification_guard FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON private.kalshi_api_qualification_guard FROM authenticated';
  END IF;
END $$;

COMMIT;
