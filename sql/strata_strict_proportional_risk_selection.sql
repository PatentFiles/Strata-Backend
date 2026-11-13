-- Optional immutable-in-history risk preset identity for every owner-scoped stake.
-- Additive migration; does not change stakes, orders, approvals or kill switches.
BEGIN;
ALTER TABLE public.strata_configured_stake
  ADD COLUMN IF NOT EXISTS risk_preset_id text,
  ADD COLUMN IF NOT EXISTS risk_preset_revision integer,
  ADD COLUMN IF NOT EXISTS risk_capital_cents integer;
ALTER TABLE public.strata_configured_stake
  ADD CONSTRAINT strata_stake_risk_preset_all_or_none
  CHECK (
    (risk_preset_id IS NULL AND risk_preset_revision IS NULL AND risk_capital_cents IS NULL)
    OR
    (length(risk_preset_id) BETWEEN 1 AND 120
      AND risk_preset_revision >= 1
      AND risk_capital_cents >= 150)
  );
COMMENT ON COLUMN public.strata_configured_stake.risk_preset_id IS
  'Owner-selected named risk preset, exact revision; not execution approval';
COMMENT ON COLUMN public.strata_configured_stake.risk_capital_cents IS
  'Owner-authorized reference capital for integer proportional policy calculation';
COMMIT;
