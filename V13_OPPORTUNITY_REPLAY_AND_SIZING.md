# V13 Opportunity Replay and Confidence-Weighted Sizing Research

## Purpose

This document records the next research layer built after the C52/53 loss-forensics review.

Two problems are addressed:

1. **False negatives:** profitable opportunities the launch champion may reject.
2. **Capital efficiency:** whether the same accepted opportunities should receive equal stake.

Neither capability changes production execution authority.

## Counterfactual opportunity replay

The research service can replay any V1.3 parameter set against the complete stored paper-evaluation stream.

For each market it:

- sorts observations chronologically;
- evaluates the candidate on the same BTC/Kalshi snapshots;
- opens only when that candidate independently produces SCOUT or CONFIRM;
- sizes in whole contracts from a research stake;
- applies the same V1.3 exit classifier;
- exits only at a recorded executable bid for the held side;
- leaves a trade UNRESOLVED when executable exit evidence is missing;
- never infers settlement or manufactures a bid;
- never creates an exchange order, capital reservation, live position or execution capability.

This is the mechanism for measuring opportunities C52/53 rejected. It removes the major denominator problem in the original 267 accepted-trade ledger.

## Research-only sizing profile

The first deliberately simple confidence-weighted sizing candidate is:

| Bucket | Research multiplier |
| --- | ---: |
| Any SCOUT/CONFIRM with entry offer <=40c | 1.25x |
| CONFIRM above 40c | 1.00x |
| SCOUT above 40c | 0.75x |

Maximum research multiplier: **1.25x**.

This is not a production sizing rule. The simulator linearly scales recorded paper P&L and stake, so it does not model depth, market impact, fees, partial fills or nonlinear execution effects.

## Historical result on the C52/53 reconstruction

Baseline C52/53:
- 255 trades.
- $1,275 total historical stake.
- $605.20 displayed P&L.
- 47.47% displayed return on stake.

Balanced research weighting:
- $1,205 simulated total stake.
- $662.84 simulated P&L.
- 55.01% simulated return on stake.

The profile therefore used about **5.5% less simulated stake** while producing about **9.5% more displayed P&L** in the linear paper simulation.

## Chronological validation

### Earlier 170 trades
Baseline:
- Stake: $850.
- P&L: $278.74.
- Return on stake: 32.79%.

Balanced weighting:
- Simulated stake: $803.75.
- Simulated P&L: $289.11.
- Return on stake: 35.97%.

### Later 85-trade holdout
Baseline:
- Stake: $425.
- P&L: $326.46.
- Return on stake: 76.81%.

Balanced weighting:
- Simulated stake: $401.25.
- Simulated P&L: $373.73.
- Return on stake: 93.14%.

The relationship improved both chronological blocks rather than only the full fitted sample.

## Outlier and execution stress

After removing the two largest historical winners:

Baseline:
- P&L: $464.02.
- Stake: $1,265.
- Return on stake: 36.68%.

Balanced weighting:
- Simulated P&L: $486.37.
- Simulated stake: $1,192.50.
- Return on stake: 40.79%.

Under a simple 5c adverse-execution haircut per contract:

Baseline C52/53:
- About $441.96 P&L.

Balanced weighting:
- About $500.85 simulated P&L.

These checks reduce, but do not eliminate, the risk that the result is driven only by the largest cheap-contract winners.

## Why this is still research-only

The simulation assumes approximately linear P&L scaling with stake.

Production sizing may not scale linearly because of:

- visible order-book depth;
- IOC fill quantity;
- VWAP deterioration;
- fees;
- market impact;
- queue/latency effects;
- partial fills;
- capital concentration.

The production executor must therefore continue to use the approved risk policy and depth planner. A sizing profile cannot become live merely because this historical simulation looks better.

## Promotion requirement

A confidence-weighted sizing profile should not be considered for production until prospective evidence shows:

- at least 50 completed matched outcomes;
- at least 7 elapsed days;
- improvement in net expectancy or return on deployed capital;
- no deterioration in reconciliation quality;
- no excessive concentration in a small number of trades;
- depth/fee/slippage-adjusted benefit remains positive;
- any larger stake remains inside separately approved production risk limits.

Promotion requires a reviewed production release and policy re-approval.

## Current decision

- **C52/53 remains the launch strategy champion.**
- Equal production sizing remains the commissioning default.
- Counterfactual replay is enabled for research on rejected opportunities.
- Balanced confidence weighting is the first sizing challenger.
- Neither replay nor sizing research has execution authority.
