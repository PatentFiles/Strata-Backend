-- Operator evidence for Railway commissioning.
-- Creates no rows and does not choose risk limits, an exit floor, or a fee digest.

CREATE TABLE IF NOT EXISTS public.v13_commissioning_evidence (
  singleton_id text PRIMARY KEY DEFAULT 'singleton',
  boundary_history_complete boolean NOT NULL DEFAULT false,
  fee_artifact_digest text,
  fee_artifact_verified boolean NOT NULL DEFAULT false,
  cash_precision_verified boolean NOT NULL DEFAULT false,
  cash_micros text,
  cash_source text,
  minimum_exit_micros integer,
  minimum_exit_source text,
  minimum_exit_approved_by text,
  minimum_exit_approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v13_commissioning_evidence_singleton_check CHECK (singleton_id = 'singleton'),
  CONSTRAINT v13_commissioning_evidence_fee_check CHECK (
    (fee_artifact_digest IS NULL OR fee_artifact_digest ~ '^[0-9a-f]{64}$') AND
    (NOT fee_artifact_verified OR fee_artifact_digest IS NOT NULL)
  ),
  CONSTRAINT v13_commissioning_evidence_cash_check CHECK (
    (cash_source IS NULL OR cash_source = 'authenticated_kalshi_micros') AND
    (NOT cash_precision_verified OR (cash_micros ~ '^[0-9]+$' AND cash_source = 'authenticated_kalshi_micros'))
  ),
  CONSTRAINT v13_commissioning_evidence_exit_check CHECK (
    minimum_exit_micros IS NULL OR (
      minimum_exit_micros BETWEEN 1 AND 999999 AND
      minimum_exit_source = 'operator_approved' AND
      minimum_exit_approved_by IS NOT NULL AND
      btrim(minimum_exit_approved_by) <> '' AND
      minimum_exit_approved_at IS NOT NULL
    )
  )
);

ALTER TABLE public.v13_commissioning_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.v13_commissioning_evidence FROM anon, authenticated;
