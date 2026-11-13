-- One durable attempt to create Kalshi subaccount 1 on exchange index 2.
-- Stores the returned account number only. Cash amounts and credentials are not columns.

CREATE TABLE IF NOT EXISTS public.strata_subaccount_creation_attempt (
  singleton_id text PRIMARY KEY,
  exchange_index integer NOT NULL,
  state text NOT NULL,
  returned_subaccount integer,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  response_received_at timestamptz,
  CONSTRAINT strata_subaccount_creation_identity_check CHECK (
    singleton_id = 'singleton' AND
    exchange_index = 2
  ),
  CONSTRAINT strata_subaccount_creation_state_check CHECK (
    (
      state = 'attempted' AND
      returned_subaccount IS NULL AND
      response_received_at IS NULL
    ) OR (
      state = 'uncertain' AND
      returned_subaccount IS NULL AND
      response_received_at IS NULL
    ) OR (
      state = 'response_received' AND
      returned_subaccount = 1 AND
      response_received_at IS NOT NULL
    ) OR (
      state = 'rejected' AND
      returned_subaccount BETWEEN 0 AND 63 AND
      returned_subaccount <> 1 AND
      response_received_at IS NOT NULL
    )
  )
);

ALTER TABLE public.strata_subaccount_creation_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.strata_subaccount_creation_attempt FROM anon, authenticated;
