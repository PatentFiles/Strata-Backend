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

## Telemetry lock isolation correction (staged, not deployed)

The production Supabase PostgreSQL log has `55P03` for a live-decision journal insert waiting on the financial-account foreign-key row lock. This is a **telemetry loss/latency defect**, not established as the cause of the separate protective EXIT failure. The staged backend now delivers journal observations through a dedicated PostgreSQL pool (maximum one connection; 1,500 ms checkout), with 750 ms FK lock wait bound, 3 s statement budget, up to 12 idempotent attempts on the same UUID, and a finite 4,096-record capacity. No observation wait occupies the main execution pool, and the price/fee/duplicate/exposure gates are unchanged. A disposable PG native test held the real account lock, observed SQLSTATE 55P03 without blocking other financial queries, released the lock, and confirmed replay persisted exactly one event. The expanded queue unit tests preserve finite retry/gap reporting. This remains a bounded *memory* queue; crash loss and overflow are possible and explicitly reported.

## Owner-reported classification and requested restart (2026-11-28)

The site operator reports that the November 27 Warren Buffett order was placed during a software test that encountered errors, and requests a fresh trading session. This is an **operator-reported TEST INCIDENT classification**, not proof that the signed Kalshi fill was a paper/mock order. The immutable ledger currently records a three-contract NO entry fill on the live account target; a protective EXIT remains submission-uncertain. The test label must not be used to delete an actual exchange fill, fabricate settlement, zero collateral, or authorize a new order.

Latest read-only Supabase check on November 28: one actionable UNKNOWN protective reservation, one nonzero position, one unreleased lease, no recorded settlement event, no economic settlement booking for market `KXBTC15M-26NOV271745-45`, $3.00 of modeled reserve still held. The November 25 historical UNKNOWN has a canonical economic discharge and is not an active blocker.

Requested product outcome: a deliberate STOP/DISARM stops new entries; when a complete signed exchange reconciliation proves zero remaining exposure, an owner-authorized exact settlement/discharge releases eligible stale accounting reserves and the fenced worker lease while keeping trade history and net P&L. A subsequent deliberate ARM prepares a new run and START remains separate. A failed read must produce the exact safe reason and preserve the state, not a generic "can't reset" or a silent record deletion.

Frontend draft #259 includes a follow-up owner-context diagnostic: on an ARM refusal due to exposure, cash conservation or financial hold it tries **one read-only owner-scoped signed settlement preview**, displays the safe refusal code, and directs the owner to the open Wallets incident recovery controls. No financial POST, order retry or START is made from the diagnostic. The site still needs the backend's actual signed Kalshi evidence and qualified release before the specific historical incident can be discharged.

Brady's November 27 reply requests contact with the affected account owner, or exact settlement and reserve-release receipt references (never credentials), or the specific preview refusal code. Do not assert this is the current Gmail owner's account until authenticated owner linkage is verified.
