# Strata — one-owner $5 first live test (verified facts and readiness, October 21, 2026)

## Scope and decision

**This is not a live authorization.** Do not touch the other three frozen accounts or replay the completed historical $25 commissioning transfers. Backend `main` before this change: `18384ff7371b751f0c2d8046f248b2d848d95303`; frontend `main`: `a634d46c0e4c02a24bd7e84beeddb6bba45790e4`.

Strata's previously recorded bot execution cash is $25 and configured stake $1.50. A $5 entry is already supported under the **Higher Risk Test 20%** preset, with $25 risk capital, **$5 maximum gross entry** and **$6.25 max all-in**. A nominal $100 Kalshi primary cash deposit is **not required** to choose this preset. However all dollars are historical until a fresh signed Kalshi GET confirms the bot's actual spendable cash (subaccount 1, exchange index 2). Recent fund deposits can have holds or partial immediate credit. Independent browser-visible account total cannot be used to authorize an order.

## Correct $5 setup, one owner only

1. Authenticate as the intended owner with MFA; select **My own account** in the existing Strata commissioning flow.
2. Confirm your worker is STOPPED and your specific account DISARMED. Do not change the shared/global kill switch to try to pass a funding gate.
3. In Wallets view authenticated Kalshi primary balance and dedicated bot balance separately. They are **different liquidity buckets**. A known subtotal is informational; it is not proof that the bot can spend the primary money.
4. Use **Refresh authenticated Kalshi balances and Strata ledger**, then explicitly **Record/Refresh Bot Cash Reconciliation** to persist a provider-signed subaccount-1/index-2 amount. If the qualified read fails, remain blocked; do not edit `cash_micros` by SQL.
5. In **Stake amount — automatic risk limits**, choose **Higher Risk Test — 20%**, enter **$5.00**, review computed $25 capital / $6.25 all-in / $10 daily-loss / $15 total-loss maximums, explicitly consent, and Save. Current code needs a signed cash reconciliation within 15 minutes, no active worker or unresolved order, valid preset revision, and an approved exact policy hash. No account rights are granted by saving.
6. Step 12 **GET-only production qualification** must reconcile exact personal account cash, open orders, fills, positions and settlement history; verify fresh provider fee evidence, strategy/stake, signed protective exits, version-bound safety tests and exact deployed backend SHA. The existing `OWNER_SHA_V1` lets this authenticated owner authorize their exact SHA after qualification without another reviewer. A historical `awaiting_account_commissioning` freeze can be addressed only with separate typed owner consent and zero-exposure evidence, never by directly clearing the DB. Every other risk freeze stays closed.
7. Only after Step 12 qualifies and protected risk/kill gates pass, separately ARM, and then Step 13 START from the dashboard. Observe live heartbeat, exchange acknowledgements, fills, unknown-intent reconciliation, fees and kill/protective-exit readiness. On ambiguity STOP without sending duplicate POSTs.

**Do not ARM/START based on passing GitHub CI or a refreshed frontend alone.** Railway's exact running backend deployment was not confirmed; user requested Railway be out of scope for this pass. An unverified runtime SHA remains a hard Step 12 dependency.

## Funding more than $25 later

Existing `ownerShardAllocation.ts` and `ownedPilotTransfer.ts` are immutable $25 commissioning operations with **uncommissioned + globally disabled** predicates, and have historical completed records. They are NOT general-purpose deposit/top-up endpoints. The newly added `GET /bot-topup/readiness` establishes only **local owner maintenance eligibility** for an already commissioned and disarmed account. It never performs a transfer or grants executable authority.

The correct future transfer flow is issue [#131](https://github.com/PatentFiles/Strata-Backend/issues/131): new exact-cent idempotent signed transfer plan(s), account-level durable STOP/DISARM maintenance hold, fresh full exchange reconciliation, two-leg shard0→shard2→bot1 movement only when actually needed, explicit AAL2 owner consent for amount and destination, immutable once-only transfer IDs, UNKNOWN/partial recovery without duplicate transfer, signed source/destination receipts, and an audited bot-only cash ledger update. Do not rewrite prior pilot IDs, lie about available cash, or use a single browser-side balance aggregate for trade sizing.

## Existing unsatisfied production evidence (at 2026-10-21 15:57 UTC)

- Provider-origin official fee captures: **0**; independent API evidence can be used only through its separately reviewed authorized tariff-source workflow.
- Active owner-SHA release approvals: **0**.
- Unexpired protective qualifications: **0**.
- Other commissioned provisional freeze records: **3**; do not change them for this owner's pilot.
- Running production backend SHA, signed exit IOC behavior and production Kalshi cash/fills have **not** been independently confirmed in this session.

Even if you stop discussing the current cloud hosting provider, these real release requirements are not waived. **No-go until confirmed.**
