-- Reviewed release application schema.
-- Source: carrolldbrady-hub/btc-kalshi-v13 release/c52-53-brit
-- Commit: 03376f2cc125ed649858f19d9aa910e9ff9a57c8
-- Additive only. Creates no rows. Does not commission an account, write funding evidence,
-- or touch Supabase auth, storage, realtime, or existing Strata tables:
-- public.profiles, public.financial_accounts, public.strategies, public.strategy_versions,
-- public.strategy_recommendations, public.automations.
-- Empty V13 production tables are the expected result.
-- Row level security is enabled with no browser policies. The backend owner connection bypasses it.

CREATE TABLE IF NOT EXISTS "forward_test_btc_points" (
	"id" text PRIMARY KEY NOT NULL,
	"engine_id" text NOT NULL,
	"price" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forward_test_engine" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_version" text DEFAULT 'V1.3' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'PAPER_ONLY' NOT NULL,
	"lease_owner" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_acquired_at" timestamp with time zone,
	"lease_renewed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"worker_started_at" timestamp with time zone,
	"last_attempted_cycle_at" timestamp with time zone,
	"last_successful_cycle_at" timestamp with time zone,
	"cycle_count" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_market_poll_at" timestamp with time zone,
	"last_evaluation_at" timestamp with time zone,
	"market_ticker" text,
	"signal" text,
	"direction" text,
	"signed_buffer" double precision,
	"btc_price" double precision,
	"target" double precision,
	"up_offer" double precision,
	"down_offer" double precision,
	"current_reason" text,
	"last_trigger_type" text,
	"last_trigger_at" timestamp with time zone,
	"mark_price" double precision,
	"unrealized_pnl" double precision,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forward_test_engine_version_check" CHECK ("forward_test_engine"."strategy_version" = 'V1.3'),
	CONSTRAINT "forward_test_engine_mode_check" CHECK ("forward_test_engine"."mode" = 'PAPER_ONLY')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forward_test_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"strategy_version" text DEFAULT 'V1.3' NOT NULL,
	"strategy_parameter_set_id" text,
	"strategy_parameter_hash" text,
	"market_ticker" text NOT NULL,
	"btc_price" double precision NOT NULL,
	"target" double precision NOT NULL,
	"signed_buffer" double precision NOT NULL,
	"absolute_buffer" double precision NOT NULL,
	"velocity" double precision,
	"up_bid" double precision,
	"up_offer" double precision,
	"down_bid" double precision,
	"down_offer" double precision,
	"up_spread" double precision,
	"down_spread" double precision,
	"btc_provider_age_ms" double precision,
	"btc_receive_age_ms" double precision,
	"market_age_ms" double precision,
	"seconds_remaining" integer,
	"feed_freshness" text NOT NULL,
	"previous_side" text,
	"current_side" text,
	"fresh_cross" boolean NOT NULL,
	"crossing_consumed" boolean NOT NULL,
	"crossing_key" text,
	"signal" text NOT NULL,
	"direction" text NOT NULL,
	"qualifying_trigger" boolean NOT NULL,
	"reason" text NOT NULL,
	"entry_offer" double precision,
	"position_was_open" boolean NOT NULL,
	"evaluation_source" text DEFAULT 'paper' NOT NULL,
	"live_position_id" text,
	"source_paper_evaluation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forward_test_evaluations_version_check" CHECK ("forward_test_evaluations"."strategy_version" = 'V1.3'),
	CONSTRAINT "forward_test_evaluations_parameter_identity_check" CHECK (
    ("forward_test_evaluations"."strategy_parameter_set_id" IS NULL AND "forward_test_evaluations"."strategy_parameter_hash" IS NULL) OR
    ("forward_test_evaluations"."strategy_parameter_set_id" IS NOT NULL AND "forward_test_evaluations"."strategy_parameter_hash" IS NOT NULL AND (
      (
        "forward_test_evaluations"."strategy_parameter_set_id" = 'v13-champion-1' AND
        "forward_test_evaluations"."strategy_parameter_hash" =
          '4e7359265d7f6100f3f395658fff005260ee18075adfb8942d6020c20ba7d65f'
      ) OR (
        "forward_test_evaluations"."strategy_parameter_set_id" = 'v13-champion-2-c52-confirm53' AND
        "forward_test_evaluations"."strategy_parameter_hash" =
          '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161'
      )
    ))
  ),
	CONSTRAINT "forward_test_evaluations_direction_check" CHECK ("forward_test_evaluations"."direction" IN ('UP','DOWN','NONE')),
	CONSTRAINT "forward_test_evaluations_signal_check" CHECK ("forward_test_evaluations"."signal" IN ('PASS','WATCH','SCOUT','CONFIRM','EXIT')),
	CONSTRAINT "forward_test_evaluations_quality_check" CHECK (
    ("forward_test_evaluations"."up_spread" IS NULL OR ("forward_test_evaluations"."up_spread" >= 0 AND "forward_test_evaluations"."up_spread" <= 1)) AND
    ("forward_test_evaluations"."down_spread" IS NULL OR ("forward_test_evaluations"."down_spread" >= 0 AND "forward_test_evaluations"."down_spread" <= 1)) AND
    ("forward_test_evaluations"."btc_provider_age_ms" IS NULL OR "forward_test_evaluations"."btc_provider_age_ms" >= 0) AND
    ("forward_test_evaluations"."btc_receive_age_ms" IS NULL OR "forward_test_evaluations"."btc_receive_age_ms" >= 0) AND
    ("forward_test_evaluations"."market_age_ms" IS NULL OR "forward_test_evaluations"."market_age_ms" >= 0)
  ),
	CONSTRAINT "forward_test_evaluations_live_source_check" CHECK (
    ("forward_test_evaluations"."evaluation_source" = 'paper' AND "forward_test_evaluations"."live_position_id" IS NULL AND
      "forward_test_evaluations"."source_paper_evaluation_id" IS NULL) OR
    ("forward_test_evaluations"."evaluation_source" = 'micro_live' AND "forward_test_evaluations"."position_was_open" = true AND
      "forward_test_evaluations"."live_position_id" IS NOT NULL AND "forward_test_evaluations"."live_position_id" <> '' AND
      "forward_test_evaluations"."source_paper_evaluation_id" IS NOT NULL AND "forward_test_evaluations"."source_paper_evaluation_id" <> '')
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forward_test_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"engine_id" text NOT NULL,
	"market_ticker" text NOT NULL,
	"crossing_key" text NOT NULL,
	"strategy_version" text DEFAULT 'V1.3' NOT NULL,
	"strategy_parameter_set_id" text,
	"strategy_parameter_hash" text,
	"direction" text NOT NULL,
	"trigger_type" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"entry_offer" double precision NOT NULL,
	"entry_bid" double precision,
	"entry_spread" double precision,
	"entry_seconds_remaining" double precision,
	"entry_btc_provider_age_ms" double precision,
	"entry_btc_receive_age_ms" double precision,
	"entry_market_age_ms" double precision,
	"stake" double precision NOT NULL,
	"contracts" double precision NOT NULL,
	"target" double precision NOT NULL,
	"entry_btc_price" double precision NOT NULL,
	"entry_buffer" double precision NOT NULL,
	"entry_velocity" double precision,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"exit_price" double precision,
	"close_reason" text,
	"settlement_result" text,
	"payout" double precision,
	"pnl" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forward_test_positions_version_check" CHECK ("forward_test_positions"."strategy_version" = 'V1.3'),
	CONSTRAINT "forward_test_positions_parameter_identity_check" CHECK (
    ("forward_test_positions"."strategy_parameter_set_id" IS NULL AND "forward_test_positions"."strategy_parameter_hash" IS NULL) OR
    ("forward_test_positions"."strategy_parameter_set_id" IS NOT NULL AND "forward_test_positions"."strategy_parameter_hash" IS NOT NULL AND (
      (
        "forward_test_positions"."strategy_parameter_set_id" = 'v13-champion-1' AND
        "forward_test_positions"."strategy_parameter_hash" =
          '4e7359265d7f6100f3f395658fff005260ee18075adfb8942d6020c20ba7d65f'
      ) OR (
        "forward_test_positions"."strategy_parameter_set_id" = 'v13-champion-2-c52-confirm53' AND
        "forward_test_positions"."strategy_parameter_hash" =
          '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161'
      )
    ))
  ),
	CONSTRAINT "forward_test_positions_direction_check" CHECK ("forward_test_positions"."direction" IN ('UP','DOWN')),
	CONSTRAINT "forward_test_positions_trigger_check" CHECK ("forward_test_positions"."trigger_type" IN ('SCOUT','CONFIRM')),
	CONSTRAINT "forward_test_positions_status_check" CHECK ("forward_test_positions"."status" IN ('OPEN','SETTLED','CLOSED')),
	CONSTRAINT "forward_test_positions_amount_check" CHECK (
    "forward_test_positions"."entry_offer" > 0 AND "forward_test_positions"."entry_offer" <= 1 AND
    ("forward_test_positions"."entry_bid" IS NULL OR ("forward_test_positions"."entry_bid" >= 0 AND "forward_test_positions"."entry_bid" <= 1)) AND
    ("forward_test_positions"."entry_spread" IS NULL OR ("forward_test_positions"."entry_spread" >= 0 AND "forward_test_positions"."entry_spread" <= 1)) AND
    ("forward_test_positions"."entry_seconds_remaining" IS NULL OR "forward_test_positions"."entry_seconds_remaining" >= 0) AND
    ("forward_test_positions"."entry_btc_provider_age_ms" IS NULL OR "forward_test_positions"."entry_btc_provider_age_ms" >= 0) AND
    ("forward_test_positions"."entry_btc_receive_age_ms" IS NULL OR "forward_test_positions"."entry_btc_receive_age_ms" >= 0) AND
    ("forward_test_positions"."entry_market_age_ms" IS NULL OR "forward_test_positions"."entry_market_age_ms" >= 0) AND
    "forward_test_positions"."stake" > 0 AND "forward_test_positions"."contracts" > 0
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forward_test_windows" (
	"ticker" text PRIMARY KEY NOT NULL,
	"target" double precision NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"previous_side" text,
	"current_side" text,
	"previous_buffer" double precision,
	"first_cross_occurred" boolean DEFAULT false NOT NULL,
	"crossing_consumed" boolean DEFAULT false NOT NULL,
	"crossing_key" text,
	"crossing_direction" text,
	"crossing_at" timestamp with time zone,
	"scout_triggered" boolean DEFAULT false NOT NULL,
	"confirm_triggered" boolean DEFAULT false NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL,
	"settlement_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forward_test_windows_side_check" CHECK (("forward_test_windows"."previous_side" IS NULL OR "forward_test_windows"."previous_side" IN ('UP','DOWN','AT')) AND ("forward_test_windows"."current_side" IS NULL OR "forward_test_windows"."current_side" IN ('UP','DOWN','AT'))),
	CONSTRAINT "forward_test_windows_cross_check" CHECK ("forward_test_windows"."crossing_direction" IS NULL OR "forward_test_windows"."crossing_direction" IN ('UP','DOWN')),
	CONSTRAINT "forward_test_windows_result_check" CHECK ("forward_test_windows"."settlement_result" IS NULL OR "forward_test_windows"."settlement_result" IN ('UP','DOWN','VOID'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_events" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"action" text NOT NULL,
	"ticker" text NOT NULL,
	"direction" text,
	"signal" text NOT NULL,
	"created_at" double precision NOT NULL,
	"note" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "live_events_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_trades" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"ticker" text NOT NULL,
	"direction" text NOT NULL,
	"scout_stake" double precision NOT NULL,
	"scout_entry_price" double precision NOT NULL,
	"add_stake" double precision NOT NULL,
	"add_entry_price" double precision,
	"exit_price" double precision,
	"fees" double precision NOT NULL,
	"pnl" double precision,
	"status" text NOT NULL,
	"opened_at" double precision NOT NULL,
	"closed_at" double precision,
	"close_reason" text,
	"payload" jsonb NOT NULL,
	CONSTRAINT "live_trades_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_history" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" double precision NOT NULL,
	"closed_at" double precision,
	"entry_price" double precision NOT NULL,
	"exit_price" double precision,
	"stake" double precision NOT NULL,
	"pnl" double precision,
	"reason" text,
	"ticker" text NOT NULL,
	"target" double precision,
	"entry_signal" text,
	"entry_time" double precision NOT NULL,
	"entry_btc_price" double precision,
	"entry_kalshi_price" double precision NOT NULL,
	"entry_buffer" double precision,
	"entry_velocity" double precision,
	"outcome" text,
	"payload" jsonb NOT NULL,
	CONSTRAINT "paper_history_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_production_account" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"subaccount" bigint NOT NULL,
	"exchange_index" bigint NOT NULL,
	"key_fingerprint" text NOT NULL,
	"commissioning_digest" text,
	"kill_switch" boolean DEFAULT true NOT NULL,
	"execution_enabled" boolean DEFAULT false NOT NULL,
	"commissioned" boolean DEFAULT false NOT NULL,
	"minimum_exit_micros" integer,
	"fee_artifact_digest" text,
	"cash_precision_verified" boolean DEFAULT false NOT NULL,
	"cash_micros" bigint NOT NULL,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"initial_cash_micros" bigint NOT NULL,
	"blocked_reason" text,
	"reconciled_at" timestamp with time zone,
	"evidence_digest" text,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "v13_production_account_pair_check" CHECK ("v13_production_account"."subaccount"=1 AND "v13_production_account"."exchange_index"=2),
	CONSTRAINT "v13_production_account_fingerprint" CHECK ("v13_production_account"."key_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "v13_production_account_cash" CHECK ("v13_production_account"."cash_micros">=0 AND "v13_production_account"."reserved_micros">=0 AND "v13_production_account"."reserved_micros"<="v13_production_account"."cash_micros"),
	CONSTRAINT "v13_production_account_authority" CHECK (NOT "v13_production_account"."commissioned" OR ("v13_production_account"."commissioning_digest" IS NOT NULL AND "v13_production_account"."commissioning_digest" ~ '^[0-9a-f]{64}$' AND "v13_production_account"."minimum_exit_micros" IS NOT NULL AND "v13_production_account"."minimum_exit_micros" BETWEEN 1 AND 999999))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_production_event" (
	"account_id" text NOT NULL,
	"event_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"cash_delta_micros" bigint NOT NULL,
	"pnl_micros" bigint DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_production_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"evaluation_id" text,
	"crossing_key" text,
	"parent_id" text,
	"kind" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"state" text DEFAULT 'PREPARED' NOT NULL,
	"request" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"policy_hash" text NOT NULL,
	"fee_fingerprint" text NOT NULL,
	"capability_digest" text NOT NULL,
	"client_order_id" text NOT NULL,
	"exchange_order_id" text,
	"reserved_micros" bigint NOT NULL,
	"exit_fee_micros" bigint NOT NULL,
	"filled_hundredths" bigint DEFAULT 0 NOT NULL,
	"terminal" boolean DEFAULT false NOT NULL,
	"cancel_attempted" boolean DEFAULT false NOT NULL,
	"dispatch_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v13_production_intent_kind" CHECK ("v13_production_intent"."kind" IN ('ENTRY','EXIT') AND "v13_production_intent"."side" IN ('YES','NO')),
	CONSTRAINT "v13_production_intent_state" CHECK ("v13_production_intent"."state" IN ('PREPARED','DISPATCHED','UNKNOWN','TERMINAL','BLOCKED')),
	CONSTRAINT "v13_production_intent_amounts" CHECK ("v13_production_intent"."reserved_micros">=0 AND "v13_production_intent"."exit_fee_micros">=0 AND "v13_production_intent"."filled_hundredths">=0),
	CONSTRAINT "v13_production_entry_source" CHECK (("v13_production_intent"."kind"='ENTRY' AND "v13_production_intent"."evaluation_id" IS NOT NULL AND "v13_production_intent"."crossing_key" IS NOT NULL AND "v13_production_intent"."parent_id" IS NULL) OR ("v13_production_intent"."kind"='EXIT' AND "v13_production_intent"."parent_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_production_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_production_position" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"quantity_hundredths" bigint DEFAULT 0 NOT NULL,
	"basis_micros" bigint DEFAULT 0 NOT NULL,
	"realized_pnl_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "v13_production_position_amounts" CHECK ("v13_production_position"."quantity_hundredths">=0 AND "v13_production_position"."basis_micros">=0 AND ("v13_production_position"."quantity_hundredths">0 OR "v13_production_position"."basis_micros"=0))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_execution_config" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"mode" text DEFAULT 'SHADOW_LIVE' NOT NULL,
	"live_execution_enabled" boolean DEFAULT false NOT NULL,
	"live_capital_limit" double precision DEFAULT 0 NOT NULL,
	"live_capital_remaining" double precision DEFAULT 0 NOT NULL,
	"max_stake_per_trade" double precision DEFAULT 0 NOT NULL,
	"max_daily_loss" double precision DEFAULT 0 NOT NULL,
	"max_total_experiment_loss" double precision DEFAULT 0 NOT NULL,
	"max_open_positions" integer DEFAULT 0 NOT NULL,
	"max_entry_price" double precision DEFAULT 0 NOT NULL,
	"max_slippage" double precision DEFAULT 0 NOT NULL,
	"shadow_capital_limit" double precision DEFAULT 0 NOT NULL,
	"shadow_capital_remaining" double precision DEFAULT 0 NOT NULL,
	"shadow_max_stake_per_trade" double precision DEFAULT 0 NOT NULL,
	"shadow_max_open_positions" integer DEFAULT 0 NOT NULL,
	"shadow_max_total_loss" double precision DEFAULT 0 NOT NULL,
	"manual_kill_switch" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_execution_config_singleton_check" CHECK ("live_execution_config"."id" = 'singleton'),
	CONSTRAINT "live_execution_config_mode_check" CHECK ("live_execution_config"."mode" IN ('PAPER_ONLY','SHADOW_LIVE')),
	CONSTRAINT "live_execution_config_execution_disabled_check" CHECK ("live_execution_config"."live_execution_enabled" = false),
	CONSTRAINT "live_execution_config_nonnegative_limits_check" CHECK (
    "live_execution_config"."live_capital_limit" >= 0 AND "live_execution_config"."live_capital_remaining" >= 0 AND
    "live_execution_config"."max_stake_per_trade" >= 0 AND "live_execution_config"."max_daily_loss" >= 0 AND
    "live_execution_config"."max_total_experiment_loss" >= 0 AND "live_execution_config"."max_open_positions" >= 0 AND
    "live_execution_config"."max_entry_price" >= 0 AND "live_execution_config"."max_entry_price" <= 1 AND "live_execution_config"."max_slippage" >= 0
  ),
	CONSTRAINT "live_execution_config_shadow_limits_check" CHECK (
    "live_execution_config"."shadow_capital_limit" >= 0 AND
    "live_execution_config"."shadow_capital_remaining" >= 0 AND "live_execution_config"."shadow_capital_remaining" <= "live_execution_config"."shadow_capital_limit" AND
    "live_execution_config"."shadow_max_stake_per_trade" >= 0 AND "live_execution_config"."shadow_max_stake_per_trade" <= "live_execution_config"."shadow_capital_limit" AND
    "live_execution_config"."shadow_max_open_positions" >= 0 AND "live_execution_config"."shadow_max_open_positions" <= 100 AND
    "live_execution_config"."shadow_max_total_loss" >= 0
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_live_money_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"supersedes_policy_id" text,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"strategy_version" text DEFAULT 'V1.3' NOT NULL,
	"strategy_parameter_set_id" text DEFAULT 'v13-champion-2-c52-confirm53' NOT NULL,
	"strategy_parameter_hash" text DEFAULT '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161' NOT NULL,
	"champion_selection_review_id" text,
	"champion_selection_evidence_hash" text,
	"champion_selected_by" text,
	"champion_selected_at" timestamp with time zone,
	"capital_limit_cents" integer DEFAULT 0 NOT NULL,
	"max_entry_stake_cents" integer DEFAULT 0 NOT NULL,
	"max_entry_all_in_cents" integer DEFAULT 0 NOT NULL,
	"max_open_positions" integer DEFAULT 1 NOT NULL,
	"max_daily_loss_cents" integer DEFAULT 0 NOT NULL,
	"max_total_loss_cents" integer DEFAULT 0 NOT NULL,
	"max_quote_age_ms" integer DEFAULT 0 NOT NULL,
	"max_fee_evidence_age_ms" integer DEFAULT 0 NOT NULL,
	"fee_policy_version" text,
	"fee_source_url" text,
	"fee_formula_version" text,
	"require_full_depth" boolean DEFAULT true NOT NULL,
	"entry_time_in_force" text DEFAULT 'IOC' NOT NULL,
	"entry_limit_source" text DEFAULT 'SIGNAL_REFERENCE_OFFER' NOT NULL,
	"policy_hash" text,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v13_live_money_policy_version_check" CHECK ("v13_live_money_policy"."version" > 0),
	CONSTRAINT "v13_live_money_policy_state_check" CHECK ("v13_live_money_policy"."state" IN ('DRAFT','APPROVED','REVOKED')),
	CONSTRAINT "v13_live_money_policy_strategy_check" CHECK (
    "v13_live_money_policy"."strategy_version" = 'V1.3' AND (
      (
        "v13_live_money_policy"."strategy_parameter_set_id" = 'v13-champion-1' AND
        "v13_live_money_policy"."strategy_parameter_hash" =
          '4e7359265d7f6100f3f395658fff005260ee18075adfb8942d6020c20ba7d65f'
      ) OR (
        "v13_live_money_policy"."strategy_parameter_set_id" = 'v13-champion-2-c52-confirm53' AND
        "v13_live_money_policy"."strategy_parameter_hash" =
          '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161'
      )
    )
  ),
	CONSTRAINT "v13_live_money_policy_entry_mode_check" CHECK (
    "v13_live_money_policy"."entry_time_in_force" = 'IOC' AND
    "v13_live_money_policy"."entry_limit_source" = 'SIGNAL_REFERENCE_OFFER'
  ),
	CONSTRAINT "v13_live_money_policy_limits_check" CHECK (
    "v13_live_money_policy"."capital_limit_cents" >= 0 AND "v13_live_money_policy"."capital_limit_cents" <= 2000000000 AND
    "v13_live_money_policy"."max_entry_stake_cents" >= 0 AND "v13_live_money_policy"."max_entry_stake_cents" <= 500000 AND
    "v13_live_money_policy"."max_entry_all_in_cents" >= 0 AND "v13_live_money_policy"."max_entry_all_in_cents" <= 2000000000 AND
    "v13_live_money_policy"."max_open_positions" >= 0 AND "v13_live_money_policy"."max_open_positions" <= 1 AND
    "v13_live_money_policy"."max_daily_loss_cents" >= 0 AND "v13_live_money_policy"."max_daily_loss_cents" <= 2000000000 AND
    "v13_live_money_policy"."max_total_loss_cents" >= 0 AND "v13_live_money_policy"."max_total_loss_cents" <= 2000000000 AND
    "v13_live_money_policy"."max_quote_age_ms" >= 0 AND "v13_live_money_policy"."max_quote_age_ms" <= 15000 AND
    "v13_live_money_policy"."max_fee_evidence_age_ms" >= 0 AND "v13_live_money_policy"."max_fee_evidence_age_ms" <= 15000
  ),
	CONSTRAINT "v13_live_money_policy_approval_check" CHECK (
    "v13_live_money_policy"."state" <> 'APPROVED' OR (
      "v13_live_money_policy"."strategy_parameter_set_id" = 'v13-champion-2-c52-confirm53' AND
      "v13_live_money_policy"."strategy_parameter_hash" =
        '314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161' AND
      "v13_live_money_policy"."champion_selection_review_id" IS NOT NULL AND
      btrim("v13_live_money_policy"."champion_selection_review_id") <> '' AND
      "v13_live_money_policy"."champion_selection_evidence_hash" IS NOT NULL AND
      "v13_live_money_policy"."champion_selection_evidence_hash" ~ '^[0-9a-f]{64}$' AND
      "v13_live_money_policy"."champion_selected_by" IS NOT NULL AND
      btrim("v13_live_money_policy"."champion_selected_by") <> '' AND
      "v13_live_money_policy"."champion_selected_at" IS NOT NULL AND
      "v13_live_money_policy"."capital_limit_cents" > 0 AND
      "v13_live_money_policy"."max_entry_stake_cents" > 0 AND
      "v13_live_money_policy"."max_entry_stake_cents" <= "v13_live_money_policy"."max_entry_all_in_cents" AND
      "v13_live_money_policy"."max_entry_all_in_cents" <= "v13_live_money_policy"."capital_limit_cents" AND
      "v13_live_money_policy"."max_open_positions" = 1 AND
      "v13_live_money_policy"."max_daily_loss_cents" > 0 AND
      "v13_live_money_policy"."max_daily_loss_cents" <= "v13_live_money_policy"."capital_limit_cents" AND
      "v13_live_money_policy"."max_total_loss_cents" > 0 AND
      "v13_live_money_policy"."max_total_loss_cents" <= "v13_live_money_policy"."capital_limit_cents" AND
      "v13_live_money_policy"."max_quote_age_ms" > 0 AND
      "v13_live_money_policy"."max_fee_evidence_age_ms" > 0 AND
      "v13_live_money_policy"."fee_policy_version" IS NOT NULL AND btrim("v13_live_money_policy"."fee_policy_version") <> '' AND
      "v13_live_money_policy"."fee_source_url" IS NOT NULL AND btrim("v13_live_money_policy"."fee_source_url") <> '' AND
      "v13_live_money_policy"."fee_formula_version" IS NOT NULL AND btrim("v13_live_money_policy"."fee_formula_version") <> '' AND
      "v13_live_money_policy"."require_full_depth" = true AND
      "v13_live_money_policy"."approved_by" IS NOT NULL AND btrim("v13_live_money_policy"."approved_by") <> '' AND
      "v13_live_money_policy"."approved_at" IS NOT NULL AND
      "v13_live_money_policy"."champion_selected_at" <= "v13_live_money_policy"."approved_at" AND
      "v13_live_money_policy"."policy_hash" IS NOT NULL AND
      "v13_live_money_policy"."policy_hash" ~ '^[0-9a-f]{64}$'
    )
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_strategy_parameter_set" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"supersedes_parameter_set_id" text,
	"label" text NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"classifier_version" text DEFAULT 'V1.3' NOT NULL,
	"scout_min_separation" double precision NOT NULL,
	"scout_max_separation" double precision NOT NULL,
	"confirm_min_separation" double precision NOT NULL,
	"scout_max_offer" double precision NOT NULL,
	"confirm_max_offer" double precision NOT NULL,
	"wrong_side_recross_separation" double precision NOT NULL,
	"exit_on_momentum_invalidation" boolean DEFAULT true NOT NULL,
	"parameter_hash" text NOT NULL,
	"execution_authority" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	CONSTRAINT "v13_strategy_parameter_set_version_check" CHECK ("v13_strategy_parameter_set"."version" > 0),
	CONSTRAINT "v13_strategy_parameter_set_reserved_id_check" CHECK ("v13_strategy_parameter_set"."id" NOT IN ('v13-champion-1','v13-champion-2-c52-confirm53')),
	CONSTRAINT "v13_strategy_parameter_set_state_check" CHECK ("v13_strategy_parameter_set"."state" IN ('DRAFT','SHADOW','RETIRED')),
	CONSTRAINT "v13_strategy_parameter_set_classifier_check" CHECK ("v13_strategy_parameter_set"."classifier_version" = 'V1.3'),
	CONSTRAINT "v13_strategy_parameter_set_no_execution_authority" CHECK ("v13_strategy_parameter_set"."execution_authority" = false),
	CONSTRAINT "v13_strategy_parameter_set_hash_check" CHECK ("v13_strategy_parameter_set"."parameter_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "v13_strategy_parameter_set_ranges_check" CHECK (
    "v13_strategy_parameter_set"."scout_min_separation" >= 0 AND
    "v13_strategy_parameter_set"."scout_max_separation" >= "v13_strategy_parameter_set"."scout_min_separation" AND
    "v13_strategy_parameter_set"."confirm_min_separation" > "v13_strategy_parameter_set"."scout_max_separation" AND
    "v13_strategy_parameter_set"."wrong_side_recross_separation" >= 0 AND
    "v13_strategy_parameter_set"."scout_max_offer" > 0 AND "v13_strategy_parameter_set"."scout_max_offer" <= 1 AND
    "v13_strategy_parameter_set"."confirm_max_offer" > 0 AND "v13_strategy_parameter_set"."confirm_max_offer" <= 1
  ),
	CONSTRAINT "v13_strategy_parameter_set_shadow_activation_check" CHECK (
    "v13_strategy_parameter_set"."state" <> 'SHADOW' OR (
      "v13_strategy_parameter_set"."activated_at" IS NOT NULL AND
      "v13_strategy_parameter_set"."activated_by" IS NOT NULL AND btrim("v13_strategy_parameter_set"."activated_by") <> ''
    )
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v13_strategy_shadow_evaluation" (
	"id" text PRIMARY KEY NOT NULL,
	"source_evaluation_id" text NOT NULL,
	"parameter_set_id" text NOT NULL,
	"parameter_hash" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"market_ticker" text NOT NULL,
	"btc_price" double precision NOT NULL,
	"target" double precision NOT NULL,
	"previous_buffer" double precision,
	"signed_buffer" double precision NOT NULL,
	"absolute_buffer" double precision NOT NULL,
	"velocity" double precision,
	"up_bid" double precision,
	"up_offer" double precision,
	"down_bid" double precision,
	"down_offer" double precision,
	"seconds_remaining" integer,
	"first_cross" boolean NOT NULL,
	"signal" text NOT NULL,
	"direction" text NOT NULL,
	"qualifying_trigger" boolean NOT NULL,
	"would_enter" boolean NOT NULL,
	"entry_offer" double precision,
	"reason" text NOT NULL,
	"execution_authority" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v13_strategy_shadow_eval_hash_check" CHECK ("v13_strategy_shadow_evaluation"."parameter_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "v13_strategy_shadow_eval_signal_check" CHECK ("v13_strategy_shadow_evaluation"."signal" IN ('PASS','WATCH','SCOUT','CONFIRM','EXIT')),
	CONSTRAINT "v13_strategy_shadow_eval_direction_check" CHECK ("v13_strategy_shadow_evaluation"."direction" IN ('UP','DOWN','NONE')),
	CONSTRAINT "v13_strategy_shadow_eval_no_execution_authority" CHECK ("v13_strategy_shadow_evaluation"."execution_authority" = false),
	CONSTRAINT "v13_strategy_shadow_eval_entry_check" CHECK (
      "v13_strategy_shadow_evaluation"."would_enter" = false OR (
        "v13_strategy_shadow_evaluation"."first_cross" = true AND
        "v13_strategy_shadow_evaluation"."qualifying_trigger" = true AND
        "v13_strategy_shadow_evaluation"."signal" IN ('SCOUT','CONFIRM') AND
        "v13_strategy_shadow_evaluation"."direction" IN ('UP','DOWN') AND
        "v13_strategy_shadow_evaluation"."entry_offer" IS NOT NULL
      )
    )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_proposed_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"market_ticker" text NOT NULL,
	"crossing_key" text NOT NULL,
	"trigger_type" text NOT NULL,
	"direction" text NOT NULL,
	"source_evaluation_id" text NOT NULL,
	"quote_price" double precision,
	"proposed_limit_price" double precision,
	"contracts" integer DEFAULT 0 NOT NULL,
	"intended_stake" double precision DEFAULT 0 NOT NULL,
	"simulated_remaining_capital" double precision,
	"status" text NOT NULL,
	"risk_verdict" text NOT NULL,
	"risk_reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_proposed_orders_trigger_check" CHECK ("live_proposed_orders"."trigger_type" IN ('SCOUT','CONFIRM')),
	CONSTRAINT "live_proposed_orders_direction_check" CHECK ("live_proposed_orders"."direction" IN ('UP','DOWN')),
	CONSTRAINT "live_proposed_orders_status_check" CHECK ("live_proposed_orders"."status" IN ('PROPOSED','BLOCKED')),
	CONSTRAINT "live_proposed_orders_risk_check" CHECK ("live_proposed_orders"."risk_verdict" IN ('ALLOW','BLOCK')),
	CONSTRAINT "live_proposed_orders_amount_check" CHECK ("live_proposed_orders"."contracts" >= 0 AND "live_proposed_orders"."intended_stake" >= 0 AND ("live_proposed_orders"."quote_price" IS NULL OR ("live_proposed_orders"."quote_price" > 0 AND "live_proposed_orders"."quote_price" <= 1)) AND ("live_proposed_orders"."proposed_limit_price" IS NULL OR ("live_proposed_orders"."proposed_limit_price" > 0 AND "live_proposed_orders"."proposed_limit_price" <= 1)) AND ("live_proposed_orders"."simulated_remaining_capital" IS NULL OR "live_proposed_orders"."simulated_remaining_capital" >= 0))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_notification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"severity" text DEFAULT 'INFO' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_notification_events_type_check" CHECK ("live_notification_events"."event_type" IN ('API','FEED','RISK','KILL','ENTRY','EXIT')),
	CONSTRAINT "live_notification_events_severity_check" CHECK ("live_notification_events"."severity" IN ('INFO','WARN','ERROR'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_config" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"micro_live_production_enabled" boolean DEFAULT false NOT NULL,
	"live_execution_enabled" boolean DEFAULT false NOT NULL,
	"manual_kill_switch" boolean DEFAULT true NOT NULL,
	"max_live_bankroll_cents" integer DEFAULT 2500 NOT NULL,
	"max_single_order_risk_cents" integer DEFAULT 500 NOT NULL,
	"max_open_positions" integer DEFAULT 1 NOT NULL,
	"max_cumulative_reserved_cents" integer DEFAULT 2500 NOT NULL,
	"max_scout_stake_cents" integer DEFAULT 250 NOT NULL,
	"max_confirm_additional_stake_cents" integer DEFAULT 250 NOT NULL,
	"micro_live_run_cap_micros" integer DEFAULT 1000000 NOT NULL,
	"micro_live_run_id" text,
	"micro_live_entry_attempted" boolean DEFAULT false NOT NULL,
	"micro_live_exit_attempted" boolean DEFAULT false NOT NULL,
	"micro_live_run_phase" text DEFAULT 'UNARMED' NOT NULL,
	"micro_live_run_armed_at" timestamp with time zone,
	"micro_live_run_deadline" timestamp with time zone,
	"micro_live_run_approval_id" text,
	"micro_live_run_approval_digest" text,
	"micro_live_run_freeze_reason" text,
	"micro_live_fee_approval_id" text,
	"micro_live_fee_approval_digest" text,
	"micro_live_fee_approval_approved" boolean DEFAULT false NOT NULL,
	"micro_live_fee_approval_invalidated" boolean DEFAULT false NOT NULL,
	"micro_live_fee_approval_approved_at" timestamp with time zone,
	"micro_live_fee_policy_version" text,
	"micro_live_fee_approval_source_url" text,
	"micro_live_fee_formula_version" text,
	"micro_live_fee_maximum_exposure_micros" integer,
	"micro_live_fee_approved_by" text,
	"micro_live_fee_approved_run_cap_micros" integer,
	"micro_live_fee_artifact_status" text DEFAULT 'unverified' NOT NULL,
	"micro_live_fee_artifact_checked_at" timestamp with time zone,
	"micro_live_fee_artifact_reason" text,
	"micro_live_account_mode" text,
	"micro_live_selected_subaccount" integer,
	"micro_live_selected_exchange_index" integer,
	"micro_live_restricted_api_key_id" text,
	"micro_live_restricted_key_fingerprint" text,
	"micro_live_accounting_unresolved" boolean DEFAULT false NOT NULL,
	"micro_live_accounting_unresolved_reason" text,
	"micro_live_primary_cash_baseline_micros" text,
	"micro_live_primary_cash_baseline_run_id" text,
	"micro_live_primary_cash_baseline_at" timestamp with time zone,
	"micro_live_primary_cash_baseline_evidence_digest" text,
	"micro_live_funding_anchor_subaccount" integer,
	"micro_live_funding_anchor_exchange_index" integer,
	"micro_live_funding_anchor_transfer_id" text,
	"micro_live_funding_anchor_transfer_at" timestamp with time zone,
	"micro_live_funding_anchor_amount_cents" integer,
	"micro_live_pair_cash_baseline_micros" text,
	"micro_live_pair_cash_baseline_run_id" text,
	"micro_live_pair_cash_baseline_at" timestamp with time zone,
	"micro_live_pair_cash_baseline_evidence_digest" text,
	"micro_live_primary_activity_checkpoint_run_id" text,
	"micro_live_primary_activity_checkpoint_cursor" text,
	"micro_live_primary_activity_checkpoint_at" timestamp with time zone,
	"micro_live_primary_activity_checkpoint_evidence_digest" text,
	"micro_live_account_activity_checkpoint_run_id" text,
	"micro_live_account_activity_checkpoint_cursor" text,
	"micro_live_account_activity_checkpoint_at" timestamp with time zone,
	"micro_live_account_activity_checkpoint_evidence_digest" text,
	"micro_live_account_activity_checkpoint_subaccount" integer,
	"micro_live_account_activity_checkpoint_exchange_index" integer,
	"micro_live_reserved_micros" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_config_singleton_check" CHECK ("micro_live_config"."id" = 'singleton'),
	CONSTRAINT "micro_live_config_account_mode_check" CHECK (
    "micro_live_config"."micro_live_account_mode" IS NULL OR
    "micro_live_config"."micro_live_account_mode" IN ('exclusive', 'primary_nonexclusive')
  ),
	CONSTRAINT "micro_live_config_selected_subaccount_check" CHECK (
    "micro_live_config"."micro_live_selected_subaccount" IS NULL OR
    "micro_live_config"."micro_live_selected_subaccount" BETWEEN 0 AND 63
  ),
	CONSTRAINT "micro_live_config_selected_exchange_index_check" CHECK (
    "micro_live_config"."micro_live_selected_exchange_index" IS NULL OR
    "micro_live_config"."micro_live_selected_exchange_index" = 2
  ),
	CONSTRAINT "micro_live_config_selected_pair_check" CHECK (
    "micro_live_config"."micro_live_selected_exchange_index" IS NULL OR
    (
      "micro_live_config"."micro_live_account_mode" IS NOT NULL AND
      "micro_live_config"."micro_live_account_mode" = 'exclusive' AND
      "micro_live_config"."micro_live_selected_subaccount" IS NOT NULL AND
      "micro_live_config"."micro_live_selected_subaccount" BETWEEN 1 AND 63
    )
  ),
	CONSTRAINT "micro_live_config_dedicated_pair_complete_check" CHECK (
    (
      "micro_live_config"."micro_live_selected_exchange_index" IS NULL AND
      "micro_live_config"."micro_live_restricted_api_key_id" IS NULL AND
      "micro_live_config"."micro_live_restricted_key_fingerprint" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_subaccount" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_exchange_index" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_transfer_id" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_transfer_at" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_amount_cents" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_micros" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_run_id" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_at" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_evidence_digest" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_run_id" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_cursor" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_at" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_evidence_digest" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_subaccount" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_exchange_index" IS NULL
    ) OR (
      "micro_live_config"."micro_live_selected_exchange_index" = 2 AND
      "micro_live_config"."micro_live_account_mode" = 'exclusive' AND
      "micro_live_config"."micro_live_selected_subaccount" BETWEEN 1 AND 63 AND
      "micro_live_config"."micro_live_restricted_api_key_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_restricted_api_key_id") <> '' AND
      "micro_live_config"."micro_live_restricted_key_fingerprint" ~ '^[0-9a-f]{64}$' AND
      "micro_live_config"."micro_live_funding_anchor_subaccount" = "micro_live_config"."micro_live_selected_subaccount" AND
      "micro_live_config"."micro_live_funding_anchor_exchange_index" = 2 AND
      "micro_live_config"."micro_live_funding_anchor_transfer_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_funding_anchor_transfer_id") <> '' AND
      "micro_live_config"."micro_live_funding_anchor_transfer_at" IS NOT NULL AND
      "micro_live_config"."micro_live_funding_anchor_amount_cents" = 2500 AND
      "micro_live_config"."micro_live_pair_cash_baseline_micros" = '25000000' AND
      "micro_live_config"."micro_live_pair_cash_baseline_run_id" = "micro_live_config"."micro_live_run_id" AND
      "micro_live_config"."micro_live_pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_evidence_digest" ~ '^[0-9a-f]{64}$' AND
      "micro_live_config"."micro_live_account_activity_checkpoint_run_id" = "micro_live_config"."micro_live_run_id" AND
      "micro_live_config"."micro_live_account_activity_checkpoint_cursor" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_account_activity_checkpoint_cursor") <> '' AND
      "micro_live_config"."micro_live_account_activity_checkpoint_at" IS NOT NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_evidence_digest" ~ '^[0-9a-f]{64}$' AND
      "micro_live_config"."micro_live_account_activity_checkpoint_subaccount" = "micro_live_config"."micro_live_selected_subaccount" AND
      "micro_live_config"."micro_live_account_activity_checkpoint_exchange_index" = 2
    )
  ),
	CONSTRAINT "micro_live_config_restricted_key_identity_check" CHECK (
    (
      "micro_live_config"."micro_live_restricted_api_key_id" IS NULL AND
      "micro_live_config"."micro_live_restricted_key_fingerprint" IS NULL
    ) OR (
      "micro_live_config"."micro_live_selected_exchange_index" IS NOT NULL AND
      "micro_live_config"."micro_live_selected_exchange_index" = 2 AND
      "micro_live_config"."micro_live_restricted_api_key_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_restricted_api_key_id") <> '' AND
      "micro_live_config"."micro_live_restricted_key_fingerprint" IS NOT NULL AND
      "micro_live_config"."micro_live_restricted_key_fingerprint" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_config_mode_account_pair_check" CHECK (
    ("micro_live_config"."micro_live_account_mode" IS NULL AND "micro_live_config"."micro_live_selected_subaccount" IS NULL) OR
    ("micro_live_config"."micro_live_account_mode" = 'exclusive' AND "micro_live_config"."micro_live_selected_subaccount" BETWEEN 1 AND 63) OR
    ("micro_live_config"."micro_live_account_mode" = 'primary_nonexclusive' AND "micro_live_config"."micro_live_selected_subaccount" = 0)
  ),
	CONSTRAINT "micro_live_config_primary_cash_baseline_consistency_check" CHECK (
    (
      "micro_live_config"."micro_live_primary_cash_baseline_micros" IS NULL AND
      "micro_live_config"."micro_live_primary_cash_baseline_run_id" IS NULL AND
      "micro_live_config"."micro_live_primary_cash_baseline_at" IS NULL AND
      "micro_live_config"."micro_live_primary_cash_baseline_evidence_digest" IS NULL
    ) OR (
      "micro_live_config"."micro_live_primary_cash_baseline_micros" IS NOT NULL AND
      "micro_live_config"."micro_live_primary_cash_baseline_micros" ~ '^(0|[1-9][0-9]*)$' AND
      "micro_live_config"."micro_live_primary_cash_baseline_run_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_primary_cash_baseline_run_id") <> '' AND
      "micro_live_config"."micro_live_primary_cash_baseline_at" IS NOT NULL AND
      "micro_live_config"."micro_live_primary_cash_baseline_evidence_digest" IS NOT NULL AND
      "micro_live_config"."micro_live_primary_cash_baseline_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_config_pair_cash_anchor_consistency_check" CHECK (
    (
      "micro_live_config"."micro_live_funding_anchor_subaccount" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_exchange_index" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_transfer_id" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_transfer_at" IS NULL AND
      "micro_live_config"."micro_live_funding_anchor_amount_cents" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_micros" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_run_id" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_at" IS NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_evidence_digest" IS NULL
    ) OR (
      "micro_live_config"."micro_live_selected_exchange_index" IS NOT NULL AND
      "micro_live_config"."micro_live_selected_exchange_index" = 2 AND
      "micro_live_config"."micro_live_selected_subaccount" IS NOT NULL AND
      "micro_live_config"."micro_live_funding_anchor_subaccount" IS NOT NULL AND
      "micro_live_config"."micro_live_funding_anchor_subaccount" BETWEEN 1 AND 63 AND
      "micro_live_config"."micro_live_funding_anchor_subaccount" = "micro_live_config"."micro_live_selected_subaccount" AND
      "micro_live_config"."micro_live_funding_anchor_exchange_index" IS NOT NULL AND
      "micro_live_config"."micro_live_funding_anchor_exchange_index" = 2 AND
      "micro_live_config"."micro_live_funding_anchor_exchange_index" = "micro_live_config"."micro_live_selected_exchange_index" AND
      "micro_live_config"."micro_live_restricted_api_key_id" IS NOT NULL AND
      "micro_live_config"."micro_live_restricted_key_fingerprint" IS NOT NULL AND
      "micro_live_config"."micro_live_funding_anchor_transfer_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_funding_anchor_transfer_id") <> '' AND
      "micro_live_config"."micro_live_funding_anchor_transfer_at" IS NOT NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_config"."micro_live_funding_anchor_transfer_at" <= "micro_live_config"."micro_live_pair_cash_baseline_at" AND
      "micro_live_config"."micro_live_funding_anchor_amount_cents" IS NOT NULL AND
      "micro_live_config"."micro_live_funding_anchor_amount_cents" = 2500 AND
      "micro_live_config"."micro_live_pair_cash_baseline_micros" IS NOT NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_micros" = '25000000' AND
      "micro_live_config"."micro_live_pair_cash_baseline_run_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_pair_cash_baseline_run_id") <> '' AND
      "micro_live_config"."micro_live_run_id" IS NOT NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_run_id" = "micro_live_config"."micro_live_run_id" AND
      "micro_live_config"."micro_live_pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_evidence_digest" IS NOT NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_config_primary_activity_checkpoint_consistency_check" CHECK (
    (
      "micro_live_config"."micro_live_primary_activity_checkpoint_run_id" IS NULL AND
      "micro_live_config"."micro_live_primary_activity_checkpoint_cursor" IS NULL AND
      "micro_live_config"."micro_live_primary_activity_checkpoint_at" IS NULL AND
      "micro_live_config"."micro_live_primary_activity_checkpoint_evidence_digest" IS NULL
    ) OR (
      "micro_live_config"."micro_live_primary_activity_checkpoint_run_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_primary_activity_checkpoint_run_id") <> '' AND
      "micro_live_config"."micro_live_primary_activity_checkpoint_cursor" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_primary_activity_checkpoint_cursor") <> '' AND
      "micro_live_config"."micro_live_primary_activity_checkpoint_at" IS NOT NULL AND
      "micro_live_config"."micro_live_primary_activity_checkpoint_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_config_account_activity_checkpoint_consistency_check" CHECK (
    (
      "micro_live_config"."micro_live_account_activity_checkpoint_run_id" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_cursor" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_at" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_evidence_digest" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_subaccount" IS NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_exchange_index" IS NULL
    ) OR (
      "micro_live_config"."micro_live_selected_exchange_index" IS NOT NULL AND
      "micro_live_config"."micro_live_selected_exchange_index" = 2 AND
      "micro_live_config"."micro_live_account_activity_checkpoint_run_id" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_account_activity_checkpoint_run_id") <> '' AND
      "micro_live_config"."micro_live_run_id" IS NOT NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_run_id" = "micro_live_config"."micro_live_run_id" AND
      "micro_live_config"."micro_live_account_activity_checkpoint_cursor" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_account_activity_checkpoint_cursor") <> '' AND
      "micro_live_config"."micro_live_account_activity_checkpoint_at" IS NOT NULL AND
      "micro_live_config"."micro_live_pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_at" >= "micro_live_config"."micro_live_pair_cash_baseline_at" AND
      "micro_live_config"."micro_live_account_activity_checkpoint_evidence_digest" IS NOT NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_evidence_digest" ~ '^[0-9a-f]{64}$' AND
      "micro_live_config"."micro_live_account_activity_checkpoint_subaccount" IS NOT NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_subaccount" =
        "micro_live_config"."micro_live_selected_subaccount" AND
      "micro_live_config"."micro_live_account_activity_checkpoint_exchange_index" IS NOT NULL AND
      "micro_live_config"."micro_live_account_activity_checkpoint_exchange_index" =
        "micro_live_config"."micro_live_selected_exchange_index"
    )
  ),
	CONSTRAINT "micro_live_config_micro_budget_check" CHECK (
    "micro_live_config"."micro_live_run_cap_micros" BETWEEN 1000000 AND 5000000 AND
    "micro_live_config"."micro_live_reserved_micros" >= 0 AND
    "micro_live_config"."micro_live_reserved_micros" <= "micro_live_config"."micro_live_run_cap_micros" AND
    ("micro_live_config"."micro_live_entry_attempted" = false OR "micro_live_config"."micro_live_run_id" IS NOT NULL)
  ),
	CONSTRAINT "micro_live_config_fee_approval_consistency_check" CHECK (
    (
      "micro_live_config"."micro_live_fee_approval_approved" = false AND
      "micro_live_config"."micro_live_fee_approval_id" IS NULL AND
      "micro_live_config"."micro_live_fee_approval_digest" IS NULL AND
      "micro_live_config"."micro_live_fee_approval_approved_at" IS NULL AND
      "micro_live_config"."micro_live_fee_policy_version" IS NULL AND
      "micro_live_config"."micro_live_fee_maximum_exposure_micros" IS NULL AND
      "micro_live_config"."micro_live_fee_approved_by" IS NULL AND
      "micro_live_config"."micro_live_fee_approved_run_cap_micros" IS NULL
    ) OR (
      "micro_live_config"."micro_live_fee_approval_id" IS NOT NULL AND
      "micro_live_config"."micro_live_fee_approval_id" <> '' AND
      "micro_live_config"."micro_live_fee_approval_digest" ~ '^[0-9a-f]{64}$' AND
      "micro_live_config"."micro_live_fee_approval_approved_at" IS NOT NULL AND
      "micro_live_config"."micro_live_fee_policy_version" IS NOT NULL AND
      "micro_live_config"."micro_live_fee_policy_version" <> '' AND
      "micro_live_config"."micro_live_fee_maximum_exposure_micros" BETWEEN 1 AND 5000000 AND
      "micro_live_config"."micro_live_fee_approved_by" IS NOT NULL AND
      btrim("micro_live_config"."micro_live_fee_approved_by") <> '' AND
      "micro_live_config"."micro_live_fee_approved_run_cap_micros" BETWEEN 1000000 AND 5000000 AND
      (
        "micro_live_config"."micro_live_fee_approval_approved" = false OR
        (
          "micro_live_config"."micro_live_fee_approval_invalidated" = false AND
          "micro_live_config"."micro_live_run_cap_micros" <= "micro_live_config"."micro_live_fee_approved_run_cap_micros" AND
          "micro_live_config"."micro_live_run_cap_micros" <= "micro_live_config"."micro_live_fee_maximum_exposure_micros" AND
          "micro_live_config"."micro_live_run_cap_micros" <= 5000000
        )
      )
    )
  ),
	CONSTRAINT "micro_live_config_fee_approval_artifact_identity_check" CHECK (
    "micro_live_config"."micro_live_fee_approval_approved" = false OR
    (
      "micro_live_config"."micro_live_fee_policy_version" = 'micro-live-standing-fee-policy-v1' AND
      "micro_live_config"."micro_live_fee_approval_source_url" = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf' AND
      "micro_live_config"."micro_live_fee_formula_version" = 'standard-quadratic-0.07-v1'
    )
  ),
	CONSTRAINT "micro_live_config_fee_artifact_status_check" CHECK (
    "micro_live_config"."micro_live_fee_artifact_status" IN ('unverified', 'verified', 'changed', 'unavailable', 'invalid')
  ),
	CONSTRAINT "micro_live_config_run_phase_check" CHECK (
    "micro_live_config"."micro_live_run_phase" IN ('UNARMED', 'PREPARING', 'ENTRY_OPEN', 'EXIT_ONLY', 'FROZEN')
  ),
	CONSTRAINT "micro_live_config_bankroll_check" CHECK (
    "micro_live_config"."max_live_bankroll_cents" >= 0 AND "micro_live_config"."max_live_bankroll_cents" <= 2500
  ),
	CONSTRAINT "micro_live_config_risk_limits_check" CHECK (
    "micro_live_config"."max_single_order_risk_cents" >= 0 AND "micro_live_config"."max_single_order_risk_cents" <= 500 AND
    "micro_live_config"."max_open_positions" >= 0 AND "micro_live_config"."max_open_positions" <= 1 AND
    "micro_live_config"."max_cumulative_reserved_cents" >= 0 AND
    "micro_live_config"."max_cumulative_reserved_cents" <= "micro_live_config"."max_live_bankroll_cents" AND
    "micro_live_config"."max_scout_stake_cents" >= 0 AND "micro_live_config"."max_scout_stake_cents" <= 500 AND
    "micro_live_config"."max_confirm_additional_stake_cents" >= 0 AND
    "micro_live_config"."max_confirm_additional_stake_cents" <= 500
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_pair_boundary" (
	"subaccount_number" integer PRIMARY KEY NOT NULL,
	"exchange_index" integer DEFAULT 2 NOT NULL,
	"restricted_api_key_id" text,
	"restricted_key_fingerprint" text,
	"clean_balance_micros" text NOT NULL,
	"clean_balance_semantics" text NOT NULL,
	"clean_snapshot_authenticated" boolean NOT NULL,
	"clean_order_count" integer NOT NULL,
	"clean_fill_count" integer NOT NULL,
	"clean_position_count" integer NOT NULL,
	"clean_settlement_count" integer NOT NULL,
	"clean_boundary_at" timestamp with time zone NOT NULL,
	"clean_boundary_evidence_digest" text NOT NULL,
	"creation_attempt_id" text,
	"creation_inventory_digest" text,
	"key_bound_at" timestamp with time zone,
	"key_binding_evidence_digest" text,
	"state" text DEFAULT 'CREATED_CLEAN' NOT NULL,
	"funding_transfer_id" text,
	"funding_amount_cents" integer,
	"funding_transferred_at" timestamp with time zone,
	"post_funding_balance_micros" text,
	"post_funding_balance_semantics" text,
	"post_funding_snapshot_authenticated" boolean,
	"post_funding_snapshot_at" timestamp with time zone,
	"post_funding_evidence_digest" text,
	"initialized_run_id" text,
	"initialized_at" timestamp with time zone,
	"activity_checkpoint_cursor" text,
	"activity_checkpoint_at" timestamp with time zone,
	"activity_checkpoint_digest" text,
	"ambiguity_frozen_at" timestamp with time zone,
	"ambiguity_freeze_reason" text,
	"ambiguity_evidence_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_pair_boundary_identity_check" CHECK (
    "micro_live_pair_boundary"."subaccount_number" BETWEEN 1 AND 63 AND
    "micro_live_pair_boundary"."exchange_index" = 2 AND
    (
      ("micro_live_pair_boundary"."restricted_api_key_id" IS NULL AND "micro_live_pair_boundary"."restricted_key_fingerprint" IS NULL) OR
      (btrim("micro_live_pair_boundary"."restricted_api_key_id") <> '' AND
       "micro_live_pair_boundary"."restricted_key_fingerprint" ~ '^[0-9a-f]{64}$')
    )
  ),
	CONSTRAINT "micro_live_pair_boundary_clean_snapshot_check" CHECK (
    "micro_live_pair_boundary"."clean_balance_micros" = '0' AND
    "micro_live_pair_boundary"."clean_balance_semantics" = 'available_cash' AND
    "micro_live_pair_boundary"."clean_snapshot_authenticated" = true AND
    "micro_live_pair_boundary"."clean_order_count" = 0 AND
    "micro_live_pair_boundary"."clean_fill_count" = 0 AND
    "micro_live_pair_boundary"."clean_position_count" = 0 AND
    "micro_live_pair_boundary"."clean_settlement_count" = 0 AND
    isfinite("micro_live_pair_boundary"."clean_boundary_at") AND
    "micro_live_pair_boundary"."clean_boundary_evidence_digest" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "micro_live_pair_boundary_creation_provenance_check" CHECK (
    (
      "micro_live_pair_boundary"."creation_attempt_id" IS NULL AND
      "micro_live_pair_boundary"."state" NOT IN ('CREATED_CLEAN', 'KEY_BOUND_VERIFIED') AND
      "micro_live_pair_boundary"."creation_inventory_digest" IS NULL AND
      "micro_live_pair_boundary"."key_bound_at" IS NULL AND
      "micro_live_pair_boundary"."key_binding_evidence_digest" IS NULL
    ) OR (
      "micro_live_pair_boundary"."state" <> 'clean_boundary' AND
      "micro_live_pair_boundary"."creation_attempt_id" IS NOT NULL AND
      btrim("micro_live_pair_boundary"."creation_attempt_id") <> '' AND
      "micro_live_pair_boundary"."creation_inventory_digest" IS NOT NULL AND
      "micro_live_pair_boundary"."creation_inventory_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_pair_boundary_key_binding_atomic_check" CHECK (
    (
      "micro_live_pair_boundary"."creation_attempt_id" IS NULL AND
      "micro_live_pair_boundary"."key_bound_at" IS NULL AND
      "micro_live_pair_boundary"."key_binding_evidence_digest" IS NULL
    ) OR (
      "micro_live_pair_boundary"."state" IN ('CREATED_CLEAN', 'clean_boundary') AND
      "micro_live_pair_boundary"."key_bound_at" IS NULL AND
      "micro_live_pair_boundary"."key_binding_evidence_digest" IS NULL
    ) OR (
      "micro_live_pair_boundary"."state" IN ('KEY_BOUND_VERIFIED', 'funded', 'initialized', 'frozen') AND
      "micro_live_pair_boundary"."restricted_api_key_id" IS NOT NULL AND
      btrim("micro_live_pair_boundary"."restricted_api_key_id") <> '' AND
      "micro_live_pair_boundary"."restricted_key_fingerprint" IS NOT NULL AND
      "micro_live_pair_boundary"."restricted_key_fingerprint" ~ '^[0-9a-f]{64}$' AND
      "micro_live_pair_boundary"."key_bound_at" IS NOT NULL AND isfinite("micro_live_pair_boundary"."key_bound_at") AND
      "micro_live_pair_boundary"."key_binding_evidence_digest" IS NOT NULL AND
      "micro_live_pair_boundary"."key_binding_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_pair_boundary_funding_atomic_check" CHECK (
    (
      "micro_live_pair_boundary"."funding_transfer_id" IS NULL AND
      "micro_live_pair_boundary"."funding_amount_cents" IS NULL AND
      "micro_live_pair_boundary"."funding_transferred_at" IS NULL AND
      "micro_live_pair_boundary"."post_funding_balance_micros" IS NULL AND
      "micro_live_pair_boundary"."post_funding_balance_semantics" IS NULL AND
      "micro_live_pair_boundary"."post_funding_snapshot_authenticated" IS NULL AND
      "micro_live_pair_boundary"."post_funding_snapshot_at" IS NULL AND
      "micro_live_pair_boundary"."post_funding_evidence_digest" IS NULL
    ) OR (
      "micro_live_pair_boundary"."funding_transfer_id" IS NOT NULL AND
      "micro_live_pair_boundary"."funding_transfer_id" ~ '^[A-Za-z0-9._:-]{1,128}$' AND
      "micro_live_pair_boundary"."funding_amount_cents" IS NOT NULL AND
      "micro_live_pair_boundary"."funding_amount_cents" = 2500 AND
      "micro_live_pair_boundary"."funding_transferred_at" IS NOT NULL AND
      isfinite("micro_live_pair_boundary"."funding_transferred_at") AND
      "micro_live_pair_boundary"."funding_transferred_at" >= "micro_live_pair_boundary"."clean_boundary_at" AND
      "micro_live_pair_boundary"."post_funding_balance_micros" IS NOT NULL AND
      "micro_live_pair_boundary"."post_funding_balance_micros" = '25000000' AND
      "micro_live_pair_boundary"."post_funding_balance_semantics" = 'available_cash' AND
      "micro_live_pair_boundary"."post_funding_snapshot_authenticated" = true AND
      "micro_live_pair_boundary"."post_funding_snapshot_at" IS NOT NULL AND
      isfinite("micro_live_pair_boundary"."post_funding_snapshot_at") AND
      "micro_live_pair_boundary"."post_funding_snapshot_at" >= "micro_live_pair_boundary"."funding_transferred_at" AND
      "micro_live_pair_boundary"."post_funding_evidence_digest" IS NOT NULL AND
      "micro_live_pair_boundary"."post_funding_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_pair_boundary_initialized_atomic_check" CHECK (
    (
      "micro_live_pair_boundary"."initialized_run_id" IS NULL AND
      "micro_live_pair_boundary"."initialized_at" IS NULL
    ) OR (
      "micro_live_pair_boundary"."funding_transfer_id" IS NOT NULL AND
      "micro_live_pair_boundary"."post_funding_evidence_digest" IS NOT NULL AND
      "micro_live_pair_boundary"."initialized_run_id" IS NOT NULL AND
      btrim("micro_live_pair_boundary"."initialized_run_id") <> '' AND
      "micro_live_pair_boundary"."initialized_at" IS NOT NULL AND
      isfinite("micro_live_pair_boundary"."initialized_at") AND
      "micro_live_pair_boundary"."initialized_at" >= "micro_live_pair_boundary"."post_funding_snapshot_at"
    )
  ),
	CONSTRAINT "micro_live_pair_boundary_checkpoint_atomic_check" CHECK (
    (
      "micro_live_pair_boundary"."activity_checkpoint_cursor" IS NULL AND
      "micro_live_pair_boundary"."activity_checkpoint_at" IS NULL AND
      "micro_live_pair_boundary"."activity_checkpoint_digest" IS NULL
    ) OR (
      "micro_live_pair_boundary"."activity_checkpoint_cursor" IS NOT NULL AND
      btrim("micro_live_pair_boundary"."activity_checkpoint_cursor") <> '' AND
      length("micro_live_pair_boundary"."activity_checkpoint_cursor") <= 4096 AND
      "micro_live_pair_boundary"."activity_checkpoint_at" IS NOT NULL AND
      isfinite("micro_live_pair_boundary"."activity_checkpoint_at") AND
      "micro_live_pair_boundary"."activity_checkpoint_at" >= "micro_live_pair_boundary"."clean_boundary_at" AND
      "micro_live_pair_boundary"."activity_checkpoint_digest" IS NOT NULL AND
      "micro_live_pair_boundary"."activity_checkpoint_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_pair_boundary_ambiguity_freeze_atomic_check" CHECK (
    (
      "micro_live_pair_boundary"."ambiguity_frozen_at" IS NULL AND
      "micro_live_pair_boundary"."ambiguity_freeze_reason" IS NULL AND
      "micro_live_pair_boundary"."ambiguity_evidence_digest" IS NULL
    ) OR (
      "micro_live_pair_boundary"."state" = 'frozen' AND
      "micro_live_pair_boundary"."ambiguity_frozen_at" IS NOT NULL AND
      isfinite("micro_live_pair_boundary"."ambiguity_frozen_at") AND
      "micro_live_pair_boundary"."ambiguity_freeze_reason" IS NOT NULL AND
      btrim("micro_live_pair_boundary"."ambiguity_freeze_reason") <> '' AND
      "micro_live_pair_boundary"."ambiguity_evidence_digest" IS NOT NULL AND
      "micro_live_pair_boundary"."ambiguity_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_pair_boundary_state_check" CHECK (
    (
      "micro_live_pair_boundary"."state" IN ('clean_boundary', 'CREATED_CLEAN', 'KEY_BOUND_VERIFIED') AND
      "micro_live_pair_boundary"."funding_transfer_id" IS NULL AND
      "micro_live_pair_boundary"."initialized_run_id" IS NULL AND
      "micro_live_pair_boundary"."ambiguity_frozen_at" IS NULL
    ) OR (
      "micro_live_pair_boundary"."state" = 'funded' AND
      "micro_live_pair_boundary"."funding_transfer_id" IS NOT NULL AND
      "micro_live_pair_boundary"."initialized_run_id" IS NULL AND
      "micro_live_pair_boundary"."ambiguity_frozen_at" IS NULL AND
      ("micro_live_pair_boundary"."creation_attempt_id" IS NULL OR "micro_live_pair_boundary"."key_bound_at" IS NOT NULL)
    ) OR (
      "micro_live_pair_boundary"."state" = 'initialized' AND
      "micro_live_pair_boundary"."funding_transfer_id" IS NOT NULL AND
      "micro_live_pair_boundary"."initialized_run_id" IS NOT NULL AND
      "micro_live_pair_boundary"."ambiguity_frozen_at" IS NULL AND
      ("micro_live_pair_boundary"."creation_attempt_id" IS NULL OR "micro_live_pair_boundary"."key_bound_at" IS NOT NULL)
    ) OR (
      "micro_live_pair_boundary"."state" = 'frozen' AND
      "micro_live_pair_boundary"."ambiguity_frozen_at" IS NOT NULL AND
      ("micro_live_pair_boundary"."creation_attempt_id" IS NULL OR "micro_live_pair_boundary"."key_bound_at" IS NOT NULL)
    )
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_fee_verification" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"approval_digest" text NOT NULL,
	"policy_version" text NOT NULL,
	"source_url" text NOT NULL,
	"formula_version" text NOT NULL,
	"status" text NOT NULL,
	"attempt_id" text,
	"reason" text,
	"fee_evidence_fingerprint" text,
	"checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_fee_verification_status_check" CHECK (
    "micro_live_fee_verification"."status" IN ('pending', 'verified', 'unavailable', 'invalid')
  ),
	CONSTRAINT "micro_live_fee_verification_attempt_check" CHECK (
    ("micro_live_fee_verification"."status" = 'pending' AND "micro_live_fee_verification"."attempt_id" IS NOT NULL) OR
    ("micro_live_fee_verification"."status" <> 'pending' AND "micro_live_fee_verification"."attempt_id" IS NULL)
  ),
	CONSTRAINT "micro_live_fee_verification_identity_check" CHECK (
    "micro_live_fee_verification"."approval_digest" ~ '^[0-9a-f]{64}$' AND
    btrim("micro_live_fee_verification"."approval_id") <> '' AND
    btrim("micro_live_fee_verification"."policy_version") <> '' AND
    btrim("micro_live_fee_verification"."source_url") <> '' AND
    btrim("micro_live_fee_verification"."formula_version") <> ''
  ),
	CONSTRAINT "micro_live_fee_verification_verified_evidence_check" CHECK (
    "micro_live_fee_verification"."status" <> 'verified' OR (
      "micro_live_fee_verification"."checked_at" IS NOT NULL AND
      isfinite("micro_live_fee_verification"."checked_at") AND
      "micro_live_fee_verification"."fee_evidence_fingerprint" IS NOT NULL AND
      btrim("micro_live_fee_verification"."fee_evidence_fingerprint") <> ''
    )
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_run_archive" (
	"prior_run_id" text PRIMARY KEY NOT NULL,
	"successor_run_id" text NOT NULL,
	"phase" text NOT NULL,
	"armed_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone,
	"approval_id" text NOT NULL,
	"approval_digest" text NOT NULL,
	"approval_source_url" text,
	"approval_formula_version" text,
	"approval_approver" text,
	"freeze_reason" text NOT NULL,
	"cap_micros" integer NOT NULL,
	"reserved_micros" integer NOT NULL,
	"entry_attempted" boolean NOT NULL,
	"exit_attempted" boolean NOT NULL,
	"account_mode" text NOT NULL,
	"selected_subaccount" integer NOT NULL,
	"selected_exchange_index" integer,
	"restricted_api_key_id" text,
	"restricted_key_fingerprint" text,
	"funding_anchor_subaccount" integer,
	"funding_anchor_exchange_index" integer,
	"funding_anchor_transfer_id" text,
	"funding_anchor_transfer_at" timestamp with time zone,
	"funding_anchor_amount_cents" integer,
	"pair_cash_baseline_micros" text,
	"pair_cash_baseline_run_id" text,
	"pair_cash_baseline_at" timestamp with time zone,
	"pair_cash_baseline_evidence_digest" text,
	"account_activity_checkpoint_subaccount" integer,
	"account_activity_checkpoint_exchange_index" integer,
	"account_activity_checkpoint_run_id" text,
	"account_activity_checkpoint_cursor" text,
	"account_activity_checkpoint_at" timestamp with time zone,
	"account_activity_checkpoint_evidence_digest" text,
	"max_live_bankroll_cents" integer NOT NULL,
	"max_single_order_risk_cents" integer NOT NULL,
	"max_cumulative_reserved_cents" integer NOT NULL,
	"max_scout_stake_cents" integer NOT NULL,
	"max_confirm_additional_stake_cents" integer NOT NULL,
	"actor_id" text NOT NULL,
	"transition_reason" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_run_archive_successor_run_id_unique" UNIQUE("successor_run_id"),
	CONSTRAINT "micro_live_run_archive_unused_frozen_v2_check" CHECK (
    "micro_live_run_archive"."phase" = 'FROZEN' AND "micro_live_run_archive"."cap_micros" IN (1000000, 5000000) AND
    "micro_live_run_archive"."reserved_micros" = 0 AND
    "micro_live_run_archive"."entry_attempted" = false AND "micro_live_run_archive"."exit_attempted" = false AND
    "micro_live_run_archive"."freeze_reason" IN (
      'entry_expired_without_proven_terminal_position',
      'operator_froze_unused_run_for_reviewed_transition'
    )
  ),
	CONSTRAINT "micro_live_run_archive_fee_provenance_check" CHECK (
    (
      "micro_live_run_archive"."approval_source_url" IS NULL AND
      "micro_live_run_archive"."approval_formula_version" IS NULL AND
      "micro_live_run_archive"."approval_approver" IS NULL
    ) OR (
      "micro_live_run_archive"."approval_source_url" = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf' AND
      "micro_live_run_archive"."approval_formula_version" = 'standard-quadratic-0.07-v1' AND
      btrim("micro_live_run_archive"."approval_approver") <> ''
    )
  ),
	CONSTRAINT "micro_live_run_archive_account_identity_check" CHECK (
    (
      "micro_live_run_archive"."selected_exchange_index" IS NULL AND
      "micro_live_run_archive"."restricted_api_key_id" IS NULL AND
      "micro_live_run_archive"."restricted_key_fingerprint" IS NULL
    ) OR (
      "micro_live_run_archive"."selected_exchange_index" IS NOT NULL AND
      "micro_live_run_archive"."selected_exchange_index" = 2 AND
      "micro_live_run_archive"."account_mode" = 'exclusive' AND
      "micro_live_run_archive"."selected_subaccount" BETWEEN 1 AND 63 AND
      "micro_live_run_archive"."restricted_api_key_id" IS NOT NULL AND
      btrim("micro_live_run_archive"."restricted_api_key_id") <> '' AND
      "micro_live_run_archive"."restricted_key_fingerprint" IS NOT NULL AND
      "micro_live_run_archive"."restricted_key_fingerprint" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_run_archive_funding_anchor_check" CHECK (
    (
      "micro_live_run_archive"."funding_anchor_subaccount" IS NULL AND
      "micro_live_run_archive"."funding_anchor_exchange_index" IS NULL AND
      "micro_live_run_archive"."funding_anchor_transfer_id" IS NULL AND
      "micro_live_run_archive"."funding_anchor_transfer_at" IS NULL AND
      "micro_live_run_archive"."funding_anchor_amount_cents" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_micros" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_run_id" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_at" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_evidence_digest" IS NULL
    ) OR (
      "micro_live_run_archive"."selected_exchange_index" IS NOT NULL AND
      "micro_live_run_archive"."selected_exchange_index" = 2 AND
      "micro_live_run_archive"."funding_anchor_subaccount" IS NOT NULL AND
      "micro_live_run_archive"."funding_anchor_subaccount" = "micro_live_run_archive"."selected_subaccount" AND
      "micro_live_run_archive"."funding_anchor_exchange_index" IS NOT NULL AND
      "micro_live_run_archive"."funding_anchor_exchange_index" = "micro_live_run_archive"."selected_exchange_index" AND
      "micro_live_run_archive"."restricted_api_key_id" IS NOT NULL AND
      "micro_live_run_archive"."restricted_key_fingerprint" IS NOT NULL AND
      "micro_live_run_archive"."funding_anchor_transfer_id" IS NOT NULL AND
      btrim("micro_live_run_archive"."funding_anchor_transfer_id") <> '' AND
      "micro_live_run_archive"."funding_anchor_transfer_at" IS NOT NULL AND
      "micro_live_run_archive"."pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_run_archive"."funding_anchor_transfer_at" <= "micro_live_run_archive"."pair_cash_baseline_at" AND
      "micro_live_run_archive"."funding_anchor_amount_cents" IS NOT NULL AND
      "micro_live_run_archive"."funding_anchor_amount_cents" = 2500 AND
      "micro_live_run_archive"."pair_cash_baseline_micros" IS NOT NULL AND
      "micro_live_run_archive"."pair_cash_baseline_micros" = '25000000' AND
      "micro_live_run_archive"."pair_cash_baseline_run_id" IS NOT NULL AND
      btrim("micro_live_run_archive"."pair_cash_baseline_run_id") <> '' AND
      "micro_live_run_archive"."pair_cash_baseline_run_id" = "micro_live_run_archive"."prior_run_id" AND
      "micro_live_run_archive"."pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_run_archive"."pair_cash_baseline_evidence_digest" IS NOT NULL AND
      "micro_live_run_archive"."pair_cash_baseline_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_run_archive_activity_checkpoint_identity_check" CHECK (
    (
      "micro_live_run_archive"."account_activity_checkpoint_subaccount" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_exchange_index" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_run_id" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_cursor" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_at" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_evidence_digest" IS NULL
    ) OR (
      "micro_live_run_archive"."selected_exchange_index" IS NOT NULL AND
      "micro_live_run_archive"."selected_exchange_index" = 2 AND
      "micro_live_run_archive"."account_activity_checkpoint_subaccount" IS NOT NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_subaccount" = "micro_live_run_archive"."selected_subaccount" AND
      "micro_live_run_archive"."account_activity_checkpoint_exchange_index" IS NOT NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_exchange_index" = "micro_live_run_archive"."selected_exchange_index" AND
      "micro_live_run_archive"."account_activity_checkpoint_run_id" IS NOT NULL AND
      btrim("micro_live_run_archive"."account_activity_checkpoint_run_id") <> '' AND
      "micro_live_run_archive"."account_activity_checkpoint_cursor" IS NOT NULL AND
      btrim("micro_live_run_archive"."account_activity_checkpoint_cursor") <> '' AND
      "micro_live_run_archive"."account_activity_checkpoint_at" IS NOT NULL AND
      "micro_live_run_archive"."pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_at" >= "micro_live_run_archive"."pair_cash_baseline_at" AND
      "micro_live_run_archive"."account_activity_checkpoint_evidence_digest" IS NOT NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "micro_live_run_archive_dedicated_pair_complete_check" CHECK (
    (
      "micro_live_run_archive"."selected_exchange_index" IS NULL AND
      "micro_live_run_archive"."restricted_api_key_id" IS NULL AND
      "micro_live_run_archive"."restricted_key_fingerprint" IS NULL AND
      "micro_live_run_archive"."funding_anchor_subaccount" IS NULL AND
      "micro_live_run_archive"."funding_anchor_exchange_index" IS NULL AND
      "micro_live_run_archive"."funding_anchor_transfer_id" IS NULL AND
      "micro_live_run_archive"."funding_anchor_transfer_at" IS NULL AND
      "micro_live_run_archive"."funding_anchor_amount_cents" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_micros" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_run_id" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_at" IS NULL AND
      "micro_live_run_archive"."pair_cash_baseline_evidence_digest" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_subaccount" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_exchange_index" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_run_id" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_cursor" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_at" IS NULL AND
      "micro_live_run_archive"."account_activity_checkpoint_evidence_digest" IS NULL
    ) OR (
      "micro_live_run_archive"."selected_exchange_index" = 2 AND
      "micro_live_run_archive"."account_mode" = 'exclusive' AND
      "micro_live_run_archive"."selected_subaccount" BETWEEN 1 AND 63 AND
      "micro_live_run_archive"."restricted_api_key_id" IS NOT NULL AND
      btrim("micro_live_run_archive"."restricted_api_key_id") <> '' AND
      "micro_live_run_archive"."restricted_key_fingerprint" ~ '^[0-9a-f]{64}$' AND
      "micro_live_run_archive"."funding_anchor_subaccount" = "micro_live_run_archive"."selected_subaccount" AND
      "micro_live_run_archive"."funding_anchor_exchange_index" = 2 AND
      "micro_live_run_archive"."funding_anchor_transfer_id" IS NOT NULL AND
      btrim("micro_live_run_archive"."funding_anchor_transfer_id") <> '' AND
      "micro_live_run_archive"."funding_anchor_transfer_at" IS NOT NULL AND
      "micro_live_run_archive"."funding_anchor_amount_cents" = 2500 AND
      "micro_live_run_archive"."pair_cash_baseline_micros" = '25000000' AND
      "micro_live_run_archive"."pair_cash_baseline_run_id" = "micro_live_run_archive"."prior_run_id" AND
      "micro_live_run_archive"."pair_cash_baseline_at" IS NOT NULL AND
      "micro_live_run_archive"."funding_anchor_transfer_at" <= "micro_live_run_archive"."pair_cash_baseline_at" AND
      "micro_live_run_archive"."pair_cash_baseline_evidence_digest" ~ '^[0-9a-f]{64}$' AND
      "micro_live_run_archive"."account_activity_checkpoint_subaccount" = "micro_live_run_archive"."selected_subaccount" AND
      "micro_live_run_archive"."account_activity_checkpoint_exchange_index" = 2 AND
      "micro_live_run_archive"."account_activity_checkpoint_run_id" = "micro_live_run_archive"."prior_run_id" AND
      "micro_live_run_archive"."account_activity_checkpoint_cursor" IS NOT NULL AND
      btrim("micro_live_run_archive"."account_activity_checkpoint_cursor") <> '' AND
      "micro_live_run_archive"."account_activity_checkpoint_at" >= "micro_live_run_archive"."pair_cash_baseline_at" AND
      "micro_live_run_archive"."account_activity_checkpoint_evidence_digest" ~ '^[0-9a-f]{64}$'
    )
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_commissioning_archive" (
	"prior_run_id" text PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"cap_micros" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"archived_by" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_commissioning_archive_frozen_check" CHECK (
    "micro_live_commissioning_archive"."phase" = 'FROZEN' AND "micro_live_commissioning_archive"."cap_micros" = 1000000 AND
    "micro_live_commissioning_archive"."snapshot_digest" ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_pair_fee_approval" (
	"subaccount_number" integer PRIMARY KEY NOT NULL,
	"exchange_index" integer NOT NULL,
	"prior_run_id" text NOT NULL,
	"restricted_api_key_id" text NOT NULL,
	"restricted_key_fingerprint" text NOT NULL,
	"funding_transfer_id" text NOT NULL,
	"funding_evidence_digest" text NOT NULL,
	"all_in_cap_micros" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"review_id" text,
	"pdf_digest" text,
	"review_source" text,
	"source_attested_by" text,
	"source_attested_at" timestamp with time zone,
	"review_expires_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_pair_fee_approval_scope_check" CHECK (
    "micro_live_pair_fee_approval"."subaccount_number" = 1 AND "micro_live_pair_fee_approval"."exchange_index" = 2 AND
    "micro_live_pair_fee_approval"."all_in_cap_micros" = 1000000 AND
    "micro_live_pair_fee_approval"."restricted_key_fingerprint" ~ '^[0-9a-f]{64}$' AND
    "micro_live_pair_fee_approval"."funding_evidence_digest" ~ '^[0-9a-f]{64}$' AND
    "micro_live_pair_fee_approval"."state" IN ('pending', 'reviewed', 'approved') AND
    ("micro_live_pair_fee_approval"."review_source" IS NULL OR "micro_live_pair_fee_approval"."review_source" IN
      ('server_fetched', 'owner_attested_http_429_2026_09_27')) AND
    (("micro_live_pair_fee_approval"."review_source" = 'server_fetched' AND
      "micro_live_pair_fee_approval"."source_attested_by" IS NULL AND "micro_live_pair_fee_approval"."source_attested_at" IS NULL) OR
     ("micro_live_pair_fee_approval"."review_source" = 'owner_attested_http_429_2026_09_27' AND
      "micro_live_pair_fee_approval"."source_attested_by" IS NOT NULL AND "micro_live_pair_fee_approval"."source_attested_at" IS NOT NULL) OR
     ("micro_live_pair_fee_approval"."review_source" IS NULL AND
      "micro_live_pair_fee_approval"."source_attested_by" IS NULL AND "micro_live_pair_fee_approval"."source_attested_at" IS NULL)) AND
    (("micro_live_pair_fee_approval"."state" = 'pending' AND "micro_live_pair_fee_approval"."review_id" IS NULL AND
      "micro_live_pair_fee_approval"."pdf_digest" IS NULL AND "micro_live_pair_fee_approval"."review_source" IS NULL AND
      "micro_live_pair_fee_approval"."review_expires_at" IS NULL AND
      "micro_live_pair_fee_approval"."approved_by" IS NULL AND "micro_live_pair_fee_approval"."approved_at" IS NULL) OR
     ("micro_live_pair_fee_approval"."state" = 'reviewed' AND "micro_live_pair_fee_approval"."review_id" IS NOT NULL AND
      "micro_live_pair_fee_approval"."pdf_digest" ~ '^[0-9a-f]{64}$' AND
       "micro_live_pair_fee_approval"."review_source" IS NOT NULL AND
      "micro_live_pair_fee_approval"."review_expires_at" IS NOT NULL AND "micro_live_pair_fee_approval"."approved_by" IS NULL AND
      "micro_live_pair_fee_approval"."approved_at" IS NULL) OR
     ("micro_live_pair_fee_approval"."state" = 'approved' AND "micro_live_pair_fee_approval"."review_id" IS NOT NULL AND
      "micro_live_pair_fee_approval"."pdf_digest" ~ '^[0-9a-f]{64}$' AND
       "micro_live_pair_fee_approval"."review_source" IS NOT NULL AND
      "micro_live_pair_fee_approval"."approved_by" IS NOT NULL AND "micro_live_pair_fee_approval"."approved_at" IS NOT NULL))
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"action_key" text NOT NULL,
	"client_order_id" text NOT NULL,
	"market_ticker" text NOT NULL,
	"crossing_key" text NOT NULL,
	"trigger_type" text NOT NULL,
	"action" text DEFAULT 'buy' NOT NULL,
	"intent" text DEFAULT 'entry' NOT NULL,
	"position_id" text,
	"exit_position_id" text,
	"side" text NOT NULL,
	"source_evaluation_id" text NOT NULL,
	"signal_at" timestamp with time zone NOT NULL,
	"btc_signal_price" double precision,
	"target" double precision,
	"orderbook_quote_price" double precision,
	"quote_observed_at" timestamp with time zone,
	"order_type" text DEFAULT 'LIMIT' NOT NULL,
	"requested_limit_price" double precision NOT NULL,
	"requested_contracts" integer NOT NULL,
	"requested_stake_cents" integer NOT NULL,
	"reserved_risk_cents" integer DEFAULT 0 NOT NULL,
	"micro_live_run_id" text,
	"reserved_entry_fee_micros" integer,
	"reserved_exit_fee_micros" integer,
	"fee_evidence_fingerprint" text,
	"fee_evidence_verified_at" timestamp with time zone,
	"exchange_order_id" text,
	"cancellation_attempted_at" timestamp with time zone,
	"cancellation_authorized_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"average_fill_price" double precision,
	"filled_contracts" integer DEFAULT 0 NOT NULL,
	"remaining_contracts" integer NOT NULL,
	"canceled_at" timestamp with time zone,
	"filled_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"realized_pnl_cents" integer,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_orders_trigger_check" CHECK ("micro_live_orders"."trigger_type" IN ('SCOUT','CONFIRM','EXIT')),
	CONSTRAINT "micro_live_orders_cancellation_authorization_check" CHECK (
    "micro_live_orders"."cancellation_authorized_at" IS NULL OR
    ("micro_live_orders"."cancellation_attempted_at" IS NOT NULL AND
      "micro_live_orders"."cancellation_authorized_at" >= "micro_live_orders"."cancellation_attempted_at" AND
      "micro_live_orders"."action" = 'sell' AND "micro_live_orders"."intent" = 'exit')
  ),
	CONSTRAINT "micro_live_orders_action_check" CHECK ("micro_live_orders"."action" IN ('buy','sell')),
	CONSTRAINT "micro_live_orders_intent_check" CHECK ("micro_live_orders"."intent" IN ('entry','exit')),
	CONSTRAINT "micro_live_orders_sell_linkage_check" CHECK (
    ("micro_live_orders"."action" <> 'sell' OR (
      "micro_live_orders"."trigger_type" = 'EXIT' AND "micro_live_orders"."intent" = 'exit' AND
      "micro_live_orders"."exit_position_id" IS NOT NULL AND "micro_live_orders"."exit_position_id" <> ''
    )) AND
    ("micro_live_orders"."intent" <> 'exit' OR (
      "micro_live_orders"."action" = 'sell' AND "micro_live_orders"."trigger_type" = 'EXIT' AND
      "micro_live_orders"."exit_position_id" IS NOT NULL AND "micro_live_orders"."exit_position_id" <> ''
    ))
  ),
	CONSTRAINT "micro_live_orders_side_check" CHECK ("micro_live_orders"."side" IN ('UP','DOWN')),
	CONSTRAINT "micro_live_orders_type_check" CHECK ("micro_live_orders"."order_type" = 'LIMIT'),
	CONSTRAINT "micro_live_orders_status_check" CHECK ("micro_live_orders"."status" IN ('pending','unknown','partial','rejected','canceled','filled','closed')),
	CONSTRAINT "micro_live_orders_price_check" CHECK (
    "micro_live_orders"."requested_limit_price" > 0 AND "micro_live_orders"."requested_limit_price" <= 1 AND
    ("micro_live_orders"."orderbook_quote_price" IS NULL OR ("micro_live_orders"."orderbook_quote_price" > 0 AND "micro_live_orders"."orderbook_quote_price" <= 1)) AND
    ("micro_live_orders"."average_fill_price" IS NULL OR ("micro_live_orders"."average_fill_price" > 0 AND "micro_live_orders"."average_fill_price" <= 1))
  ),
	CONSTRAINT "micro_live_orders_amount_check" CHECK (
    "micro_live_orders"."requested_contracts" > 0 AND "micro_live_orders"."filled_contracts" >= 0 AND
    "micro_live_orders"."filled_contracts" <= "micro_live_orders"."requested_contracts" AND
    "micro_live_orders"."remaining_contracts" >= 0 AND
    "micro_live_orders"."filled_contracts" + "micro_live_orders"."remaining_contracts" <= "micro_live_orders"."requested_contracts" AND
    "micro_live_orders"."requested_stake_cents" >= 0 AND "micro_live_orders"."requested_stake_cents" <= 500 AND
    "micro_live_orders"."reserved_risk_cents" >= 0 AND "micro_live_orders"."reserved_risk_cents" <= "micro_live_orders"."requested_stake_cents" AND
    ("micro_live_orders"."trigger_type" <> 'SCOUT' OR "micro_live_orders"."requested_stake_cents" <= 250) AND
    ("micro_live_orders"."trigger_type" <> 'CONFIRM' OR "micro_live_orders"."requested_stake_cents" <= 250)
  ),
	CONSTRAINT "micro_live_orders_fee_reservation_check" CHECK (
    ("micro_live_orders"."reserved_entry_fee_micros" IS NULL OR "micro_live_orders"."reserved_entry_fee_micros" >= 0) AND
    ("micro_live_orders"."reserved_exit_fee_micros" IS NULL OR "micro_live_orders"."reserved_exit_fee_micros" >= 0)
  ),
	CONSTRAINT "micro_live_orders_active_run_fee_provenance_check" CHECK (
    "micro_live_orders"."micro_live_run_id" IS NULL OR "micro_live_orders"."status" NOT IN ('pending','unknown','partial','filled') OR (
      btrim("micro_live_orders"."micro_live_run_id") <> '' AND
      "micro_live_orders"."reserved_entry_fee_micros" IS NOT NULL AND "micro_live_orders"."reserved_entry_fee_micros" >= 0 AND
      "micro_live_orders"."reserved_exit_fee_micros" IS NOT NULL AND "micro_live_orders"."reserved_exit_fee_micros" >= 0 AND
      "micro_live_orders"."fee_evidence_fingerprint" IS NOT NULL AND btrim("micro_live_orders"."fee_evidence_fingerprint") <> '' AND
      "micro_live_orders"."fee_evidence_verified_at" IS NOT NULL
    )
  ),
	CONSTRAINT "micro_live_orders_signal_values_check" CHECK (
    ("micro_live_orders"."btc_signal_price" IS NULL OR "micro_live_orders"."btc_signal_price" > 0) AND
    ("micro_live_orders"."target" IS NULL OR "micro_live_orders"."target" > 0)
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"exchange_fill_id" text NOT NULL,
	"exchange_order_id" text,
	"filled_at" timestamp with time zone NOT NULL,
	"contracts" integer NOT NULL,
	"fill_price" double precision NOT NULL,
	"action" text DEFAULT 'buy' NOT NULL,
	"position_id" text,
	"cost_cents" integer NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"fee_known" boolean DEFAULT false NOT NULL,
	"trade_micros" bigint,
	"fee_micros" bigint,
	"proceeds_cents" integer,
	"cost_basis_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_fills_amount_check" CHECK (
    "micro_live_fills"."contracts" > 0 AND "micro_live_fills"."cost_cents" >= 0 AND "micro_live_fills"."fee_cents" >= 0
  ),
	CONSTRAINT "micro_live_fills_action_check" CHECK (
    "micro_live_fills"."action" IN ('buy','sell') AND
    ("micro_live_fills"."proceeds_cents" IS NULL OR "micro_live_fills"."proceeds_cents" >= 0) AND
    ("micro_live_fills"."cost_basis_cents" IS NULL OR "micro_live_fills"."cost_basis_cents" >= 0) AND
    ("micro_live_fills"."action" <> 'sell' OR (
      "micro_live_fills"."position_id" IS NOT NULL AND "micro_live_fills"."position_id" <> '' AND
      "micro_live_fills"."proceeds_cents" IS NOT NULL AND
      "micro_live_fills"."cost_basis_cents" IS NOT NULL
    ))
  ),
	CONSTRAINT "micro_live_fills_price_check" CHECK ("micro_live_fills"."fill_price" > 0 AND "micro_live_fills"."fill_price" <= 1),
	CONSTRAINT "micro_live_fills_exact_amount_check" CHECK (
    ("micro_live_fills"."trade_micros" IS NULL OR "micro_live_fills"."trade_micros" > 0) AND
    ("micro_live_fills"."fee_micros" IS NULL OR "micro_live_fills"."fee_micros" >= 0)
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_settlements" (
	"position_id" text PRIMARY KEY NOT NULL,
	"market_ticker" text NOT NULL,
	"side" text NOT NULL,
	"market_result" text NOT NULL,
	"contracts" integer NOT NULL,
	"payout_micros" bigint NOT NULL,
	"fee_micros" bigint,
	"settled_at" timestamp with time zone NOT NULL,
	"evidence_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_settlements_values_check" CHECK (
    "micro_live_settlements"."side" IN ('UP','DOWN') AND "micro_live_settlements"."market_result" IN ('yes','no') AND
    "micro_live_settlements"."contracts" > 0 AND "micro_live_settlements"."payout_micros" >= 0 AND
    ("micro_live_settlements"."fee_micros" IS NULL OR "micro_live_settlements"."fee_micros" >= 0)
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"evaluation_id" text,
	"order_id" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_decisions_status_check" CHECK ("micro_live_decisions"."status" IN ('ALLOW','BLOCK','ERROR'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kalshi_key_provisioning_attempts" (
	"attempt_uuid" uuid PRIMARY KEY NOT NULL,
	"key_name" text NOT NULL,
	"subaccount" integer NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"recovery_confirmed_at" timestamp with time zone,
	"recovery_reason" text,
	CONSTRAINT "kalshi_key_provisioning_name_unique" UNIQUE("key_name"),
	CONSTRAINT "kalshi_key_provisioning_state_check" CHECK ("kalshi_key_provisioning_attempts"."state" IN ('prepared', 'attempted', 'response_received', 'handoff_confirmed', 'handoff_recovered_verified', 'uncertain')),
	CONSTRAINT "kalshi_key_provisioning_recovery_check" CHECK (("kalshi_key_provisioning_attempts"."state" = 'handoff_recovered_verified') = ("kalshi_key_provisioning_attempts"."recovery_confirmed_at" IS NOT NULL AND "kalshi_key_provisioning_attempts"."recovery_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_subaccount_creation_attempts" (
	"attempt_uuid" uuid PRIMARY KEY NOT NULL,
	"target_exchange_index" integer NOT NULL,
	"pre_post_inventory_digest" text NOT NULL,
	"pre_post_inventory" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"attempted_at" timestamp with time zone,
	"response_received_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"subaccount_number" integer,
	"response_status" integer,
	"response_metadata" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_subaccount_creation_target_check" CHECK ("micro_live_subaccount_creation_attempts"."target_exchange_index" = 2),
	CONSTRAINT "micro_live_subaccount_creation_digest_check" CHECK ("micro_live_subaccount_creation_attempts"."pre_post_inventory_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "micro_live_subaccount_creation_state_check" CHECK ("micro_live_subaccount_creation_attempts"."state" IN ('reserved', 'attempted', 'response_received', 'verified', 'uncertain')),
	CONSTRAINT "micro_live_subaccount_creation_subaccount_check" CHECK ("micro_live_subaccount_creation_attempts"."subaccount_number" IS NULL OR "micro_live_subaccount_creation_attempts"."subaccount_number" BETWEEN 1 AND 63),
	CONSTRAINT "micro_live_subaccount_creation_timestamps_check" CHECK (
      ("micro_live_subaccount_creation_attempts"."state" = 'reserved' AND "micro_live_subaccount_creation_attempts"."attempted_at" IS NULL AND
        "micro_live_subaccount_creation_attempts"."response_received_at" IS NULL AND "micro_live_subaccount_creation_attempts"."verified_at" IS NULL AND
        "micro_live_subaccount_creation_attempts"."subaccount_number" IS NULL AND "micro_live_subaccount_creation_attempts"."response_status" IS NULL) OR
      ("micro_live_subaccount_creation_attempts"."state" = 'attempted' AND "micro_live_subaccount_creation_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_subaccount_creation_attempts"."response_received_at" IS NULL AND "micro_live_subaccount_creation_attempts"."verified_at" IS NULL AND
        "micro_live_subaccount_creation_attempts"."subaccount_number" IS NULL AND "micro_live_subaccount_creation_attempts"."response_status" IS NULL) OR
      ("micro_live_subaccount_creation_attempts"."state" = 'uncertain' AND "micro_live_subaccount_creation_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_subaccount_creation_attempts"."verified_at" IS NULL) OR
      ("micro_live_subaccount_creation_attempts"."state" = 'response_received' AND "micro_live_subaccount_creation_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_subaccount_creation_attempts"."response_received_at" IS NOT NULL AND "micro_live_subaccount_creation_attempts"."subaccount_number" IS NOT NULL AND
        "micro_live_subaccount_creation_attempts"."response_status" = 201 AND "micro_live_subaccount_creation_attempts"."verified_at" IS NULL) OR
      ("micro_live_subaccount_creation_attempts"."state" = 'verified' AND "micro_live_subaccount_creation_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_subaccount_creation_attempts"."verified_at" IS NOT NULL AND "micro_live_subaccount_creation_attempts"."subaccount_number" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_pair_key_provisioning_attempts" (
	"attempt_uuid" uuid PRIMARY KEY NOT NULL,
	"key_name" text NOT NULL,
	"subaccount" integer NOT NULL,
	"exchange_index" integer NOT NULL,
	"scopes" text[] NOT NULL,
	"creation_attempt_id" text NOT NULL,
	"clean_boundary_evidence_digest" text NOT NULL,
	"key_id" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone,
	"response_received_at" timestamp with time zone,
	"metadata_verified_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "micro_live_pair_key_attempt_identity_check" CHECK (
      "micro_live_pair_key_provisioning_attempts"."key_name" = 'MICRO_LIVE_INDEX2_SUBACCOUNT_1' AND
      "micro_live_pair_key_provisioning_attempts"."subaccount" = 1 AND "micro_live_pair_key_provisioning_attempts"."exchange_index" = 2 AND
      "micro_live_pair_key_provisioning_attempts"."scopes" = ARRAY['read', 'write::trade']::text[] AND
      btrim("micro_live_pair_key_provisioning_attempts"."creation_attempt_id") <> '' AND
      "micro_live_pair_key_provisioning_attempts"."clean_boundary_evidence_digest" ~ '^[0-9a-f]{64}$' AND
      ("micro_live_pair_key_provisioning_attempts"."key_id" IS NULL OR
        (btrim("micro_live_pair_key_provisioning_attempts"."key_id") <> '' AND length("micro_live_pair_key_provisioning_attempts"."key_id") <= 256))
    ),
	CONSTRAINT "micro_live_pair_key_attempt_state_check" CHECK (
      "micro_live_pair_key_provisioning_attempts"."state" IN (
        'prepared', 'attempted', 'response_received', 'metadata_verified',
        'handoff_confirmed', 'uncertain'
      )
    ),
	CONSTRAINT "micro_live_pair_key_attempt_transitions_check" CHECK (
      (
        "micro_live_pair_key_provisioning_attempts"."state" = 'prepared' AND
        "micro_live_pair_key_provisioning_attempts"."attempted_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."response_received_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."metadata_verified_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."confirmed_at" IS NULL AND "micro_live_pair_key_provisioning_attempts"."key_id" IS NULL
      ) OR (
        "micro_live_pair_key_provisioning_attempts"."state" = 'attempted' AND
        "micro_live_pair_key_provisioning_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."response_received_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."metadata_verified_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."confirmed_at" IS NULL AND "micro_live_pair_key_provisioning_attempts"."key_id" IS NULL
      ) OR (
        "micro_live_pair_key_provisioning_attempts"."state" = 'uncertain' AND
        "micro_live_pair_key_provisioning_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."response_received_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."metadata_verified_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."confirmed_at" IS NULL AND "micro_live_pair_key_provisioning_attempts"."key_id" IS NULL
      ) OR (
        "micro_live_pair_key_provisioning_attempts"."state" = 'response_received' AND
        "micro_live_pair_key_provisioning_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."response_received_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."metadata_verified_at" IS NULL AND
        "micro_live_pair_key_provisioning_attempts"."confirmed_at" IS NULL AND "micro_live_pair_key_provisioning_attempts"."key_id" IS NOT NULL
      ) OR (
        "micro_live_pair_key_provisioning_attempts"."state" = 'metadata_verified' AND
        "micro_live_pair_key_provisioning_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."response_received_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."metadata_verified_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."confirmed_at" IS NULL AND "micro_live_pair_key_provisioning_attempts"."key_id" IS NOT NULL
      ) OR (
        "micro_live_pair_key_provisioning_attempts"."state" = 'handoff_confirmed' AND
        "micro_live_pair_key_provisioning_attempts"."attempted_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."response_received_at" IS NOT NULL AND
        "micro_live_pair_key_provisioning_attempts"."confirmed_at" IS NOT NULL AND "micro_live_pair_key_provisioning_attempts"."key_id" IS NOT NULL
      )
    )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_live_pair_funding_attempts" (
	"attempt_uuid" uuid PRIMARY KEY NOT NULL,
	"source_subaccount" integer NOT NULL,
	"destination_subaccount" integer NOT NULL,
	"exchange_index" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"market_ticker" text NOT NULL,
	"state" text NOT NULL,
	"source_scoped_before_micros" text NOT NULL,
	"source_inventory_before_micros" text NOT NULL,
	"clean_boundary_digest" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"response_received_at" timestamp with time zone,
	"transfer_id" text,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "micro_live_pair_funding_target_unique" UNIQUE("destination_subaccount","exchange_index"),
	CONSTRAINT "micro_live_pair_funding_exact_intent_check" CHECK (
    "micro_live_pair_funding_attempts"."source_subaccount" = 0 AND "micro_live_pair_funding_attempts"."destination_subaccount" = 1 AND
    "micro_live_pair_funding_attempts"."exchange_index" = 2 AND "micro_live_pair_funding_attempts"."amount_cents" = 2500 AND
    "micro_live_pair_funding_attempts"."market_ticker" ~ '^KXBTC15M-[A-Za-z0-9-]+$' AND
    "micro_live_pair_funding_attempts"."source_scoped_before_micros" ~ '^[0-9]+$' AND
    "micro_live_pair_funding_attempts"."source_inventory_before_micros" ~ '^[0-9]+$' AND
    "micro_live_pair_funding_attempts"."clean_boundary_digest" ~ '^[0-9a-f]{64}$' AND
    isfinite("micro_live_pair_funding_attempts"."attempted_at") AND
    "micro_live_pair_funding_attempts"."state" IN ('attempted', 'uncertain', 'response_received', 'reconciled') AND
    ("micro_live_pair_funding_attempts"."transfer_id" IS NULL OR "micro_live_pair_funding_attempts"."transfer_id" ~ '^[A-Za-z0-9._:-]{1,128}$') AND
    ("micro_live_pair_funding_attempts"."state" <> 'reconciled' OR
      ("micro_live_pair_funding_attempts"."transfer_id" IS NOT NULL AND "micro_live_pair_funding_attempts"."reconciled_at" IS NOT NULL))
  )
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "v13_production_account" ADD CONSTRAINT "v13_production_account_policy_id_v13_live_money_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."v13_live_money_policy"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "v13_production_event" ADD CONSTRAINT "v13_production_event_account_id_v13_production_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."v13_production_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "v13_production_event" ADD CONSTRAINT "v13_production_event_intent_id_v13_production_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."v13_production_intent"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "v13_production_intent" ADD CONSTRAINT "v13_production_intent_account_id_v13_production_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."v13_production_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "v13_production_intent" ADD CONSTRAINT "v13_production_intent_evaluation_id_forward_test_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."forward_test_evaluations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "v13_production_observation" ADD CONSTRAINT "v13_production_observation_account_id_v13_production_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."v13_production_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "v13_production_position" ADD CONSTRAINT "v13_production_position_id_v13_production_intent_id_fk" FOREIGN KEY ("id") REFERENCES "public"."v13_production_intent"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "v13_production_position" ADD CONSTRAINT "v13_production_position_account_id_v13_production_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."v13_production_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "micro_live_fills" ADD CONSTRAINT "micro_live_fills_order_id_micro_live_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."micro_live_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "micro_live_decisions" ADD CONSTRAINT "micro_live_decisions_order_id_micro_live_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."micro_live_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "forward_test_btc_points_time" ON "forward_test_btc_points" USING btree ("engine_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forward_test_one_enabled_v13" ON "forward_test_engine" USING btree ("strategy_version") WHERE "forward_test_engine"."enabled" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forward_test_evaluations_chronological" ON "forward_test_evaluations" USING btree ("evaluated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forward_test_one_action_per_cross" ON "forward_test_positions" USING btree ("market_ticker","crossing_key","trigger_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forward_test_one_open_per_engine" ON "forward_test_positions" USING btree ("engine_id") WHERE "forward_test_positions"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_trades_one_open_per_user" ON "live_trades" USING btree ("user_id") WHERE "live_trades"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_production_account_pair" ON "v13_production_account" USING btree ("subaccount","exchange_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_production_event_unique" ON "v13_production_event" USING btree ("account_id","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v13_production_event_loss_window" ON "v13_production_event" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_production_client_order_unique" ON "v13_production_intent" USING btree ("client_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_production_evaluation_unique" ON "v13_production_intent" USING btree ("account_id","evaluation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_production_crossing_unique" ON "v13_production_intent" USING btree ("account_id","crossing_key") WHERE "v13_production_intent"."kind"='ENTRY';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_production_one_unresolved_exit" ON "v13_production_intent" USING btree ("parent_id") WHERE "v13_production_intent"."kind"='EXIT' AND "v13_production_intent"."state" NOT IN ('TERMINAL','BLOCKED');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v13_production_owned_positions" ON "v13_production_position" USING btree ("account_id") WHERE "v13_production_position"."quantity_hundredths">0;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_live_money_policy_version_unique" ON "v13_live_money_policy" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_live_money_policy_one_approved" ON "v13_live_money_policy" USING btree ("state") WHERE "v13_live_money_policy"."state"='APPROVED';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_strategy_parameter_set_version_unique" ON "v13_strategy_parameter_set" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "v13_strategy_shadow_eval_source_parameter_unique" ON "v13_strategy_shadow_evaluation" USING btree ("source_evaluation_id","parameter_set_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v13_strategy_shadow_eval_parameter_chronological" ON "v13_strategy_shadow_evaluation" USING btree ("parameter_set_id","evaluated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_proposed_orders_action_key" ON "live_proposed_orders" USING btree ("market_ticker","crossing_key","trigger_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_proposed_orders_recorded_at" ON "live_proposed_orders" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_notification_events_created_at" ON "live_notification_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_pair_boundary_funding_transfer_id_unique" ON "micro_live_pair_boundary" USING btree ("funding_transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_pair_boundary_initialized_run_id_unique" ON "micro_live_pair_boundary" USING btree ("initialized_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_pair_boundary_state_idx" ON "micro_live_pair_boundary" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_run_archive_archived_at" ON "micro_live_run_archive" USING btree ("archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_orders_action_key_unique" ON "micro_live_orders" USING btree ("action_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_orders_market_crossing_trigger_unique" ON "micro_live_orders" USING btree ("market_ticker","crossing_key","trigger_type") WHERE "micro_live_orders"."trigger_type" IN ('SCOUT', 'CONFIRM');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_orders_client_order_id_unique" ON "micro_live_orders" USING btree ("client_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_orders_exchange_order_id_unique" ON "micro_live_orders" USING btree ("exchange_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_orders_status_created_at" ON "micro_live_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_orders_market_created_at" ON "micro_live_orders" USING btree ("market_ticker","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_fills_exchange_fill_id_unique" ON "micro_live_fills" USING btree ("exchange_fill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_fills_order_filled_at" ON "micro_live_fills" USING btree ("order_id","filled_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_settlements_ticker_unique" ON "micro_live_settlements" USING btree ("market_ticker");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_decisions_latest" ON "micro_live_decisions" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_decisions_evaluation_id" ON "micro_live_decisions" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_live_decisions_order_id" ON "micro_live_decisions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_subaccount_creation_target_unique" ON "micro_live_subaccount_creation_attempts" USING btree ("target_exchange_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_pair_key_attempt_pair_unique" ON "micro_live_pair_key_provisioning_attempts" USING btree ("subaccount","exchange_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_pair_key_attempt_name_unique" ON "micro_live_pair_key_provisioning_attempts" USING btree ("key_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_live_pair_key_attempt_key_id_unique" ON "micro_live_pair_key_provisioning_attempts" USING btree ("key_id");

-- Browser roles cannot read or write the trading schema through the Data API.
REVOKE ALL ON TABLE public."forward_test_btc_points" FROM anon, authenticated;
REVOKE ALL ON TABLE public."forward_test_engine" FROM anon, authenticated;
REVOKE ALL ON TABLE public."forward_test_evaluations" FROM anon, authenticated;
REVOKE ALL ON TABLE public."forward_test_positions" FROM anon, authenticated;
REVOKE ALL ON TABLE public."forward_test_windows" FROM anon, authenticated;
REVOKE ALL ON TABLE public."live_events" FROM anon, authenticated;
REVOKE ALL ON TABLE public."live_trades" FROM anon, authenticated;
REVOKE ALL ON TABLE public."paper_history" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_production_account" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_production_event" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_production_intent" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_production_observation" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_production_position" FROM anon, authenticated;
REVOKE ALL ON TABLE public."live_execution_config" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_live_money_policy" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_strategy_parameter_set" FROM anon, authenticated;
REVOKE ALL ON TABLE public."v13_strategy_shadow_evaluation" FROM anon, authenticated;
REVOKE ALL ON TABLE public."live_proposed_orders" FROM anon, authenticated;
REVOKE ALL ON TABLE public."live_notification_events" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_config" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_pair_boundary" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_fee_verification" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_run_archive" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_commissioning_archive" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_pair_fee_approval" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_orders" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_fills" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_settlements" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_decisions" FROM anon, authenticated;
REVOKE ALL ON TABLE public."kalshi_key_provisioning_attempts" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_subaccount_creation_attempts" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_pair_key_provisioning_attempts" FROM anon, authenticated;
REVOKE ALL ON TABLE public."micro_live_pair_funding_attempts" FROM anon, authenticated;
ALTER TABLE public."forward_test_btc_points" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."forward_test_engine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."forward_test_evaluations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."forward_test_positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."forward_test_windows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."live_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."live_trades" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."paper_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_production_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_production_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_production_intent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_production_observation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_production_position" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."live_execution_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_live_money_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_strategy_parameter_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."v13_strategy_shadow_evaluation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."live_proposed_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."live_notification_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_pair_boundary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_fee_verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_run_archive" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_commissioning_archive" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_pair_fee_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_fills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."kalshi_key_provisioning_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_subaccount_creation_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_pair_key_provisioning_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."micro_live_pair_funding_attempts" ENABLE ROW LEVEL SECURITY;
