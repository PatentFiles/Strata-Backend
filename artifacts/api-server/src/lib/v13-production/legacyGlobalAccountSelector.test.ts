import assert from "node:assert/strict";
import test from "node:test";
import { db, v13ProductionAccountTable } from "@workspace/db";
import { LEGACY_GLOBAL_ACCOUNT_ID, legacyGlobalAccountPredicate } from "./legacyGlobalAccountSelector";

/**
 * SQL compilation is read-only. No database connection, order transport,
 * strategy signal, credential, or mutable production record is involved.
 *
 * This test locks the identity fence applied to every legacy V13 read,
 * reconcile and global-worker startup. Numeric exchange identifiers alone
 * are intentionally insufficient to identify an owned trading account.
 */
test("legacy global account lookup requires exact id, owner NULL and exchange pair", () => {
  const query = db.select().from(v13ProductionAccountTable)
    .where(legacyGlobalAccountPredicate()).limit(1).toSQL();
  assert.equal(LEGACY_GLOBAL_ACCOUNT_ID, "v13-production-1-2");
  assert.match(query.sql, /"v13_production_account"\."id"\s*=\s*\$1/);
  assert.match(query.sql, /"v13_production_account"\."owner_user_id"\s+is\s+null/i);
  assert.match(query.sql, /"v13_production_account"\."subaccount"\s*=\s*\$2/);
  assert.match(query.sql, /"v13_production_account"\."exchange_index"\s*=\s*\$3/);
  assert.deepEqual(query.params.slice(0, 3), [LEGACY_GLOBAL_ACCOUNT_ID, 1, 2]);
  assert.ok(query.sql.toLowerCase().includes("limit"), "selector must be bounded");
});
