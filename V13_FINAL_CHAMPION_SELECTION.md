# V13 Final Champion Selection

## Designated first-live champion

The handoff is built around **V1.3 C52/53**:

- Parameter-set ID: `v13-champion-2-c52-confirm53`
- Parameter hash: `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`
- Scout: $8-$15 separation, max offer 52c
- Confirm: $20+ separation, max offer 53c
- Wrong-side recross: $8
- Momentum-invalidated exit: enabled

## Why this route

C52/53 was chosen as the production launch candidate because it retained about 99.4% of the 267-trade displayed paper P&L while improving hit rate, average/median trade quality, losing-streak behavior, later-period holdout performance, and the 5c adverse-execution stress result.

C57/56 produced only a $0.12 higher in-sample P&L than the original baseline. That margin is too small to justify using it as the first-live route without prospective confirmation.

## Required review before live money

Immediately before first live-money approval:

1. Review all prospective challenger evidence accumulated since the handoff.
2. Confirm C52/53 still has the strongest production case, or explicitly promote another eligible strategy release.
3. Persist a review ID and SHA-256 evidence hash.
4. Record the operator identity and selection timestamp.
5. Pin the production policy to the selected champion ID/hash.
6. Recompute the policy hash.
7. Run the complete V13 CI/safety suite.
8. Run the read-only live-readiness verifier in the intended deployment.
9. Approve the production policy only after the champion selection is complete.
10. Begin with controlled-size commissioning before any size promotion.

The production policy fails closed if the final champion-selection evidence is missing, malformed, selected after policy approval, or does not match the executable champion identity.

## Challenger treatment after promotion

Automatic prospective ranking is limited to challengers that are strict subsets of C52/53, such as C51/53, C50, and C50/Confirm22.

Broader references such as legacy 60/68 and C57/56 remain historical/reference benchmarks unless an independent paper/replay path records the additional trades they would take.

## Authority boundary

Champion selection does not itself:

- approve capital;
- enable credentials;
- fund an account;
- deploy the executor;
- arm live trading;
- submit an order.

Those remain separate production controls.
