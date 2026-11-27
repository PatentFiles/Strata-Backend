# Strata 2026-11-27 live-history / protective-exit incident

Status: UNRESOLVED. Evidence: owner's exported CSV, read-only Supabase ledger/lease queries, Railway signed-history diagnostics, public Kalshi market and historical cutoff reads. No live-order writes, risk changes, or releases authorized.

## Verified timeline (UTC)

| Event | Time | Identity/outcome |
|---|---|---|
| Qualified observation | 22:16:25.696 | DOWN, source a9973190; followed by production_final_fee_or_quote_changed BLOCKED, no order |
| Qualified observation | 22:44:24.028 | DOWN, source dc1914e6 |
| Dispatch observation | 22:44:26.418 | QUALIFIED, **same** dc1914e6; not another signal/order |
| Entry fill | 22:44:26.285 | 3 NO contracts filled, entry fee 2,100 USD micros |
| Protective exit | 22:44:30.665 | SUBMISSION_UNCERTAIN, exchange order ID not recorded, outcome unknown |
| Market finalized | 22:45:05.924 | Kalshi public market result YES; signed account settlement/exit remains unverified |

CSV cohort: 18,025 rows (18,019 decision rows, 6 ledger intents), 13 QUALIFIED stage rows corresponding to 9 distinct source IDs, 73 ERROR observation rows. Two terminal realized-trade results total +$1.5421 net after recorded fees; sample insufficient for expectancy.

## Read-only production result

Warren Buffett selected, ARM off, owned lease, 3 NO contracts still locally recorded, 2 unresolved intents, one UNKNOWN protective exit and $3 reserved. Last successful lease heartbeat was 22:44:29 UTC. Railway's protected worker continues retrying signed history roughly every minute with exit_recovery_order_not_unique, not recording a verified terminal order. The public Kalshi historical order cutoff was Nov 13; the Nov 27 attempted exit is not presumed to have moved to archival orders.

## Release safety

- **UI correction**: differentiate QUALIFIED OBSERVATION from QUALIFIED DISPATCH, join by directSourceId, and use LEDGER_INTENT for actual fills; staged frontend PR #257.
- **STOP/DISARM**: keep protective worker while real exposure exists, finalize lease with account-first locks only on verified flat state; staged backend #414 / frontend #258.
- **Durable archive**: separate disabled-by-default postjournal transactional queue and S3 Object Lock; staged PR #413; no actual S3 bucket/restore credentials available.
- **Latency**: Brady PR #408 remains draft after orders-off tests failed the combined provider-tail/DB-wait profile; do not weaken five-second age or duplicate/fee guards.
- **No live merge/deploy** while protected UNKNOWN exposure remains. Public finalized market result alone cannot determine whether the account's protective exit filled. Owner-scoped signed exchange order/fill/settlement/cash proof is required before changing financial records or restarting bots.

No C52/C53 or Warren algorithm, stake, live order or production financial record was altered during analysis.
