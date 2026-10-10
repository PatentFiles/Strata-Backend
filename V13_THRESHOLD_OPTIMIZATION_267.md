# V13 267-Trade Threshold Optimization Study

## Scope

This study uses the 267 accepted V1.3 paper trades from September 24 through October 6, 2026.

The optimization is deliberately limited to **tightening parameters that are observable in the accepted-trade ledger**:

- Scout minimum/maximum BTC separation.
- Confirm minimum BTC separation.
- Scout maximum entry offer.
- Confirm maximum entry offer.

The historical ledger cannot safely prove that loosening the current $8 Scout minimum or $20 Confirm minimum would improve results because opportunities rejected by those current thresholds are absent from the trade ledger. Future full-observation replay/shadow data is required before widening the entry envelope.

Exit behavior is held fixed:
- Wrong-side recross: $8.
- Momentum invalidation: enabled.

No exit rule was optimized on these same 267 rows.

## Original baseline

Former V1.3 60/68 baseline:

| Parameter | Value |
| --- | ---: |
| Scout separation | $8-$15 |
| Confirm minimum separation | $20 |
| Scout max offer | 60c |
| Confirm max offer | 68c |
| Trades | 267 |
| Displayed paper P&L | $608.65 |
| Positive-trade rate | 76.40% |
| Average P&L/trade | $2.280 |
| Median P&L/trade | $1.30 |

## Search

A bounded grid search tested combinations inside the original 60/68 entry envelope:

- Scout minimum: $8-$12.
- Scout maximum: $12-$15.
- Scout max offer: 45c-60c.
- Confirm minimum: $20-$30.
- Confirm max offer: 45c-68c.
- At least 150 accepted historical trades retained.

24,271 qualifying parameter combinations were evaluated.

Every shortlisted result was also checked on:
- chronological thirds;
- an initial 178-trade / later 89-trade split;
- 2c adverse execution per contract;
- 5c adverse execution per contract.

The execution haircuts are deliberately conservative sensitivity tests. They are not a substitute for actual live fill/slippage/fee evidence.

## Findings

### 1. Raw historical P&L maximum: C57_CONFIRM56

Parameters:
- Scout: $8-$15, max offer 57c.
- Confirm: $20+, max offer 56c.
- Exit logic unchanged.

Results:

| Metric | Legacy 60/68 | C57_CONFIRM56 |
| --- | ---: | ---: |
| Trades | 267 | 264 |
| P&L | $608.65 | **$608.77** |
| Positive rate | 76.40% | **77.27%** |
| Avg/trade | $2.280 | **$2.306** |
| 2c adverse execution | $541.19 | **$541.82** |
| 5c adverse execution | $440.00 | **$441.39** |
| Later holdout trades | 89 | 86 |
| Later holdout P&L | $323.52 | **$323.64** |
| Later holdout positive rate | 76.40% | **79.07%** |

Important limitation: this candidate beats the legacy baseline by only $0.12 because it excludes exactly three historical -$0.04 trades. That is too small a margin to treat as reliable proof of superiority. It is retained as a **raw-profit benchmark**, not the recommended promotion candidate.

### 2. Selected launch champion: C52_CONFIRM53

Parameters:
- Scout: $8-$15, max offer 52c.
- Confirm: $20+, max offer 53c.
- Exit logic unchanged.

Results:

| Metric | Legacy 60/68 | C52_CONFIRM53 |
| --- | ---: | ---: |
| Trades | 267 | 255 |
| P&L | $608.65 | $605.20 |
| P&L retained | 100% | **99.43%** |
| Positive rate | 76.40% | **78.04%** |
| Avg/trade | $2.280 | **$2.373** |
| Median/trade | $1.30 | **$1.39** |
| Maximum losing streak | 3 | **2** |
| 2c adverse execution | $541.19 | $539.90 |
| 5c adverse execution | $440.00 | **$441.96** |
| Later holdout trades | 89 | 84 |
| Later holdout P&L | $323.52 | **$323.74** |
| Later holdout positive rate | 76.40% | **80.95%** |

This candidate rejects 12 of the 267 historical entries. Those rejected trades had a net positive P&L of $3.45, which explains the slight reduction in full-sample P&L. However, the candidate improves trade quality, later-period results, and severe execution-stress results while preserving more than 99% of historical P&L.

**This is the designated first-live champion for the Brit handoff.**

### 3. High-efficiency challenger: C51_CONFIRM53

Parameters:
- Scout: $8-$15, max offer 51c.
- Confirm: $20+, max offer 53c.
- Exit logic unchanged.

Results:

| Metric | Legacy 60/68 | C51_CONFIRM53 |
| --- | ---: | ---: |
| Trades | 267 | 250 |
| P&L | $608.65 | $602.18 |
| P&L retained | 100% | **98.94%** |
| Positive rate | 76.40% | **78.40%** |
| Avg/trade | $2.280 | **$2.409** |
| Median/trade | $1.30 | **$1.46** |
| Later holdout trades | 89 | 83 |
| Later holdout P&L | $323.52 | **$323.79** |
| Later holdout positive rate | 76.40% | **81.93%** |

This is the best shortlist candidate for reducing marginal trades while retaining nearly all historical profit. It is more selective than C52_CONFIRM53 and produced the best later holdout P&L and hit rate among the three main challengers.

### 4. C50 is too restrictive for a profit-max objective

The 50c/50c candidate improves hit rate and per-trade efficiency but gives up too much historical total P&L:

- 232 trades.
- $582.68 displayed P&L.
- 78.45% positive rate.
- $2.512 average P&L/trade.
- Later holdout: 74 trades, $312.76 P&L, 82.43% positive.

C50 remains useful as a strict benchmark but is **not the preferred production candidate** when the objective is maximum total net expectancy.

## Recommendation

**Promote C52_CONFIRM53 as the designated first-live champion.**

Rationale: it preserves 99.43% of the original baseline P&L while improving hit quality, median/average trade quality, maximum losing streak, later holdout results and the severe 5c adverse-execution stress result. C57/56 is retained only as a historical raw-profit benchmark because its $0.12 in-sample advantage over the old baseline is too small and concentrated to trust.

Prospective research after promotion:

1. **Launch champion: C52_CONFIRM53.**
2. **Efficiency challenger: C51_CONFIRM53** — stricter subset; eligible for matched prospective ranking.
3. **Strict benchmark: C50** — stricter subset; eligible for matched prospective ranking.
4. **C50_CONFIRM22** — stricter subset; eligible for matched prospective ranking.
5. **Legacy 60/68 and C57/56** — broader historical/reference benchmarks; they require independent outcome evidence before they can displace C52/53.

## Adaptive architecture rule

The system may automatically:
- generate bounded research candidates;
- replay them against complete observation history;
- run chronological/walk-forward and execution-stress scoring;
- activate zero-authority shadow testing;
- rank candidates and produce a promotion recommendation.

The system must **not** automatically:
- change the champion;
- change exit logic;
- change production capital limits;
- approve a live-money policy;
- give a research strategy execution authority.

Champion promotion remains an explicit reviewed release. The production risk policy is pinned to the champion parameter hash, so a promoted strategy requires deliberate policy re-approval.

## Data limitation

The 267-trade file contains only trades that V1.3 accepted. It cannot answer whether relaxing the current entry envelope would discover additional profitable opportunities.

The new full-observation/shadow architecture is intended to solve that problem prospectively. Once enough complete observations are accumulated, the same replay framework can test both tighter and broader opportunity logic without relying only on accepted trades.
