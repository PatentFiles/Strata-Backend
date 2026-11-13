# V1.3 Paper Research: Gross P&L, Order-Book Feasibility, and $5 Pilot Fault Matrix

**Evidence snapshot:** 2026-10-23 (UTC), production Supabase `wqsmfbzfbiilhtzpqbrb`.  
**Scope:** `public.forward_test_positions` and `public.forward_test_book_snapshots`; V1.3 champion `v13-champion-2-c52-confirm53`.  
**Mode:** RESEARCH ONLY. No SQL writes, Kalshi orders, financial-account mutations, live risk-limit changes, or strategy promotion. This report is not an exchange-certified backtest or approval for live orders.

## Reconciliation of all 158 completed paper positions

- Total: 154 CLOSED and 4 SETTLED, from 2026-10-20 to 2026-10-23 UTC. Aggregate recorded stake: **$754.799**.
- Stored gross P&L **+$654.88**; independent recomputation of cash flows (`payout - stake`) yields **+$654.875** before per-row rounding. Six rows differ by at most $0.005 because of rounding; no discrepancy greater than $0.005001.
- For all 158 positions, `stake = contracts × entry_offer` within microdollar precision. No null P&L, zero/negative quantities, reversed timestamps or invalid entry offer.
- This verifies **paper-ledger arithmetic**, **NOT** independent entry fills, exit fills, settlement receipts or fee deductions.
- Highest trade: 333 contracts bought at $0.015, sold notionally at $0.970, $4.995 entry and $323.01 assumed exit proceeds. Recomputed gross $318.015 displayed $318.02. No entry/exit book receipts exist for that position; real bid depth and possible execution remain unverified.
- Three winners above $20 contribute **$412.29**; headline excluding these = **$242.59**. Observed paper wins = 124/158 (78.5%); sample spans just four partial UTC dates, insufficient for a durable out-of-sample live edge claim.
- Maximum observed sequence of losing paper positions: four.

## Fee assumption sensitivity: NOT approved KXBTC15M tariff

Illustrative reference ONLY: `ceil(0.07 × contracts × price × (1-price) × $100) / $100`, once on entry and additionally on market EXIT; no exit fee on SETTLED. This follows the publicly described general Kalshi quadratic reference but does **not** establish current market/event/series overrides, actual fills, rebate eligibility, rounding of partial fills or official fee authorization.

- Illustrative entry fees: **$31.26**. Illustrative exit fees: **$29.98**. Quote-only gross less illustrative fees: **+$593.64**.
- Adding an *extra* adverse one cent per contract on each leg (entry + closed exit) reduces it to **+$544.24**; two cents per leg: **+$494.84**.
- These positive hypothetical totals **must not be displayed as executable net P&L**, because trades may fail to fill at any modeled price.

## Depth replay: every position must prove both sides

The application captures REST bids-only books **after** the paper action and derives ask capacity from complementary bids; `capacity.modeledFilledContracts` enforces **the original limit and whole-contract depth**, not venue fills. REST has no exchange sequence or authenticated order-execution receipt, so these are *post-action sensitivity tests* only.

| Population | Count |
| --- | ---: |
| Completed positions | 158 |
| Entry receipts (CAPTURED) | 44 |
| Exit receipts (CAPTURED) | 42 |
| Both captured | 41 |
| Entry receipts with FULL price-limited quantity | 3 of 44 |
| Exit receipts with FULL price-limited quantity | 10 of 42 |
| **Same position with FULL entry and FULL exit** | **0** |
| All entry observations with modeled zero entry quantity | 41 of 44 |
| All exit observations with modeled zero exit quantity | 32 of 42 |

Entry book REST delay from paper event averages **1,672 ms**, exit averages **1,598 ms**; these are NOT contemporaneous snapshots. Latest outlier trade >$20 with both books captured (paper +$25.23) has modeled zero entry and zero exit quantity at the original prices. The +$318.02 trade lacks both books; the +$69.04 settlement lacks a validated entry execution receipt.

**Acceptance criterion:** Any sample without both correct-direction, price-limited, causally timestamped executable-book evidence must remain UNVERIFIED, not silently counted as a win. Current exact-book full round-trip supported count = **0**, and **verified executable P&L = UNKNOWN**, not $0. Future true claims require venue order acknowledgments, IOC/partial-fill results, market sequencing/latency evidence, and provider fee/settlement receipts.

## Deterministic $25/$5 research pilot fault cases

Implemented in `forwardTestBookReplayResearch.ts` with unit tests and no backend worker interaction:

- FIVE 20%-of-remaining losses (first stake limited to $5): simulated whole-cent stakes **$5.00, $4.00, $3.20, $2.56, $2.04**; remaining **$8.20**, a **67.2% drawdown**, *excluding fees*. Dynamic allocation shrinks with capital; never reuse a fixed $5 stake when cash is lower without policy approval.
- One-cent exit on an illustrative 10-contract 50-cent entry returns $0.10 of the $5 outlay; pre-fee loss **$4.90**. Exit price permission is NOT a guaranteed fill or protective mechanism.
- LOW_LIQUIDITY: zero fill; do not mark or submit a filled order.
- KALSHI_429: stop further hypothetical entries when official fees cannot be verified.
- UNKNOWN_ORDER: maintain unresolved state across worker restarts; never retry/resubmit on timeout without reconciled exchange identity and order states.
- WORKER_RESTART: never convert a blocked/unknown order to flat just because the process restarted.
- UNSIGNED_RECONCILE: cannot unblock an unresolved order or override signed exchange evidence.

**Out of scope:** These pure-function fault tests do not demonstrate actual Kalshi behavior, crash-consistent database fencing, protective-exit release, or permission to ARM/START. Those remain independently controlled by the existing verified production flow.

## Champion and challengers — read only

The V1.3 `forward_test_engine` was observed enabled, `PAPER_ONLY`, current heartbeat (approximately 5 seconds old), `last_error=NULL`. Three challenger parameter sets remain `SHADOW` and `execution_authority=false`, each with ~34k evaluations (latest by 2026-10-23 22:47 UTC). Champion changes and self-promotion are not authorized by this report. Existing autonomous learning requires at least 7 elapsed days and 5 independent dates before it can even propose a new version.

## Unfinished evidence / rollout requirements

1. Obtain **causal** book observations with exchange timestamps/sequence if available, IOC fill confirmations, true entry and exit fill cost, fees, latency and partial fills, plus authenticated settlement receipts. Do not backfill this with REST observations captured afterward.
2. Apply a strict, source-verified KXBTC15M fee version for any admission comparison. Never treat the illustrative 7% proxy as the actual current tariff.
3. Hold the current paper champion and three shadow challengers immutable, research-only.
4. Repeat and expand this audit after sufficient new causally grounded execution samples. **Do not use these paper results as a go-live release approval.**
