import assert from "node:assert/strict";
import test from "node:test";
import {reserveKalshiBalanceReadSlot} from "./kalshiBalanceQuota";

test("a saturated read-slot queue never grants an exchange balance read", async () => {
  let statement = "";
  const query = async (sql: string) => {
    statement = sql;
    return {rows: []};
  };
  await assert.rejects(
    reserveKalshiBalanceReadSlot("valid-key", undefined, query as never),
    /kalshi_balance_quota_busy/,
  );
  assert.ok(statement.includes("ON CONFLICT (budget_key) DO UPDATE"));
  assert.ok(statement.includes("WHERE private.strata_kalshi_balance_read_slots.next_slot_at"));
  assert.ok(statement.includes("13800 milliseconds"));
});
