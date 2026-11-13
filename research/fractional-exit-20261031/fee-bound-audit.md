# Fractional EXIT fee-bound audit (local only)

Base canonical tree `541acaeab34afdb5286237352d96af533ebb65ae`. No provider, production DB, approval, policy, risk limit, deployment or order changes.

## Existing formula reused, not replaced

`ownedMarketEvidence` in `strata/personalExchangeRead.ts` binds current exact-market fee metadata, grid, source artifact/policy and integer plan count into the fingerprint. Its `reservedExitFeeCents` is the upward whole-cent ceiling of `maximumExitFeePerContractMicros * contracts`. The underlying `microLiveEntryFees.ts` bound already models 100 independently rounded .01-contract fills per contract (including conservative balance rounding and sell-loss allowance across the verified grid). It is a conservative future-exit allowance, **not an assertion of an actual charged exchange fee**.

The new isolated `conservativeExitFeeMicros` helper leaves that fee basis and identity unchanged. For an existing reserve R cents over C whole contracts and a selected Q hundredths, it returns:

`ceil(R * Q / (100 * C)) * 10000` micros.

All operations are BigInt, and rounding is only upward. Since the existing R is already rounded up from a linear per-hundredth upper bound, this cannot undercut that bound. No rebate credit or decimal quantity conversion is introduced. Fee source/policy/fingerprint/freshness, exact position quantity, capability identity and parent reserve checks remain mandatory in the executor. This helper alone does not authorize any quantity or order. Its bounded canonical units range preserves historical whole-count requests; the separate new fractional request authority keeps the existing owned protective limit of 100000 hundredths (1000 contracts).

The reviewed API fee wire already accepts a positive exact two-decimal `count`; the owned emergency candidate and signed dispatcher parse hundredths. The exact-market final fee verifier has no integer-count restriction. No fee-wire or fee-source change is needed. Separate SQL quantity identity updates remain owned by the protective-ledger reviewer.

## ENTRY low-price/high-count allowance audit

Existing `preflightV13LiveMoneyEntry` binds fee basis count and price exactly to its whole-contract plan. `evaluateV13LiveMoneyRisk` checks gross + entry reserve + full future-exit allowance against approved all-in, cash, capital and remaining loss budgets. `ProductionExecutor.prepareEntry` persists the full amount and `exit_fee_micros`; ledger reconciliation retains that exit allowance while any position quantity remains, and fails closed if it cannot retain it.

Targeted tests used the unchanged actual fee helpers and existing ENTRY preflight with a $5 configured stake/$25 capital ceiling and ample depth:

| Reference | Whole contracts | Entry allowance (cents) | Future-exit allowance (cents) | Existing admission |
|---|---:|---:|---:|---|
| $0.0001 | 50000 | 500 | 4999500 | rejects capital/stake limit |
| $0.0070 | 714 | 36 | 71393 | rejects capital/stake limit |
| $0.0690 | 72 | 33 | 7200 | rejects capital/stake limit |

Thus $5 notional does not imply a small exit allowance, and the existing monetary admission protects this pilot without changing sizing/limits. This is offline policy arithmetic, not a read of current approval or fee charges. There is no explicit 1000-contract ENTRY cap in the gross/depth planner; the owned protective path does have that cap. A larger separately approved capital policy could encounter that existing mismatch. Do not infer universal size compatibility or silently broaden caps; no speculative redesign is part of this patch.

## Validation

Five isolated tests pass, including every new permitted quantity 1..100000 on both sides with three basis counts against the actual existing per-hundredth upper bound (600000 comparisons), exact whole-basis compatibility, overflow-safe large arithmetic, malformed inputs and the low-price ENTRY cases. API typecheck passes. The tests import the real fee module, which initializes the DB package, so use the existing disposable loopback runner, not ambient production credentials:

```
PATH=/tmp/strata-bin:/tmp/strata-pg/usr/lib/postgresql/17/bin:$PATH node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs src/lib/v13-production/fractionalExitFee.test.ts
```

The integrator must wire this command into the fractional EXIT safety suite and run the combined executor/ledger/SQL/transport regressions. This helper patch is not release approval or a completed fractional EXIT implementation by itself.
