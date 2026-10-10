# V13 C52/53 Loss Forensics — 267-Trade Paper Ledger

## Decision

**Keep C52/53 as the launch champion. Do not tighten it again merely to increase hit rate.**

The 267-trade accepted-history review shows that C52/53 already occupies the best total-P&L point among the bounded strict-subset entry rules that can be justified from this ledger.

The next improvement target is **entry quality and live execution telemetry**, not another hindsight price/separation cutoff.

## C52/53 reconstructed history

Applying the launch-champion rules to the original 267 accepted trades:

- Scout: $8-$15 separation, offer <= 52c.
- Confirm: $20+ separation, offer <= 53c.
- Wrong-side recross and momentum-invalidated exits unchanged.

Results:

| Metric | C52/53 |
| --- | ---: |
| Accepted trades | 255 |
| Positive trades | 199 |
| Losing trades | 56 |
| Positive-trade rate | 78.04% |
| Displayed P&L | $605.20 |
| Gross positive P&L | $610.89 |
| Gross losing P&L | -$5.69 |
| Average P&L/trade | $2.373 |
| Median P&L/trade | $1.39 |
| Average winner | $3.070 |
| Average loser | -$0.102 |
| Largest recorded loss | -$0.55 |
| Historical peak-to-trough drawdown | about -$0.60 |

The historical positive-trade rate has an approximate 95% Wilson interval of **72.6%-82.7%**. Hit rate should therefore be treated as an estimated property of this paper sample, not a fixed production guarantee.

## What C52/53 already fixed

Relative to the original 60c Scout / 68c Confirm ceilings, C52/53 rejects 12 historical entries.

Those 12 rejected entries contained:
- 7 losses;
- 5 winners;
- net displayed P&L of +$3.45.

That is why C52/53 improves hit quality while retaining 99.43% of the original displayed P&L. It removes a disproportionate number of low-quality expensive entries without throwing away much total expectancy.

## What the remaining losses look like

The 56 C52/53 losses are generally **fast aborts**, not large failed positions.

- Median losing hold time: **11.6 seconds**.
- Median winning hold time: **34.7 seconds**.
- 48 of 56 losses are between -$0.10 and -$0.05, totaling about **-$2.92**.
- Only 8 losses are worse than -$0.10; together they total about **-$2.77**.
- Those 8 larger losses account for roughly **49% of all recorded loss dollars**.

The worst eight were still small in absolute paper dollars: -$0.55, -$0.54, two at -$0.48, -$0.26, -$0.16 and two at -$0.15.

This supports the existing design principle: **abort failed crossings quickly rather than trying to eliminate every losing trade.**

## Exit behavior

Across the C52/53 reconstructed sample:

### Momentum-invalidated exits
- 199 trades.
- 88.4% positive.
- About $572.50 displayed P&L.
- 23 losing exits.

### Wrong-side recross exits
- 56 trades.
- 41.1% positive.
- About $32.70 displayed P&L.
- 33 losing exits.

Wrong-side recross has a low hit rate because it is the emergency invalidation path. It still produced positive aggregate P&L and is responsible for cutting many failed signals quickly.

**Do not remove or loosen the wrong-side recross simply because its subset hit rate is low.**

## Trigger and direction analysis

### SCOUT
- 186 trades.
- 76.34% positive.
- About $350.06 P&L.
- Average about $1.88/trade.

### CONFIRM
- 69 trades.
- 82.61% positive.
- About $255.14 P&L.
- Average about $3.70/trade.

CONFIRM is higher quality per trade, but SCOUT contributes more total historical P&L because it captures more opportunities. Eliminating SCOUT to maximize hit rate would materially reduce participation and profit.

Direction is not showing a useful structural bias:
- DOWN: 77.86% positive, about $354.42 P&L.
- UP: 78.23% positive, about $250.78 P&L.

There is no evidence here for disabling one direction.

## Why not optimize for a higher hit rate?

A bounded tightening search over:
- Scout minimum separation $8-$12;
- Scout maximum separation $12-$15;
- Confirm minimum separation $20-$30;
- Scout cap 45c-52c;
- Confirm cap 45c-53c;

shows C52/53 remains the **highest total displayed-P&L strict subset** at $605.20.

A much stricter historical rule can raise hit rate to about **82.5%**, but only by shrinking to roughly 154 trades and about **$412.19** displayed P&L.

That is a poor trade if the objective is to maximize net opportunity capture rather than maximize a cosmetic win percentage.

## What the old ledger cannot tell us

The original trade CSV does not contain enough information to determine whether remaining losses were caused by:

- wide entry spread;
- poor visible depth;
- quote staleness;
- BTC feed age;
- market snapshot age;
- weak signal persistence immediately after crossing;
- IOC partial fill behavior;
- actual fees;
- queue position;
- executable slippage.

It also does not contain outcomes for every rejected crossing, so it cannot measure the opportunity cost of false negatives.

Those are the next variables to study.

## Architecture improvement implemented after this review

The forward-test ledger now records, for every evaluation:

- YES/NO bid and offer;
- YES/NO spread;
- Coinbase provider age;
- Coinbase receive age;
- Kalshi market snapshot age;
- seconds remaining;
- signal/trigger decision and reason;
- exact champion parameter-set ID/hash.

Every newly opened paper position additionally records:

- selected-side entry bid;
- selected-side entry spread;
- entry seconds remaining;
- BTC provider/receive age;
- market snapshot age;
- exact champion parameter-set ID/hash;
- entry velocity, buffer, price and offer.

This makes future loss analysis capable of distinguishing **signal error** from **market/execution quality error**.

## Next optimization rule

Do not promote a new filter because it removes historical losers.

A new rule should be promoted only when prospective evidence shows that it improves **net expectancy after execution costs** while preserving enough profitable opportunities.

The next research questions should be:

1. Do losing crossings have wider entry spreads than winners?
2. Are losses concentrated in older BTC or Kalshi snapshots?
3. Is there a measurable persistence/velocity signature separating fast whipsaws from surviving trades?
4. Does available depth/VWAP predict which signals remain profitable after realistic fills?
5. Which currently rejected crossings later produce favorable executable moves, i.e. false negatives?
6. Does any proposed filter remain beneficial on prospective data and after fees/slippage?

## Current launch conclusion

C52/53 remains the designated launch champion.

The paper hit rate is **sufficient to continue toward controlled live commissioning**, because expectancy is driven by the asymmetry between large average winners and tiny fast-abort losses—not by achieving an arbitrary 80% or 85% win rate.

However, the 267 rows are not live-settlement proof. Production promotion still depends on executable fills, fees, slippage, partials/rejects, reconciliation and authoritative settlement.
