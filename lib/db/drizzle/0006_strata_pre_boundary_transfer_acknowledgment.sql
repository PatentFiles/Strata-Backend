-- One durable acknowledgment of the intentional pre-boundary $25 round trip.
-- Does not delete or modify Kalshi history. No credential or private-key column.
BEGIN;
CREATE TABLE IF NOT EXISTS public.strata_pre_boundary_transfer_acknowledgment (
  id uuid PRIMARY KEY,
  round_trip_key text NOT NULL DEFAULT 'pre_boundary_25_round_trip',
  subaccount integer NOT NULL,
  exchange_index integer NOT NULL,
  inbound_transfer_id text NOT NULL,
  outbound_transfer_id text NOT NULL,
  amount_cents integer NOT NULL,
  inbound_created_at timestamptz NOT NULL,
  outbound_created_at timestamptz NOT NULL,
  acknowledged_by text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  evidence_digest text NOT NULL,
  state text NOT NULL,
  CONSTRAINT strata_pre_boundary_round_trip_key_unique UNIQUE (round_trip_key),
  CONSTRAINT strata_pre_boundary_inbound_unique UNIQUE (inbound_transfer_id),
  CONSTRAINT strata_pre_boundary_outbound_unique UNIQUE (outbound_transfer_id),
  CONSTRAINT strata_pre_boundary_shape_check CHECK (
    round_trip_key = 'pre_boundary_25_round_trip' AND
    subaccount = 1 AND
    exchange_index = 2 AND
    amount_cents = 2500 AND
    outbound_transfer_id = '391a20ac-5332-41d6-b015-9b8720e4e5c1' AND
    inbound_transfer_id <> outbound_transfer_id AND
    inbound_transfer_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
    evidence_digest ~ '^[0-9a-f]{64}$' AND
    state = 'ACKNOWLEDGED' AND
    btrim(acknowledged_by) <> ''
  )
);
ALTER TABLE public.strata_pre_boundary_transfer_acknowledgment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.strata_pre_boundary_transfer_acknowledgment FROM anon, authenticated;
COMMIT;
