# Entry and exit shadow research

Offline, unwired Python 3 standard-library research tooling. No dependencies to install, runtime imports, network, database writes, credentials or order submission. Nothing here modifies the strategy or authorizes trading. These modules use synthetic fixtures, not an empirical backtest.

Run from this directory:

    PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -v

## Scope

- `exit_shadow.py`: price-limited visible bid depth, full-depth sensitivity, verified-supplied-fee hypothetical net and adverse price stress. Whole-contract positions only.
- `policy_shadow.py`: supplied baseline momentum exit events versus elapsed persistence/minimum hold. Hard exits are never delayed. Invalid observations and sampling gaps reset persistence. Future/stale quotes are excluded.
- `capture_shadow.py`: allowlisted public-data envelope, identity, time, continuity and depth validation. Book availability is body completion. Local capture sequence is not an exchange sequence. Depth quantities are hundredths of contracts, deliberately distinct from the whole-contract evaluator.
- `trajectory_manifest.py`: separate declared start/end/count/drop/entry/fee/terminal coverage gate. Missing heads/tails cannot silently qualify. Manifest booleans must be independently substantiated by existing verified evidence, not set optimistically.

**Do not directly feed capture quantities into exit_shadow.** A reviewed adapter must map hundredths to supported whole quantities conservatively, bind the held YES/NO side and preserve remainder, timestamps and fees. No adapter or production collector is installed here.

## What this does not prove

Visible book capacity is not execution. Provider time, queue position, latency, book cancellations, fees, entry/exit receipts and settlement need independent evidence. Even a valid coverage manifest cannot establish profits. `realized_net`/certified executable fields stay unknown; execution authority stays false. A candidate can help or harm: tests explicitly include both.

No true bid-band hysteresis, joint entry-policy simulator, settlement simulator or actual fill model is implemented. No future maximum price may select a past decision. Maximum favorable excursion is retrospective diagnostics only. Do not read this as approval to hold through wrong-side recross, data failures, expiry or any existing hard-risk boundary.

## Experiment before changing policy

1. Freeze baseline source, exact strategy/risk parameters, small research-only candidate grid, scoring and time horizons.
2. Test exit-only policy changes on identical independently supported entries; then separately test joint entry/exit changes with complete opportunities, ask depth, fee-aware available cash and occupancy/opportunity cost. One experiment cannot stand in for the other.
3. Capture every decision/opportunity, not just executed paper transitions. Continue trajectories through the common terminal horizon after baseline exit. Preserve rejected/unknown/no-entry cases and missingness denominators.
4. Bind original observation availability, strategy inputs, verified fee version and entry evidence. Use asynchronous bounded storage with drop counters; no extra work on the order-critical path. Agree retention/storage budget before adding collection.
5. Chronological development/holdout by market/day, purged overlapping horizons, fixed candidates before holdout. Report net modeled paired differences plus data coverage, tail losses, drawdown, holding time, turnover and latency/slippage sensitivity; cluster uncertainty by day rather than correlated ticks.
6. Reconcile fills for actual realized P&L separately. No live policy promotion from paper win rate or this synthetic suite.

## Historical evidence limitation

A bounded latest-200 query on November 9, 2026 found 102 ENTRY and 98 EXIT book snapshots for the paper engine. All 98 exit receipts followed the paper event, averaging 812 ms later; 35 supported full original-limit quantity. The database uniquely keys position/phase, so these are not continuous counterfactual hold trajectories. This does not establish absence of other archives or a population-wide fill rate.

## Provenance

Based on main commit `4d3294687c95087033579c371f0ca8a271efa1ac`, verified source tree `8ca1c6c696ef561a3c9fd4d410c69c4c7704b595`. Changes remain research and reporting only; publication does not enable collection or authorize live strategy changes.
