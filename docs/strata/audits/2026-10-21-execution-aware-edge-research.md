# C52/53 — net edge and executable-liquidity sensitivity (research only)

**As of:** 2026-10-21 09:51:34 UTC fixed cutoff. **Authority:** NONE; not an activation or profit claim.

## Decision

Keep the pinned V1.3 C52/Confirm53 production strategy unchanged. This very short sample does not justify changing signal thresholds, size, account gates or kill switches. Prioritize exchange-depth capture, observed signed IOC order behavior and first-party CF Benchmarks BRTI basis measurement. **Neither a quote nor a completed paper position proves an executable fill.**

## Read-only production evidence and reproducible selection

Source: `public.forward_test_positions` (status `CLOSED` / `SETTLED`, `entered_at < '2026-10-21 09:51:34.099+00'`), joined to `public.v13_strategy_shadow_evaluation` by *exact* ticker, evaluated_at=entered_at, direction and trigger; candidate must have `would_enter=true` and `execution_authority=false`. No SQL writes, exchange orders or account changes.

- **31** closed paper positions; ~13-hour collection period; paper engine stake is **$5** (constant `PAPER_STAKE=5`), but actual approved per-entry configuration is **$1.50** for four accounts.
- Gross *paper* P&L +$368.53 on $147.33 of paper entry notional. An exceptional 333-contract hypothetical purchase at **1.5¢** and hypothetical sale at **97¢** generated **$318.02** paper gross, or ~86% of the recorded total. This is a market-quote observation, NOT proof that 333 contracts were available/filled at these prices.
- Retaining the same paper entry and exit quotes but re-sizing every trade to `floor(1.50/entry_offer)`, the entire champion sample produces **$109.25** gross and **$105.48** after one illustrative quadratic order fee per leg. The latter includes the unverified exceptional winner.
- Without that outlier, the champion sample produces **$10.30** after illustrative fees. With additionally 1¢ / 3¢ / 5¢ adverse execution **per contract per leg**, illustrative net is **$8.44 / $4.72 / $1.00** respectively. This is not a measured latency distribution or execution outcome.

| Research candidate | Closed exact-match sample | $1.50 nominal stake fee-adjusted *quote* P&L | Same sample excluding exceptional winner |
| --- | ---: | ---: | ---: |
| Champion C52/53 | 31 | +$105.48 | +$10.30 |
| C51/53 | 31 | +$105.48 | +$10.30 |
| C50 | 28 | +$104.76 | +$9.58 |
| C50/Confirm22 | 26 | +$103.61 | +$8.43 |

All four share the exceptional winner. These are **in-sample matched quote scenarios**; no challenger has established a superior net execution edge. Fees are illustrative, assuming `ceil(0.07 * contracts * p * (1 - p) dollars, to cents)` per leg; the current exchange fee model must still be obtained from authenticated, current official evidence before trades are permitted.

## Implemented research-only model

`artifacts/api-server/src/lib/v13ResearchExecutionStress.ts`:

1. Prices represented as integer $0.0001 ticks, money as `bigint` USD micros; strict whole-contract and duplicate-ID validation.
2. Applies explicit **entry and exit adverse price stress**, **$1.50 affordability cap**, and an **explicit illustrative quadratic fee coefficient** per order.
3. Accepts venue-confirmed whole-contract available depth only when available. Otherwise records **missing depth** and never sets `pnlProvenByExchangeFills=true`. A hypothetical executable quantity is still only *model* quantity.
4. When known exit depth cannot cover the acquired position, leaves **known residual inventory** priced at zero immediate recovery instead of pretending all contracts exit at the best bid.
5. Reports modeled P&L **with and without the largest positive contribution**, avoiding apparent edge driven by a single exceptional quote. Reports source-sample size and depth completeness.
6. Exported result is **SHADOW_ONLY, executionAuthority=false, quoteModelOnly=true** regardless of modeled profit. No POST, database writes, owner/reviewer impersonation, strategy promotion or permission side effects.

Safety regressions cover cent fee rounding, missing depth, zero exit liquidity, partial exits, adverse price shocks, non-executable price bounds, duplicate observations, invalid inputs and extreme winners. V13 diagnostic CI includes the tests.

## Critical limitations and next validation gate

- Paper feed's 5–8 second cadence and instantaneous top-of-book quote carry neither order-book depth, contemporaneous signal-to-order latency nor realized IOC responses. The production planner does fetch depth, but that does not turn historical paper quotes into proven executable fills.
- Coinbase spot is **not** Kalshi's CF Benchmarks minute-averaged settlement reference. The BRTI observer remains a read-only cross-check; matched live-time BRTI/basis observations are needed before assessing terminal P&L near expiry.
- 31 positions over ~13 hours are statistically inadequate for a strategy change. A nominal 7-day/50-position review gate is only eligibility for human inspection; a credible *risk-adjusted* launch requires genuinely more independent prospective observations, observed depth, conservative fee and slippage, filled-order behavior, verified exits, robustness across regimes, and successful account/production release gates #20, #46, #52, #58, #77.
- If depth is absent or market data is stale, **do not synthesize an executable win rate or use modeled positive net P&L to authorize entries.**

**Promotion decision: NO CHANGE to C52/53 thresholds; NO LIVE AUTHORITY.**
