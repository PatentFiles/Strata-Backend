import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const microLiveOrderTable = pgTable("micro_live_orders", {
  id: text("id").primaryKey(),
  actionKey: text("action_key").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  marketTicker: text("market_ticker").notNull(),
  crossingKey: text("crossing_key").notNull(),
  triggerType: text("trigger_type").notNull(),
  action: text("action").notNull().default("buy"),
  intent: text("intent").notNull().default("entry"),
  positionId: text("position_id"),
  exitPositionId: text("exit_position_id"),
  side: text("side").notNull(),
  sourceEvaluationId: text("source_evaluation_id").notNull(),
  signalAt: timestamp("signal_at", { withTimezone: true }).notNull(),
  btcSignalPrice: doublePrecision("btc_signal_price"),
  target: doublePrecision("target"),
  orderbookQuotePrice: doublePrecision("orderbook_quote_price"),
  quoteObservedAt: timestamp("quote_observed_at", { withTimezone: true }),
  orderType: text("order_type").notNull().default("LIMIT"),
  requestedLimitPrice: doublePrecision("requested_limit_price").notNull(),
  requestedContracts: integer("requested_contracts").notNull(),
  requestedStakeCents: integer("requested_stake_cents").notNull(),
  reservedRiskCents: integer("reserved_risk_cents").notNull().default(0),
  microLiveRunId: text("micro_live_run_id"),
  reservedEntryFeeMicros: integer("reserved_entry_fee_micros"),
  reservedExitFeeMicros: integer("reserved_exit_fee_micros"),
  feeEvidenceFingerprint: text("fee_evidence_fingerprint"),
  feeEvidenceVerifiedAt: timestamp("fee_evidence_verified_at", { withTimezone: true }),
  exchangeOrderId: text("exchange_order_id"),
  cancellationAttemptedAt: timestamp("cancellation_attempted_at", { withTimezone: true }),
  cancellationAuthorizedAt: timestamp("cancellation_authorized_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  averageFillPrice: doublePrecision("average_fill_price"),
  filledContracts: integer("filled_contracts").notNull().default(0),
  remainingContracts: integer("remaining_contracts").notNull(),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  filledAt: timestamp("filled_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  realizedPnlCents: integer("realized_pnl_cents"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("micro_live_orders_action_key_unique").on(table.actionKey),
  uniqueIndex("micro_live_orders_market_crossing_trigger_unique")
    .on(table.marketTicker, table.crossingKey, table.triggerType)
    .where(sql`${table.triggerType} IN ('SCOUT', 'CONFIRM')`),
  uniqueIndex("micro_live_orders_client_order_id_unique").on(table.clientOrderId),
  uniqueIndex("micro_live_orders_exchange_order_id_unique").on(table.exchangeOrderId),
  index("micro_live_orders_status_created_at").on(table.status, table.createdAt),
  index("micro_live_orders_market_created_at").on(table.marketTicker, table.createdAt),
  check("micro_live_orders_trigger_check", sql`${table.triggerType} IN ('SCOUT','CONFIRM','EXIT')`),
  check("micro_live_orders_cancellation_authorization_check", sql`
    ${table.cancellationAuthorizedAt} IS NULL OR
    (${table.cancellationAttemptedAt} IS NOT NULL AND
      ${table.cancellationAuthorizedAt} >= ${table.cancellationAttemptedAt} AND
      ${table.action} = 'sell' AND ${table.intent} = 'exit')
  `),
  check("micro_live_orders_action_check", sql`${table.action} IN ('buy','sell')`),
  check("micro_live_orders_intent_check", sql`${table.intent} IN ('entry','exit')`),
  check("micro_live_orders_sell_linkage_check", sql`
    (${table.action} <> 'sell' OR (
      ${table.triggerType} = 'EXIT' AND ${table.intent} = 'exit' AND
      ${table.exitPositionId} IS NOT NULL AND ${table.exitPositionId} <> ''
    )) AND
    (${table.intent} <> 'exit' OR (
      ${table.action} = 'sell' AND ${table.triggerType} = 'EXIT' AND
      ${table.exitPositionId} IS NOT NULL AND ${table.exitPositionId} <> ''
    ))
  `),
  check("micro_live_orders_side_check", sql`${table.side} IN ('UP','DOWN')`),
  check("micro_live_orders_type_check", sql`${table.orderType} = 'LIMIT'`),
  check("micro_live_orders_status_check", sql`${table.status} IN ('pending','unknown','partial','rejected','canceled','filled','closed')`),
  check("micro_live_orders_price_check", sql`
    ${table.requestedLimitPrice} > 0 AND ${table.requestedLimitPrice} <= 1 AND
    (${table.orderbookQuotePrice} IS NULL OR (${table.orderbookQuotePrice} > 0 AND ${table.orderbookQuotePrice} <= 1)) AND
    (${table.averageFillPrice} IS NULL OR (${table.averageFillPrice} > 0 AND ${table.averageFillPrice} <= 1))
  `),
  check("micro_live_orders_amount_check", sql`
    ${table.requestedContracts} > 0 AND ${table.filledContracts} >= 0 AND
    ${table.filledContracts} <= ${table.requestedContracts} AND
    ${table.remainingContracts} >= 0 AND
    ${table.filledContracts} + ${table.remainingContracts} <= ${table.requestedContracts} AND
    ${table.requestedStakeCents} >= 0 AND ${table.requestedStakeCents} <= 500 AND
    ${table.reservedRiskCents} >= 0 AND ${table.reservedRiskCents} <= ${table.requestedStakeCents} AND
    (${table.triggerType} <> 'SCOUT' OR ${table.requestedStakeCents} <= 250) AND
    (${table.triggerType} <> 'CONFIRM' OR ${table.requestedStakeCents} <= 250)
  `),
  check("micro_live_orders_fee_reservation_check", sql`
    (${table.reservedEntryFeeMicros} IS NULL OR ${table.reservedEntryFeeMicros} >= 0) AND
    (${table.reservedExitFeeMicros} IS NULL OR ${table.reservedExitFeeMicros} >= 0)
  `),
  check("micro_live_orders_active_run_fee_provenance_check", sql`
    ${table.microLiveRunId} IS NULL OR ${table.status} NOT IN ('pending','unknown','partial','filled') OR (
      btrim(${table.microLiveRunId}) <> '' AND
      ${table.reservedEntryFeeMicros} IS NOT NULL AND ${table.reservedEntryFeeMicros} >= 0 AND
      ${table.reservedExitFeeMicros} IS NOT NULL AND ${table.reservedExitFeeMicros} >= 0 AND
      ${table.feeEvidenceFingerprint} IS NOT NULL AND btrim(${table.feeEvidenceFingerprint}) <> '' AND
      ${table.feeEvidenceVerifiedAt} IS NOT NULL
    )
  `),
  check("micro_live_orders_signal_values_check", sql`
    (${table.btcSignalPrice} IS NULL OR ${table.btcSignalPrice} > 0) AND
    (${table.target} IS NULL OR ${table.target} > 0)
  `),
]);

export const insertMicroLiveOrderSchema = createInsertSchema(microLiveOrderTable);
export type MicroLiveOrder = typeof microLiveOrderTable.$inferSelect;
export type InsertMicroLiveOrder = z.infer<typeof insertMicroLiveOrderSchema>;