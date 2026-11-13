import { and, eq, isNull } from "drizzle-orm";
import { v13ProductionAccountTable } from "@workspace/db";

/**
 * The legacy V13 supervisor is NOT an owner-scoped personal executor.
 * Multiple private accounts legitimately share the same Kalshi subaccount
 * and exchange-index values, so those two fields are not unique ownership.
 * The legacy selector must refuse all personal owner-bound accounts.
 */
export const LEGACY_GLOBAL_ACCOUNT_ID = "v13-production-1-2";

export function legacyGlobalAccountPredicate() {
  return and(
    eq(v13ProductionAccountTable.id, LEGACY_GLOBAL_ACCOUNT_ID),
    isNull(v13ProductionAccountTable.ownerUserId),
    eq(v13ProductionAccountTable.subaccount, 1),
    eq(v13ProductionAccountTable.exchangeIndex, 2),
  );
}
