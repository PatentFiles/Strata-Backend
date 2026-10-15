import { sql } from "drizzle-orm";
import { bigint, check, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { v13ProductionAccountTable } from "./v13Production";

// Account-specific proof of existing funding. This is NOT the one-shot new-transfer ledger.
// No defaults grant trading authority or create transfer attempts.
const privateSchema = pgSchema("private");
export const kalshiOwnerHistoricalFundingTable = privateSchema.table("kalshi_owner_historical_funding", {
  executionAccountId: text("execution_account_id").primaryKey().references(() => v13ProductionAccountTable.id),
  ownerUserId: uuid("owner_user_id").notNull(),
  exchangeTransferId: text("exchange_transfer_id").notNull(),
  transferCreatedAt: timestamp("transfer_created_at", { withTimezone: true }).notNull(),
  primaryAfterCents: bigint("primary_after_cents", { mode: "number" }).notNull(),
  botAfterCents: bigint("bot_after_cents", { mode: "number" }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
}, t => [
  uniqueIndex("kalshi_owner_historical_funding_receipt_uq").on(t.exchangeTransferId),
  check("kalshi_owner_historical_funding_primary_cash_check", sql`${t.primaryAfterCents} = 0`),
  check("kalshi_owner_historical_funding_bot_cash_check", sql`${t.botAfterCents} = 2500`),
  check("kalshi_owner_historical_funding_receipt_len_check", sql`char_length(${t.exchangeTransferId}) BETWEEN 8 AND 128`),
]);
