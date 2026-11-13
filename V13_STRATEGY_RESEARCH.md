# V13 Strategy Research and Parameter Architecture

## Purpose

V13 now separates three concerns that must not be conflated:

1. **Strategy opportunity logic** — which market conditions qualify as SCOUT/CONFIRM and when a position is invalidated.
2. **Research/challenger logic** — alternative parameter sets evaluated prospectively with zero execution authority.
3. **Capital/risk authority** — how much money the production executor may reserve or trade after a champion signal qualifies.

Changing a strategy threshold must never silently change capital authority, and changing a capital limit must never change what V13 considers an opportunity.

## Locked execution champion

The designated first-live champion is **V1.3 C52/53**, parameter-set ID **v13-champion-2-c52-confirm53**.

Its parameters are:

| Parameter | Launch champion |
| --- | ---: |
| Scout minimum separation | $8 |
| Scout maximum separation | $15 |
| Confirm minimum separation | $20 |
| Scout maximum offer | 52c |
| Confirm maximum offer | 53c |
| Wrong-side recross exit | $8 |
| Momentum-invalidated exit | enabled |

The canonical champion parameter serialization is pinned to SHA-256:

**314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161**

The normal evaluateV13Strategy() function is hard-bound to this set. Micro-live, production preflight, forward-test evidence and the production risk policy require the exact champion ID/hash.

## Research parameter sets

Alternative parameter sets live in the v13_strategy_parameter_set table.

Allowed states are:

- **DRAFT** — defined but not prospectively evaluated.
- **SHADOW** — prospectively evaluated against real public market observations.
- **RETIRED** — no longer evaluated.

Research rows are database-constrained to execution_authority = false. There is intentionally no APPROVED or LIVE research state.

Each research version stores its ID and integer version, optional superseded parameter-set ID, label, all strategy parameters, deterministic parameter hash, creator identity and creation time, and shadow activator identity/time.

Parameter changes create a **new version**. Do not mutate the active champion in place.

## Shadow opportunity evaluations

After a champion paper cycle has committed, the worker may evaluate active SHADOW parameter sets against that same recorded BTC/Kalshi observation.

Results go only to the v13_strategy_shadow_evaluation table.

Each shadow row records the source champion evaluation ID, challenger parameter ID/hash, BTC and target data, signed/absolute separation, velocity, both Kalshi bids and offers, seconds remaining, first-cross status, challenger signal/direction, whether the challenger would have entered, entry offer, and reason.

Shadow processing runs **after** the champion/micro-live cycle and behind its own error boundary. Research failure cannot roll back or alter champion trading behavior.

## Initial research presets

The 267-trade optimization produced a ranked shortlist. See **V13_THRESHOLD_OPTIMIZATION_267.md** for the full grid-search, chronological holdout, and adverse-execution results.

The worker automatically seeds the vetted shortlist into **SHADOW** state after acquiring the paper-worker lease. Seeding is non-authoritative: every built-in row is database-constrained to execution_authority = false, and a research failure cannot block champion processing.

The automatic prospective shortlist now contains only **strict subsets of C52/53**, so each challenger trade can be matched to a champion paper outcome:

1. **C51_CONFIRM53** — higher-efficiency challenger.
2. **C50** — strict price benchmark.
3. **C50_CONFIRM22** — strict price plus stronger Confirm-separation challenger.

The old **60/68** rules and **C57/56** remain historical/reference benchmarks. They are broader than C52/53 and cannot be ranked from matched champion outcomes unless an independent paper/replay path records the additional trades they would take.

C52/53 is no longer a research challenger; it is the designated launch champion.

### C51_CONFIRM53

- Scout max offer: 51c
- Confirm max offer: 53c
- Scout separation: $8-$15
- Confirm minimum separation: $20

Purpose: higher-efficiency challenger with fewer marginal entries and stronger later holdout hit rate.

### C57_CONFIRM56

- Scout max offer: 57c
- Confirm max offer: 56c
- Scout separation: $8-$15
- Confirm minimum separation: $20

Purpose: raw historical P&L benchmark. Its apparent advantage is very small, so it must not be promoted without prospective confirmation.

### C50

- Scout max offer: 50c
- Confirm max offer: 50c
- Other champion thresholds unchanged

Purpose: test whether removing the historically weaker >50c entries improves prospective expectancy while retaining most opportunity value.

### C50_CONFIRM22

- Scout max offer: 50c
- Confirm max offer: 50c
- Confirm minimum separation: $22
- Other champion thresholds unchanged

Purpose: test the 50c price filter together with a slightly stronger CONFIRM separation requirement.

## Automatic adaptation boundary

The automatic prospective lane may tighten the champion's **entry filters** within a bounded search space:

- Scout minimum separation: $8-$12.
- Scout maximum separation: $12-$15.
- Confirm minimum separation: $20-$30.
- Scout maximum offer: 45c-52c.
- Confirm maximum offer: 45c-53c.

It deliberately keeps the exit rules fixed:

- Wrong-side recross: $8.
- Momentum-invalidated exit: enabled.

This is safe to score as a subset model because V1.3 SCOUT/CONFIRM entries occur only on the fresh crossing. Tightening a separation or price threshold therefore rejects some champion crossings; it does not create a later entry. Every challenger trade can be matched exactly to the corresponding champion paper trade and its realized paper P&L.

The automatic lane does **not** loosen the champion entry envelope. Broader thresholds require a separate prospective study because the 267 accepted-trade ledger does not contain the opportunities the champion rejected.

## Prospective challenger scoring

For every active price-cap challenger, the research service can compare matched closed/settled champion paper positions from the challenger's activation time onward.

It records/derives:

- champion completed trades;
- challenger completed trades;
- trades avoided;
- champion and challenger P&L;
- P&L retention;
- positive-trade rates;
- average P&L/trade;
- elapsed evidence window.

A challenger becomes **review-eligible** only after at least **50 matched completed trades and 7 elapsed days**. Review eligibility is evidence sufficiency only. It never changes the champion, approves money, or grants execution authority.

## Advisory ranking

Once challengers have prospective outcomes, the research service ranks them by P&L retention first, then positive-hit rate, then average P&L/trade. A candidate is not considered review-ready until it clears the 7-day / 50-completed-trade evidence gate.

The ranker is advisory only. It can identify a research leader, but it cannot change the champion, approve a live-money policy, or authorize execution.

## Counterfactual opportunity replay

The research service can replay alternative V1.3 parameter sets against the complete stored paper-evaluation stream, including crossings rejected by C52/53. Replays use recorded executable bids for exits and remain UNRESOLVED when exit evidence is missing. They never create exchange orders, capital reservations or live positions.

## Confidence-weighted sizing research

Equal production sizing remains the commissioning default. A separate simulator can test research-only sizing profiles against matched paper outcomes. The first balanced profile weights entries at 40c or cheaper at 1.25x, higher-priced CONFIRM at 1.0x, and higher-priced SCOUT at 0.75x. This profile has no execution authority and requires prospective validation before any production consideration.

See `V13_OPPORTUNITY_REPLAY_AND_SIZING.md` for the historical chronology, outlier and execution-stress checks.

## What is deliberately frozen for now

The fast-abort exit architecture remains champion behavior while entry filters are tested.

The historical sample suggests wrong-side recross and momentum invalidation are central to V13 loss containment. Do not optimize them from the same 267 rows merely because the recross subset has a lower win rate.

The current shadow evaluator is therefore **entry-opportunity research**, not a second executable position engine.

## Promotion rule

A challenger does not become live by changing its database state.

Promotion requires a separate reviewed code release that:

1. establishes enough prospective shadow evidence to justify the change;
2. checks chronological/holdout and prospective results rather than fitting only the original 267 trades;
3. evaluates missed winners as well as avoided losers;
4. measures execution-sensitive effects: entry price, spread, depth, fillability, fees, slippage and latency;
5. changes the immutable champion parameter set and champion hash intentionally;
6. creates/re-approves a production risk policy pinned to that new champion identity rather than inheriting the old approval;
7. updates regression expectations and handoff documentation;
8. passes the complete V13 production/micro-live CI suite;
9. leaves production capital/risk limits unchanged unless a separate risk-policy decision changes them.

This makes parameter promotion an auditable software release, not an operator toggle.

## Metrics for comparing challengers

Do not select the winner based on hit rate alone.

Primary comparison metrics should include opportunity count/participation rate, positive-result rate, net expectancy per accepted opportunity, median outcome, downside distribution, missed champion winners, avoided champion losers, entry-price distribution, executable depth/VWAP, fees/slippage-adjusted expectancy, and stability across time blocks and market regimes.

A stricter filter is better only if the quality gained is worth the profitable opportunities it rejects.

## Relationship to production risk policy

The strategy parameter architecture does **not** authorize dollars.

The separate live-money policy still controls capital limit, maximum entry notional, fee-inclusive all-in ceiling, maximum open positions, daily/total loss limits, quote/fee freshness, and production policy identity/hash.

This separation allows V13 to learn which opportunities are best without weakening production risk controls.
