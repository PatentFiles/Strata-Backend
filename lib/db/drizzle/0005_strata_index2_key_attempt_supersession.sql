-- Allows exactly one in-place supersession of the singleton INDEX2 attempt.
-- The old row keeps its state and key id. It is not deleted. No private key column.
BEGIN;
ALTER TABLE public.strata_index2_key_attempt
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersession_reason text;

ALTER TABLE public.strata_index2_key_attempt
  DROP CONSTRAINT IF EXISTS strata_index2_key_attempt_identity_check;
ALTER TABLE public.strata_index2_key_attempt
  ADD CONSTRAINT strata_index2_key_attempt_identity_check CHECK (
    key_name = 'Strata INDEX2' AND
    subaccount = 1 AND
    key_type = 'rsa' AND
    scopes = ARRAY['read', 'write::trade']::text[] AND
    (
      (
        singleton_id = 'singleton' AND
        superseded_at IS NULL AND
        supersession_reason IS NULL
      ) OR (
        singleton_id <> 'singleton' AND
        length(singleton_id) BETWEEN 32 AND 64 AND
        superseded_at IS NOT NULL AND
        supersession_reason = 'replaced_for_current_kalshi_account'
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS strata_index2_key_attempt_one_replacement
  ON public.strata_index2_key_attempt (supersession_reason)
  WHERE supersession_reason IS NOT NULL;
COMMIT;
