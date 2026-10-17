-- Isolated Kalshi DEMO qualification ledger. Does NOT enable production
-- trading, change production account status, funding or kill switches.
-- Requires an approved migration review before activation on any database.
-- This table must NEVER be exposed through the Supabase Data API.
BEGIN;
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.strata_demo_ioc_attempt (
  attempt_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  demo_account_id text NOT NULL
    CHECK(length(demo_account_id) BETWEEN 1 AND 128),
  signer_fingerprint text NOT NULL
    CHECK(signer_fingerprint ~ '^[0-9a-f]{64}$'),
  client_order_id text NOT NULL UNIQUE
    CHECK(client_order_id ~ '^v13p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  market_ticker text NOT NULL
    CHECK(market_ticker ~ '^KXBTC15M-[A-Za-z0-9-]+$'),
  reducing_side text NOT NULL CHECK(reducing_side IN ('bid','ask')),
  requested_hundredths bigint NOT NULL
    CHECK(requested_hundredths BETWEEN 1 AND 100000),
  price_dollars text NOT NULL
    CHECK(price_dollars ~ '^0\.[0-9]{4}$'),
  fee_fingerprint text NOT NULL
    CHECK(fee_fingerprint ~ '^[0-9a-f]{64}$'),
  operator_approval_id uuid NOT NULL,
  worker_holder_id text NOT NULL
    CHECK(length(worker_holder_id) BETWEEN 1 AND 128),
  worker_fencing_token bigint NOT NULL CHECK(worker_fencing_token > 0),
  state text NOT NULL DEFAULT 'PREPARED'
    CHECK(state IN ('PREPARED','UNKNOWN','RECONCILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
    CHECK(expires_at > created_at),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Database-level protection: service credentials must not be able to
-- reset an attempted POST to PREPARED or mutate immutable order identity.
-- The application-level WHERE state='PREPARED' guard alone is insufficient.
CREATE OR REPLACE FUNCTION private.strata_demo_ioc_transition_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $
BEGIN
  IF ROW(NEW.attempt_id,NEW.owner_user_id,NEW.demo_account_id,
         NEW.signer_fingerprint,NEW.client_order_id,NEW.market_ticker,
         NEW.reducing_side,NEW.requested_hundredths,NEW.price_dollars,
         NEW.fee_fingerprint,NEW.operator_approval_id,NEW.worker_holder_id,
         NEW.worker_fencing_token,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.attempt_id,OLD.owner_user_id,OLD.demo_account_id,
         OLD.signer_fingerprint,OLD.client_order_id,OLD.market_ticker,
         OLD.reducing_side,OLD.requested_hundredths,OLD.price_dollars,
         OLD.fee_fingerprint,OLD.operator_approval_id,OLD.worker_holder_id,
         OLD.worker_fencing_token,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'demo IOC immutable identity cannot change'
    USING ERRCODE = '23514'; END IF;
  IF NOT ((OLD.state = 'PREPARED' AND NEW.state = 'UNKNOWN')
       OR (OLD.state = 'UNKNOWN' AND NEW.state = 'RECONCILED'))
  THEN RAISE EXCEPTION 'invalid demo IOC state transition'
    USING ERRCODE = '23514'; END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'demo IOC update timestamp cannot regress'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$;
DROP TRIGGER IF EXISTS strata_demo_ioc_transition_guard
  ON private.strata_demo_ioc_attempt;
CREATE TRIGGER strata_demo_ioc_transition_guard
  BEFORE UPDATE ON private.strata_demo_ioc_attempt
  FOR EACH ROW EXECUTE FUNCTION private.strata_demo_ioc_transition_guard();
REVOKE ALL ON FUNCTION private.strata_demo_ioc_transition_guard()
  FROM PUBLIC, anon, authenticated;
-- Only one unresolved attempt per demo account/market. A process crash
-- after UNKNOWN cannot open a new reservation until manual reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS strata_demo_ioc_one_pending_per_market
ON private.strata_demo_ioc_attempt (demo_account_id,market_ticker)
WHERE state IN ('PREPARED','UNKNOWN');
CREATE INDEX IF NOT EXISTS strata_demo_ioc_owner_read_idx
ON private.strata_demo_ioc_attempt (owner_user_id, created_at DESC);
ALTER TABLE private.strata_demo_ioc_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_demo_ioc_attempt FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE private.strata_demo_ioc_attempt IS
'Isolated DEMO-only IOC order attempt ledger. PREPARED -> UNKNOWN is irreversible; never retry a possible POST.';
COMMIT;
