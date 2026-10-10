-- HISTORICAL, INCOMPLETE snapshot from 2026-09-25: NOT the current publish diff.
-- Later MICRO_LIVE fee verification, bounded-run, and order-provenance changes
-- make this 11-statement list obsolete. Obtain a fresh read-only schema diff
-- and review every statement before any future Publish action.
-- Do not execute this SQL; Replit Publish owns production changes.

-- 01 of 11
ALTER TABLE "micro_live_config" ADD COLUMN "micro_live_run_id" text;

-- 02 of 11
ALTER TABLE "micro_live_config" ADD COLUMN "micro_live_entry_attempted" boolean DEFAULT false NOT NULL;

-- 03 of 11
ALTER TABLE "micro_live_config" ADD COLUMN "micro_live_reserved_micros" integer DEFAULT 0 NOT NULL;

-- 04 of 11
ALTER TABLE "micro_live_orders" ADD COLUMN "micro_live_run_id" text;

-- 05 of 11
ALTER TABLE "micro_live_orders" ADD COLUMN "reserved_entry_fee_micros" integer;

-- 06 of 11
ALTER TABLE "micro_live_orders" ADD COLUMN "reserved_exit_fee_micros" integer;

-- 07 of 11
ALTER TABLE "micro_live_orders" ADD COLUMN "fee_evidence_fingerprint" text;

-- 08 of 11
ALTER TABLE "micro_live_orders" ADD COLUMN "fee_evidence_verified_at" timestamp with time zone;

-- 09 of 11
ALTER TABLE "micro_live_orders" ADD COLUMN "cancellation_attempted_at" timestamp with time zone;

-- 10 of 11
ALTER TABLE "micro_live_config" ADD CONSTRAINT "micro_live_config_micro_budget_check" CHECK ((micro_live_reserved_micros >= 0) AND (micro_live_reserved_micros <= 1000000) AND ((micro_live_entry_attempted = false) OR (micro_live_run_id IS NOT NULL)));

-- 11 of 11
ALTER TABLE "micro_live_orders" ADD CONSTRAINT "micro_live_orders_fee_reservation_check" CHECK (((reserved_entry_fee_micros IS NULL) OR (reserved_entry_fee_micros >= 0)) AND ((reserved_exit_fee_micros IS NULL) OR (reserved_exit_fee_micros >= 0)));
