# Strata stake-first risk policy / owner-only commissioning handoff

**Status:** code proposal and release checklist only. This document is **not** an authorization to submit live orders or a claim that Railway/Bolt has deployed any revision.

## One visible number, server-governed limits

Owner chooses a clearly labeled, revision-pinned named allocation policy, enters **desired gross entry stake in USD**, and reviews a derived funded budget, maximum **all-in** entry/exit fee reserve, cumulative/daily loss allowances and fixed freshness controls. The browser is non-authoritative. The authenticated backend looks up the same immutable built-in preset or saved DB revision **inside SERIALIZABLE transaction**, scales integer cents with floors, requires explicit owner policy consent and fresh reconciled spendable Kalshi subaccount 1/exchange index 2 cash, and hashes/versions the approved policy. It rejects mismatched budget/stake, stale cash, exposure, running/armed worker and changed preset revisions. Saving never STARTs the worker or bypasses fee, depth, position, live kill, owner release or exit checks.

Two separate, unambiguously named profiles:

- **Standard C52/53 — 6% entry:** fixed 6% gross stake, 8% all-in, 20% daily-loss and 60% total-loss fraction of committed budget. For a desired **$5** gross stake, budget **$83.34**; all-in **$6.66**; daily **$16.66**; cumulative **$50.00**.
- **Higher Risk Test — 20% entry:** explicit opt-in; fixed 20% gross stake, 25% all-in, 40% daily-loss, 60% total-loss. With **$25** verified cash, a **$5** gross stake gets **$6.25** fee-inclusive ceiling, **$10** daily and **$15** total loss allowance. This is aggressive; potential loss of capital is significant. It does not lower protective price floor or disable any circuit breaker.

At the **software** $25,000 gross stake ceiling:
- 6% preset needs at least $416,666.67 allocated/verified cash; all-in about $33,333.33; daily about $83,333.33; total about $250,000.00.
- 20% preset needs at least $125,000.00 allocated/verified cash; all-in $31,250.00; daily $50,000.00; total $75,000.00.

These are ceilings and risk budgets, **not expected returns**, target trade sizes, fee quotes, guarantees of profit, or assertions of Kalshi venue position-limit availability. Venue market-specific position/order caps, actual depth, slippage, IOC partial fills, correct fee rates and real-time exposure are independently enforced; a $25,000 configured ceiling does **not** mean Kalshi will accept or fully fill an order of that size.

## Capital preservation and sequence

1. Retain C52/Confirm53 champion; paper results are not validated real P&L. For first live cash research, choose the *explicitly higher-risk* 20% named test profile only if you accept the $5 exposure on $25 capital. Do not silently migrate from 6% to 20%.
2. In dashboard: ensure owner session with MFA, stop any worker, DISARM account, confirm zero open positions/intents/unknown requests and no stale lease. Use the **read-only/account-authenticated cash reconciliation** action first.
3. Enter desired gross stake **5.00**, choose 20% profile, review computed budget and limits, check explicit owner consent and save. Backend independently validates preset ID/revision, funding, policy hash and risk constraints.
4. If the backend refuses due to account armed, stale cash, fee policy, provisional freeze or unverified order book, **do not update database rows or kill switches manually**. Investigate and correct the specific evidence path.
5. A previously commissioned account with provisional freeze uses the owner-SHA pathway only after fresh signed zero-exposure reconciliation and the separate owner checkbox; a genuine risk freeze must never be cleared.
6. Confirm latest backend deployed **exact SHA**, approved current official fee evidence and full market fee schedule, protected IOC crash/unknown handling, current all-in policy and live circuit breakers. Steps 12–13 remain unavailable until all release gates pass.
7. **Step 12:** run authenticated production read-only qualification; verify unique fresh qualification receipt, SHA and owner-specific account. The MFA owner authorizes their own exact SHA, then separately uses Dashboard ARM when global and personal controls are ready. No second human account is required for OWNER_SHA_V1, but this is NOT an override of backend fee, exchange, safety or infrastructure checks.
8. **Step 13:** after STOP/START status and fresh reconciliation are independently checked, explicitly select Dashboard START only if backend declares READY, signed protective EXIT is operational, fees valid, and kill switches/risk policies are correct. Validate worker heartbeats, signed order receipts, fills, settlements, and realized after-fee P&L. STOP on any unknown order, inability to exit, market data staleness, excessive slippage, or cash mismatch.

## Evidence and remaining deployment prerequisites

- Backend and frontend merged source status MUST be verified separately from live runtime SHA. An older Bolt publication or stale Railway revision is not proof the updated risk UI is live.
- Supabase snapshot (2026-10-21) reported 4 commissioned accounts with $25 cash but no official fee captures or active owner-SHA release grants. Railway connector did not list projects. An external authoritative Kalshi account ledger and canonical fee source receipt are still required, not a fake approval.
- Live testing $5 is **not automatic authorization**. Require real available cash, adequate displayed order-book size, fee reserve, current fee policy, auth and risk approvals. Use bounded initial risk; do not use the $5000 or $25000 tiers for research until materially validated net performance, liquidity and risk capital justify them.

## Rollback

Do not migrate or overwrite financial records. If the risk selector miscalculates, retain previous approved policy and $1.50 stake; revert new frontend/backend SHA through existing deployments. Never revert directly to an unreviewed old branch, force a policy approval, or change the global kill switch to get the bot started. Preserve audit observations and genuine signed exchange responses.
