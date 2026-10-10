import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { v13LiveMoneyPolicyTable } from "./v13LiveMoneyPolicy";
import { forwardTestEvaluationTable } from "./forwardTestEvaluation";

// No defaults grant authority. No startup migration or seed writes these tables.
export const v13ProductionAccountTable = pgTable("v13_production_account", {
  id: text("id").primaryKey(),
  policyId: text("policy_id").notNull().references(() => v13LiveMoneyPolicyTable.id),
  subaccount: bigint("subaccount", { mode: "number" }).notNull(),
  exchangeIndex: bigint("exchange_index", { mode: "number" }).notNull(),
  keyFingerprint: text("key_fingerprint").notNull(),
  commissioningDigest: text("commissioning_digest"),
  killSwitch: boolean("kill_switch").notNull().default(true),
  executionEnabled: boolean("execution_enabled").notNull().default(false),
  commissioned: boolean("commissioned").notNull().default(false),
  minimumExitMicros: integer("minimum_exit_micros"),
  feeArtifactDigest: text("fee_artifact_digest"),
  cashPrecisionVerified: boolean("cash_precision_verified").notNull().default(false),
  cashMicros: bigint("cash_micros", { mode: "bigint" }).notNull(),
  reservedMicros: bigint("reserved_micros", { mode: "bigint" }).notNull().default(sql`0`),
  initialCashMicros: bigint("initial_cash_micros", { mode: "bigint" }).notNull(),
  blockedReason: text("blocked_reason"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  evidenceDigest: text("evidence_digest"),
  revision: bigint("revision", { mode: "bigint" }).notNull().default(sql`0`),
}, t => [
  uniqueIndex("v13_production_account_pair").on(t.subaccount, t.exchangeIndex),
  check("v13_production_account_pair_check", sql`${t.subaccount}=1 AND ${t.exchangeIndex}=2`),
  check("v13_production_account_fingerprint", sql`${t.keyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("v13_production_account_cash", sql`${t.cashMicros}>=0 AND ${t.reservedMicros}>=0 AND ${t.reservedMicros}<=${t.cashMicros}`),
  check("v13_production_account_authority", sql`NOT ${t.commissioned} OR (${t.commissioningDigest} IS NOT NULL AND ${t.commissioningDigest} ~ '^[0-9a-f]{64}$' AND ${t.minimumExitMicros} IS NOT NULL AND ${t.minimumExitMicros} BETWEEN 1 AND 999999)`),
]);

export const v13ProductionIntentTable = pgTable("v13_production_intent", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => v13ProductionAccountTable.id),
  evaluationId: text("evaluation_id").references(() => forwardTestEvaluationTable.id),
  crossingKey: text("crossing_key"),
  parentId: text("parent_id"),
  kind: text("kind").notNull(),
  market: text("market").notNull(),
  side: text("side").notNull(),
  state: text("state").notNull().default("PREPARED"),
  request: jsonb("request").notNull(),
  decision: jsonb("decision").notNull(),
  policyHash: text("policy_hash").notNull(),
  feeFingerprint: text("fee_fingerprint").notNull(),
  capabilityDigest: text("capability_digest").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  exchangeOrderId: text("exchange_order_id"),
  reservedMicros: bigint("reserved_micros", { mode: "bigint" }).notNull(),
  exitFeeMicros: bigint("exit_fee_micros", { mode: "bigint" }).notNull(),
  filledHundredths: bigint("filled_hundredths", { mode: "bigint" }).notNull().default(sql`0`),
  terminal: boolean("terminal").notNull().default(false),
  cancelAttempted: boolean("cancel_attempted").notNull().default(false),
  dispatchAt: timestamp("dispatch_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("v13_production_client_order_unique").on(t.clientOrderId),
  uniqueIndex("v13_production_evaluation_unique").on(t.accountId, t.evaluationId),
  uniqueIndex("v13_production_crossing_unique").on(t.accountId, t.crossingKey).where(sql`${t.kind}='ENTRY'`),
  uniqueIndex("v13_production_one_unresolved_exit").on(t.parentId).where(sql`${t.kind}='EXIT' AND ${t.state} NOT IN ('TERMINAL','BLOCKED')`),
  check("v13_production_intent_kind", sql`${t.kind} IN ('ENTRY','EXIT') AND ${t.side} IN ('YES','NO')`),
  check("v13_production_intent_state", sql`${t.state} IN ('PREPARED','DISPATCHED','UNKNOWN','TERMINAL','BLOCKED')`),
  check("v13_production_intent_amounts", sql`${t.reservedMicros}>=0 AND ${t.exitFeeMicros}>=0 AND ${t.filledHundredths}>=0`),
  check("v13_production_entry_source", sql`(${t.kind}='ENTRY' AND ${t.evaluationId} IS NOT NULL AND ${t.crossingKey} IS NOT NULL AND ${t.parentId} IS NULL) OR (${t.kind}='EXIT' AND ${t.parentId} IS NOT NULL)`),
]);

export const v13ProductionPositionTable = pgTable("v13_production_position", {
  id: text("id").primaryKey().references(() => v13ProductionIntentTable.id),
  accountId: text("account_id").notNull().references(() => v13ProductionAccountTable.id),
  market: text("market").notNull(),
  side: text("side").notNull(),
  quantityHundredths: bigint("quantity_hundredths", { mode: "bigint" }).notNull().default(sql`0`),
  basisMicros: bigint("basis_micros", { mode: "bigint" }).notNull().default(sql`0`),
  realizedPnlMicros: bigint("realized_pnl_micros", { mode: "bigint" }).notNull().default(sql`0`),
}, t => [
  // The policy/locked reservation gate limits AUTHORIZED exposure to one
  // position. A late external fill must still be journaled if it reopens an
  // older market after another position opens; constraints must not erase fact.
  index("v13_production_owned_positions").on(t.accountId).where(sql`${t.quantityHundredths}>0`),
  check("v13_production_position_amounts", sql`${t.quantityHundredths}>=0 AND ${t.basisMicros}>=0 AND (${t.quantityHundredths}>0 OR ${t.basisMicros}=0)`),
]);

export const v13ProductionEventTable = pgTable("v13_production_event", {
  accountId: text("account_id").notNull().references(() => v13ProductionAccountTable.id),
  eventId: text("event_id").notNull(),
  intentId: text("intent_id").notNull().references(() => v13ProductionIntentTable.id),
  kind: text("kind").notNull(),
  digest: text("digest").notNull(),
  payload: jsonb("payload").notNull(),
  cashDeltaMicros: bigint("cash_delta_micros", { mode: "bigint" }).notNull(),
  pnlMicros: bigint("pnl_micros", { mode: "bigint" }).notNull().default(sql`0`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, t => [
  uniqueIndex("v13_production_event_unique").on(t.accountId, t.eventId),
  index("v13_production_event_loss_window").on(t.accountId, t.occurredAt),
]);

export const v13ProductionObservationTable = pgTable("v13_production_observation", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => v13ProductionAccountTable.id),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  digest: text("digest").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});
