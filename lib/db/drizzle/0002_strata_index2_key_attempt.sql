-- One durable attempt for the restricted Strata INDEX2 trading key.
-- Stores the public key id only. The private key is never a column.

CREATE TABLE IF NOT EXISTS public.strata_index2_key_attempt (
  singleton_id text PRIMARY KEY,
  key_name text NOT NULL,
  subaccount integer NOT NULL,
  key_type text NOT NULL,
  scopes text[] NOT NULL,
  state text NOT NULL,
  api_key_id text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  response_received_at timestamptz,
  CONSTRAINT strata_index2_key_attempt_identity_check CHECK (
    singleton_id = 'singleton' AND
    key_name = 'Strata INDEX2' AND
    subaccount = 1 AND
    key_type = 'rsa' AND
    scopes = ARRAY['read', 'write::trade']::text[]
  ),
  CONSTRAINT strata_index2_key_attempt_state_check CHECK (
    (
      state = 'attempted' AND
      api_key_id IS NULL AND
      response_received_at IS NULL
    ) OR (
      state = 'uncertain' AND
      api_key_id IS NULL AND
      response_received_at IS NULL
    ) OR (
      state = 'response_received' AND
      api_key_id IS NOT NULL AND
      btrim(api_key_id) <> '' AND
      length(api_key_id) <= 256 AND
      response_received_at IS NOT NULL
    )
  )
);

ALTER TABLE public.strata_index2_key_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.strata_index2_key_attempt FROM anon, authenticated;
