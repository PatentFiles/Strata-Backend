# Exact fractional EXIT private bindings

Separate patch against combined tree541acae. Depends on main EXIT requestQuantity helper/planner/types changes; copied helper in author workspace is excluded from this patch. ENTRY remains whole. No new exit predicate, floor/risk policy, grant or order authority.

New request: quantityVersion=EXIT_HUNDREDTHS_V1, quantityHundredths canonical positive decimal integer string<=100000, contracts key absent, actionSELL/reduceOnlytrue/IOC. Legacy requests retain numeric positive integer contracts<=999999999 and neither new key. Private SQL is EXIT-only, returns NULL for mixed/malformed requests instead of accepting conflicting authorities. Central helper prevents divergence across reserve, UNKNOWN marker, local-no-send finalizer and immutable audit trigger. Existing reservation/position quantities are already hundredths. Prepared-but-never-dispatched recovery uses same exact TS helper and count formatting, preserving old-id terminality and owned quantity.

## Deployment / rollback
1. Finish combined offline actual main financial→private route tests and independent exact release/migration review. These private tests alone do not prove the full route or authenticated provider fills.
2. While verified disarmed/held and flat under controlled deployment process, apply NEW sql/strata_protective_exit_fractional_quantity.sql AFTER already-applied strata_protective_exit_local_no_send.sql, with transaction-local bounded lock/statement timeouts. Do not rerun the old audit migration afterward: it would overwrite the new audit guard.
3. This transaction adds one immutable SECURITY INVOKER parser and replaces only existing audit-guard function body; no row rewrite, new table, long validation or new approval. Trigger attachment/append-only audit/UNKNOWN→VOID rules are unchanged. Verify exact function definitions, owner/runtime EXECUTE permission, invoker/search_path and public role denial before deploying code. Existing trusted backend role must have access; do not grant public roles.
4. Deploy the reviewed combined runtime only after migration verification. Missing helper causes private SQL refusal/rollback, never an unguarded order; it is not a self-healing condition.
5. Do not drop audit or parser on rollback. New migration remains backward-compatible with legacy whole EXIT code. Old runtime cannot properly manage new-format/fractional requests or residuals: rollback requires disarmed/flat/no unresolved intents and a reviewed compatibility plan; never downgrade while fractionally exposed.

## Evidence
- Existing private reserve/UNKNOWN/signed-dispatch unit30 pass.
- Exact prepared recovery0.01/0.50/1.50 + legacy2.00 unit2 pass; marker quantity/state changes reject, no POST or position decrement.
- Disposable PG parser/trigger matrix executes old+new migrations then reapplies new: format/quantity parity, malformed/mixed bounds, missing migration refusal, legacy/new audit acceptance, changed request/lease/already-filled refusal, BLOCKED prerequisite for VOID, append-only audit and terminal old identities, explicit public-role EXECUTE denial and invoker/search_path verification.
- These are local synthetic fixtures, not live orders or real provider evidence. Full main financial/dispatcher/reconciliation integration is owned by main author/integrator. Existing actual-transport ambiguity stays UNKNOWN; source inspection retains raw-POST proof boundaries.

Run from API: node scripts/run-v13-disposable-postgres.mjs src/lib/strata/protectiveExitFractionalQuantity.postgres.test.ts. Run unit bundles under NODE_ENV=test, no hosted env, synthetic DATABASE_URL, repository-root cwd (existing tests read reviewed SQL files). No production calls/schema changes.

Final wire hardening: the existing final-release SQL now rebinds the financial request's exact quantity (same parser), market/side/client identity and proceeds price, requires no exchange identity or fills, and holds a shared financial intent-row lock until the already-existing pre-send COMMIT. No extra query/provider call. A request mutation after UNKNOWN marking refuses POST and remains UNKNOWN; no generic failure is reclassified as proven not sent. Main integration suite must exercise this race against real PostgreSQL, not just a mocked row match.
