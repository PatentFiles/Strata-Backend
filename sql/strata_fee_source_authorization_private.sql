-- Additive, PRIVATE, fail-closed schema for a separately approved operator fee-source policy.
-- The creation of tables does NOT issue any grant, give owner consent, alter Step 6/9/11,
-- or enable orders. No public-facing grant or consent INSERT endpoint exists.
CREATE TABLE IF NOT EXISTS private.strata_fee_source_grants (
  grant_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  release_id uuid NOT NULL REFERENCES public.strata_fee_operator_release_candidates(release_id),
  reviewed_pdf_sha256 text NOT NULL CHECK (reviewed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL CHECK (policy_version='operator_attested_fee_source_v1'),
  approved_by_admin_id uuid NOT NULL REFERENCES auth.users(id),
  -- Independent, recorded policy authority must exist BEFORE an admin can issue a grant.
  policy_decision_sha256 text NOT NULL CHECK (policy_decision_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  authorized_stages text[] NOT NULL CHECK (
    cardinality(authorized_stages) BETWEEN 1 AND 4
    AND authorized_stages <@ ARRAY['STEP_6','STEP_9','STEP_11','ORDER_ENTRY']::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > approved_at AND expires_at <= approved_at + INTERVAL '15 minutes'),
  CHECK (revoked_at IS NULL OR revoked_at >= approved_at),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS strata_fee_source_grants_owner_lookup
ON private.strata_fee_source_grants (owner_user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS private.strata_fee_source_owner_consents (
  consent_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES private.strata_fee_source_grants(grant_id),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  release_id uuid NOT NULL REFERENCES public.strata_fee_operator_release_candidates(release_id),
  confirmation text NOT NULL CHECK (confirmation='CONFIRM_OPERATOR_FEE_SOURCE_ONLY'),
  confirmed_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grant_id,owner_user_id),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

ALTER TABLE private.strata_fee_source_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.strata_fee_source_owner_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_fee_source_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.strata_fee_source_owner_consents FROM PUBLIC, anon, authenticated;

-- Immutable evidence: only ONE append-only revocation transition is permitted.
-- A valid future issuer and owner-consent API must authenticate its actor,
-- record the decision, and store independent signatures before INSERTing.
CREATE OR REPLACE FUNCTION private.strata_fee_source_prevent_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fee_source_evidence_append_only';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NEW.revocation_reason IS NULL
    OR length(btrim(NEW.revocation_reason)) < 8
    OR (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason') IS DISTINCT FROM
       (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason') THEN
    RAISE EXCEPTION 'fee_source_evidence_mutation_prohibited';
  END IF;
  RETURN NEW;
END
$body$;

DROP TRIGGER IF EXISTS strata_fee_source_grants_append_only
  ON private.strata_fee_source_grants;
CREATE TRIGGER strata_fee_source_grants_append_only
BEFORE UPDATE OR DELETE ON private.strata_fee_source_grants
FOR EACH ROW EXECUTE FUNCTION private.strata_fee_source_prevent_evidence_mutation();

DROP TRIGGER IF EXISTS strata_fee_source_consents_append_only
  ON private.strata_fee_source_owner_consents;
CREATE TRIGGER strata_fee_source_consents_append_only
BEFORE UPDATE OR DELETE ON private.strata_fee_source_owner_consents
FOR EACH ROW EXECUTE FUNCTION private.strata_fee_source_prevent_evidence_mutation();

COMMENT ON TABLE private.strata_fee_source_grants IS
'Private, immutable policy grant ledger; no grant is authorized by table existence.';
COMMENT ON TABLE private.strata_fee_source_owner_consents IS
'Private, append-only owner source-consent ledger; separate from live trading consent.';
