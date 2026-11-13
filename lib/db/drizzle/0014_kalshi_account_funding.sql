-- REVIEW ONLY. Do not run at application startup or against the connected
-- Strata database without a separate staged authorization.
-- Stores one explicit funding authorization per owned Kalshi connection.
-- This file does not transfer funds, does not place orders, does not copy
-- Vault secrets, and does not enable execution.
--
-- Rollback:
--   DROP TABLE IF EXISTS private.kalshi_account_funding;
BEGIN;

CREATE TABLE IF NOT EXISTS private.kalshi_account_funding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  financial_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  authorized_micros bigint NOT NULL,
  evidence_micros bigint,
  evidence_source text,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  evidence_observed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kalshi_account_funding_amount_check CHECK (authorized_micros > 0),
  CONSTRAINT kalshi_account_funding_evidence_amount_check CHECK (
    evidence_micros IS NULL OR evidence_micros >= 0
  ),
  CONSTRAINT kalshi_account_funding_source_check CHECK (
    evidence_source IS NULL OR evidence_source IN ('kalshi_balance', 'kalshi_transfer')
  ),
  CONSTRAINT kalshi_account_funding_evidence_check CHECK (
    (evidence_micros IS NULL AND evidence_source IS NULL AND evidence_observed_at IS NULL)
    OR (evidence_micros IS NOT NULL AND evidence_source IS NOT NULL AND evidence_observed_at IS NOT NULL)
  ),
  CONSTRAINT kalshi_account_funding_owner_fk
    FOREIGN KEY (financial_account_id, owner_user_id)
    REFERENCES public.financial_accounts (id, user_id),
  CONSTRAINT kalshi_account_funding_connection_fk
    FOREIGN KEY (provider_connection_id, financial_account_id)
    REFERENCES private.provider_connections (id, financial_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS kalshi_account_funding_one_active
  ON private.kalshi_account_funding (provider_connection_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS kalshi_account_funding_owner_idx
  ON private.kalshi_account_funding (owner_user_id, provider_connection_id);

ALTER TABLE private.kalshi_account_funding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.kalshi_account_funding FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_funding FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_funding FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE private.kalshi_account_funding FROM service_role';
  END IF;
END $$;

COMMIT;
