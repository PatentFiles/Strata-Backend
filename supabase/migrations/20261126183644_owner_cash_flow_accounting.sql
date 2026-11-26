-- Additive receipt-backed funding. No money movement, owner opt-in or historical rewrite.
BEGIN;
ALTER TABLE public.v13_production_account ADD COLUMN IF NOT EXISTS net_funding_micros bigint NOT NULL DEFAULT 0;
ALTER TABLE private.strata_manual_profit_withdrawals
 ADD COLUMN IF NOT EXISTS bot_before_micros bigint,
 ADD COLUMN IF NOT EXISTS cashier_before_micros bigint,
 ADD COLUMN IF NOT EXISTS intermediate_before_micros bigint,
 ADD COLUMN IF NOT EXISTS stake_revision bigint,
 ADD COLUMN IF NOT EXISTS policy_hash text;
ALTER TABLE private.strata_auto_profit_withdrawal_rules
 ADD COLUMN IF NOT EXISTS sweep_mode text NOT NULL DEFAULT 'fixed_amount'
 CHECK (sweep_mode IN ('fixed_amount','excess'));
ALTER TABLE private.strata_auto_profit_withdrawal_rules DROP CONSTRAINT strata_auto_sweep_threshold_fits_cash;
ALTER TABLE private.strata_auto_profit_withdrawal_rules ADD CONSTRAINT strata_auto_sweep_threshold_fits_cash
 CHECK((sweep_mode='fixed_amount' AND trigger_cents>=withdraw_cents+retain_cents) OR (sweep_mode='excess' AND trigger_cents>retain_cents));
CREATE TABLE IF NOT EXISTS private.strata_owner_cash_flow_receipt (
 id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 execution_account_id text NOT NULL REFERENCES public.v13_production_account(id),
 direction text NOT NULL CHECK(direction IN ('TOPUP','WITHDRAWAL')),
 provider_transfer_id text NOT NULL CHECK(length(provider_transfer_id) BETWEEN 8 AND 128),
 delta_micros bigint NOT NULL CHECK(delta_micros<>0),
 before_cash_micros bigint NOT NULL CHECK(before_cash_micros>=0),
 after_cash_micros bigint NOT NULL CHECK(after_cash_micros>=0),
 before_net_funding_micros bigint NOT NULL,
 after_net_funding_micros bigint NOT NULL,
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(after_cash_micros=before_cash_micros+delta_micros),
 CHECK(after_net_funding_micros=before_net_funding_micros+delta_micros),
 CHECK((direction='TOPUP' AND delta_micros>0) OR (direction='WITHDRAWAL' AND delta_micros<0)),
 UNIQUE(execution_account_id,provider_transfer_id)
);
CREATE INDEX IF NOT EXISTS strata_owner_cash_flow_account ON private.strata_owner_cash_flow_receipt(execution_account_id);
ALTER TABLE private.strata_owner_cash_flow_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_owner_cash_flow_receipt FROM PUBLIC,anon,authenticated,strata_paper_runtime;
GRANT SELECT,INSERT ON private.strata_owner_cash_flow_receipt TO strata_api_runtime;
CREATE POLICY strata_cash_flow_api_only ON private.strata_owner_cash_flow_receipt
 FOR ALL TO strata_api_runtime USING(true) WITH CHECK(true);
CREATE OR REPLACE FUNCTION private.strata_cash_flow_receipt_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,private,public AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_flow_receipt_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v13_production_account a WHERE a.id=NEW.execution_account_id
   AND a.owner_user_id=NEW.owner_user_id AND a.reserved_micros=0
   AND a.cash_micros=NEW.before_cash_micros AND a.net_funding_micros=NEW.before_net_funding_micros)
 THEN RAISE EXCEPTION 'cash_flow_account_scope_changed'; END IF;
 IF NEW.direction='TOPUP' THEN
  IF NOT EXISTS(SELECT 1 FROM private.kalshi_owner_topup_legs l JOIN private.kalshi_owner_topups p ON p.id=l.topup_id
    WHERE l.id=NEW.id AND l.kind='bot' AND l.state='completed' AND p.state='completed'
      AND p.owner_user_id=NEW.owner_user_id AND p.execution_account_id=NEW.execution_account_id
      AND l.exchange_transfer_id=NEW.provider_transfer_id AND l.amount_cents::bigint*10000=NEW.delta_micros
      AND l.bot_two_before_micros=NEW.before_cash_micros AND l.bot_two_after_micros=NEW.after_cash_micros)
   THEN RAISE EXCEPTION 'cash_flow_topup_receipt_unverified'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM private.strata_manual_profit_withdrawals w
    WHERE w.id=NEW.id AND w.state='completed' AND w.owner_user_id=NEW.owner_user_id
      AND w.execution_account_id=NEW.execution_account_id AND w.exchange_transfer_id=NEW.provider_transfer_id
      AND -w.amount_cents*10000=NEW.delta_micros AND w.bot_before_micros=NEW.before_cash_micros)
   THEN RAISE EXCEPTION 'cash_flow_withdrawal_receipt_unverified'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.strata_cash_flow_receipt_guard() FROM PUBLIC,anon,authenticated,strata_paper_runtime;
CREATE TRIGGER strata_cash_flow_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private.strata_owner_cash_flow_receipt FOR EACH ROW EXECUTE FUNCTION private.strata_cash_flow_receipt_guard();
-- Existing runtime roles already own account cash/revision updates. The new
-- projection is independently checked against these immutable receipts by the ledger.
COMMENT ON COLUMN public.v13_production_account.net_funding_micros IS
 'Signed sum of verified post-commissioning deposits less withdrawals; original opening capital and trading P&L remain unchanged.';
COMMIT;
