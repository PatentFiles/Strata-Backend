# Owner variable Kalshi top-ups — staged rollout
October 21, 2026. Code handoff only. No Kalshi transfer or financial state modification performed.

## Current funding architecture
- Trading bot uses Kalshi **subaccount 1, exchange index 2**, not primary subaccount 0.
- Historical $25 commissioning transfers remain immutable and unchanged.
- A first $5 gross trade can already be funded by **$25 exchange-confirmed bot cash** under approved **Higher Risk Test 20%**; no $100 top-up is required for that limited pilot.
- Additional Kalshi primary money becomes bot-spendable ONLY after exact provider-signed movement and an audited ledger update. The UI totals are informational.

## Added owner top-up workflow
New private immutable parent-and-leg ledger migration `lib/db/drizzle/0032_owner_variable_topups.sql`; signed bounded amount transports in `kalshiAccountClient.ts`; account-scoped production routes:
- `GET /api/strata/me/bot-topup/status`
- `POST /api/strata/me/bot-topup/prepare`, `{amountCents}`
- `POST /api/strata/me/bot-topup/execute`, `{attemptId,confirmation}`
- `POST /api/strata/me/bot-topup/reconcile`
- `POST /api/strata/me/bot-topup/cancel` (only before *any* leg is attempted)

The backend uses server-side owner identity and the separately authenticated account-setup execution key. It requires an already commissioned account **STOPPED + DISARMED**, account kill ON, verified cash and zero exposure/reserved funds, zero unresolved order intents and zero worker leases, authenticated Kalshi balances, and per-account maintenance blocking. Global live state and other users' frozen accounts do not have to be disabled for this owner. A genuine non-commissioning risk freeze is never silently removed.

Two possible paths: if primary subaccount 0/shard 2 already holds the target cash, one subaccount-transfer leg; otherwise one shard0→shard2 leg followed (after unique receipt+cash proof) by the bot leg. Whole-cent amounts use integer cents and signed balances use bigint microdollars. Each leg has a unique provider client ID committed in the DB. A claim is durably committed **before** the Kalshi POST. Ambiguous success/timeout/response becomes UNKNOWN/UNCERTAIN, with no automatic retry, and a persistent maintenance freeze. Only unique accepted exchange receipt plus exact signed after-balances and zero local exposures permits another leg or cash-ledger reconciliation. A prepared, never-attempted first leg can be cancelled with explicit owner consent; an attempted leg cannot be cancelled to avoid false accounting.

## Deployment controls (MUST happen before enabling feature)
1. Keep `STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED` unset/false while code is merged and before production readiness review. Prepare is also disabled while false, so publishing Bolt cannot freeze an account prematurely.
2. On the existing platform, verify exact deployed backend SHA, safe account STOP/DISARM/kill state, no unresolved Kalshi operations, independently complete exchange data reconciliation, and restricted signer access. Verify current official transfer API rules, precision, and endpoint permissions.
3. Apply reviewed migration **0032** using the repository's controlled deployment process. No automatic schema assumption, no SQL cash overwrite, and preserve previous $25 records.
4. Test complete zero-side-effect GET preview; controlled end-to-end transfer receipts, ambiguous network outcomes, worker restart fences, and cash ledger correctness. Validate same provider-execution account identity before enabling anything.
5. Only with explicit production deployment authorization, enable the server flag `STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED=true`. This is not a user browser option.
6. Brit publishes frontend from `Meta-UO/TradingApp` merged main. Verify endpoint compatibility and that the public Bolt Wallets page shows owner funding controls. Publishing by itself does not enable transfers or live trading.
7. Initial top-up only when genuinely needed and after reviewing account source balances. Never treat $125 informational total as a single bot cash budget. Owner explicitly previews, consents for each leg, and reconciles. If UNKNOWN, stop; do not issue another POST.

## Acceptance/rollback
GitHub typecheck/unit and regression checks prove code behavior only, **not** real-money Kalshi execution. Do not close issue #131 until a genuine provider receipt, amount-specific reconciliation, exact deployed SHA, tested maintenance hold and no duplicate attempts are proven in deployment. Revert the flagged feature, never delete immutable DB audit rows. If mid-flight, preserve maintenance hold and reconcile using the signed provider records before re-arming.
