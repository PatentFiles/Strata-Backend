# V1.3 largest wins/losses forensic study — October 23, 2026

**Research-only.** Read-only Supabase query findings from `public.forward_test_positions`, 159 completed positions ending 2026-10-23 23:06:40 UTC, plus matched shadow evaluations. No execution authority; do not alter pinned champion or live risk settings. All dollar outcomes are gross simulated quote cash flows unless explicitly stated.

## Core findings

- 159 trades: paper gross +$659.20; 125 positive, 34 negative. Three gains >$20 are +$318.02 (333 contracts at 1.5c to 97c), +$69.04 (74 contracts at 6.7c settled $1), +$25.23 (31 contracts at 16c to 97.4c), combined **+$412.29** (62.54% gross). Full paired entry/exit price-limited book support: **0/159**; hence reported profits cannot be certified executable.
- The three largest losses are each -$4.99, involving entry offers 1.6c, 2.4c and 3.2c, whole-contract stakes ~$4.99, entry with only **15.1, 17.7 and 21.9 seconds** remaining. All settled in the wrong direction. They account for $14.97 of gross loss; all other losses have absolute magnitude <=$0.27.
- Original 159 recorded gross positive trades: 125. Under an *illustrative* generic 7% per-order quadratic fee assumption, nine formerly gross-positive positions become nonpositive; fee-adjusted positive count 116. Gross +$659.20, modeled fee drag $61.76, optimistic quote-only after fee +$597.44. Market-specific official fee rates, actual fills, queue priority, and slippage have not been verified.
- Gross paper median P&L $1.20. The data spans just four partial UTC dates, with noncausal post-action REST book receipts. Win rate and price/velocity interactions are not a reliable live expectancy estimator.

## Segmented timing

| Time remaining | Trades | Gross P&L | Reference-fee quote P&L |
| --- | ---: | ---: | ---: |
| <30 sec | 3 | -$14.97 | -$16.01 |
| 60–119 sec | 4 | +$397.10 | +$394.79 |
| 2–5 min | 11 | +$52.60 | +$48.01 |
| 5–10 min | 36 | +$95.87 | +$80.79 |
| >=10 min | 105 | +$128.60 | +$89.86 |

No 30–59s paper entries in the sample. A historical >=30s filter removes exactly three $4.99 losers, retaining 156 trades and a quote-only after-fee +$613.45 versus +$597.44. **This is an in-sample selection effect, NOT a verified prospective uplift.** It is dangerous to move the threshold upward without testing: a 120-second cutoff also rejects the $318.02 and $69.04 paper winners. All those winners remain execution-unverified.

## Price, momentum and strategy

- Entry offers <5c: four positions, three losses and one +$318.02 extreme winner; this is an unstable binary tail and a severe whole-contract exposure jump (~252 contracts average). Entry offers 5–9c: one +$69.04 settlement.
- 20–34c entries: 15 recorded paper wins, no losses, but sample is tiny and non-execution-backed; do not optimize entry threshold around it.
- CONFIRM UP gross +$392.88 across 24 entries, but dominated by the same +$318.02 outlier. CONFIRM DOWN +$117.13 / 29, SCOUT DOWN +$77.93 / 46, SCOUT UP +$71.26 / 60. This is insufficient to promote direction-specific rules.
- Wrong-side recross closes: 31 trades, 15 negative, gross +$28.38, illustrative after-fee +$15.94. Momentum-invalidated closes: 124 trades, 16 negative, gross +$576.75, modeled after-fee +$528.80. Exit label is assigned after entry, and cannot safely be used as a predictive entry feature.
- Entry velocity magnitude >=150: 16 positions with one negative and gross +$390.43, but again strongly contaminated by huge winners; velocity isn't an independently established live edge.

## Shadow coverage: existing thresholds miss catastrophic late entries

Matched each recorded paper position to corresponding `v13_strategy_shadow_evaluation` around the entry timestamp. The three existing zero-authority challengers retain **all three** major losses:
- `v13-research-c50`: 136/159 retained, gross +$638.41.
- `v13-research-c50-confirm22`: 123/159 retained, gross +$615.16.
- `v13-research-c51-confirm53`: 152/159 retained, gross +$654.97.

The best next tests are **(A)** no new research entries with <30 seconds to expiry (compare 30 vs 60, and pre-register rule before next data), and **(B)** price-limited entry quantity capped at 10 or 20 contracts with fee-inclusive $5 gross exposure, while preserving the separate cost-aware risk policy. Do not infer executable gains from truncating simulated winners or losers.

### Illustrative quantity-cap sensitivities (NOT live profitability)

Using `min(paper contracts, cap) × (recorded exit - entry price)`, illustrative per-order 7% quadratic fees, same recorded quote prices and no fill/latency proof:

| Cap | All 159 quote-only after-fee | With >=30s filter | Worst price-only single trade |
| ---: | ---: | ---: | ---: |
| 10 contracts | +$174.20 | not calculated | -$0.32 |
| 20 contracts | +$246.38 | +$247.94 | -$0.64 |
| 50 contracts | +$317.90 | +$321.76 | -$1.60 |
| Unbounded paper sizing | +$597.44 | +$613.45 | -$4.99 |

**Important**: A flat 20-contract cap also leaves most nominal original risk unspent in cheap-entry scenarios; comparing such strategies requires same-cash, same-cost, same-fill/opportunity accounting and risk-adjusted expectancy, rather than maximizing gross quote P&L. The cap is intended to constrain execution concentration, not to turn illiquid prices into available fills. If the venue has no depth, the correct modeled entry is zero.

## Research proposal and evidence gates

1. **Register a zero-authority shadow hypothesis**: entry only if >=30s remaining, with optional 60s sensitivity; contract caps of 10 and 20, total cash <=$5 inclusive of current provider-verified fees, conservatively require real price-limit book depth.
2. **Paper-only prospective evaluation**: record would-enter, policy version/hash, market, signal side, quoted spread, momentum, BTC freshness, end-of-window seconds, depth confidence, post-event and (when available) sequenced pre-action snapshots, rejection reason. New samples must remain chronological; no retroactive relabeling of old winning/losing actions.
3. **Holdouts and uncertainty**: at least seven full dates, five distinct market dates, and enough independent liquid candidate trades; pre-register primary metric risk-adjusted executable after-fee after-slippage expectancy, not just gross win percentage. Slice by settlement horizon, entry price, contract count, BTC-vs-BRTI basis, volatility, market hour and trigger. Estimate confidence intervals by day/event cluster and compare downside tail.
4. **Fail-closed defaults**: unknown order, fee expiry/429, missing causal depth, stale market/BTC data, no authorized exits => no live entry. Study shadow only; do not change exchange scope or emergency exits.
5. **Manual promotion decision** only when outcomes are supported by prospective evidence and legitimate governance; current champion stays unchanged.

The exact raw source data lives in Supabase; this document is a dated research snapshot, not a replacement for the authoritative records.
