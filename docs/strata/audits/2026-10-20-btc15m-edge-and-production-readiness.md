# Strata KXBTC15M — independent deployment and strategy evidence audit
Date: 2026-10-20
Status: **NO-GO for new live inventory; read-only evidence audit**

## Verified GitHub
- Consolidated backend recovery PR #113 is already MERGED. Do not merge obsolete PRs #110–112 individually; they are overlapping predecessor drafts.
- Institutional authority ADR PR #114 is MERGED, but an ADR is **not** executable three-layer authority code. A separate staged implementation and review remains required.
- Frontend owner repair PR #80 is MERGED; Bolt publication has not been verified.

## Verified active production (19:28 UTC read-only snapshot)
- Existing Railway backend service remains at previous deployment; revised backend is not verified deployed.
- Personal worker heartbeat remains fresh, but `forward_test_evaluations` has 0 rows; owner ledger records 0 order intents and fills.
- The production owner still carries stale `blocked_reason='awaiting_account_commissioning'`. This blocks `ProductionExecutor.gate`; a source-code preventative fix is not the same as a completed account recovery.
- Existing exact-SHA protective-exit release expired 18:14:47 UTC. New genuine independent approval and owner authorization required for new entries, with separate ARM/START after reconciliation.
- Public `paper_history`, `forward_test_positions`, and strategy shadow evaluation tables contain 0 rows. Historical 267-trade source data is not available in those tables; no verified net hit rate, ROI, profitable alpha, or confidence interval can be claimed.
- Railway configuration variable for producer was set, but staged changes and actual container activation remain unverified.

## Current immutable champion
- `v13-champion-2-c52-confirm53`, hash `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`
- Scout separation $8–$15; confirmation separation at least $20; scout limit 0.52; confirm limit 0.53; momentum invalidation exit enabled.
- Historical tuning bounds and zero-execution-authority research challengers exist; none is a verified promotion.
- No market-return prediction is justified by these static thresholds without out-of-sample evidence.

## P0 strategy verification
1. **Settlement basis:** compare Coinbase feature price with CF Benchmarks BRTI reference used by Kalshi; archive the actual market settlement rule per ticker and contract start/end minute averages. Model basis distribution conditional on volatility and time to settlement. Never label single Coinbase tick as settlement truth.
2. **Price and expected value:** evaluate `probability - executable ask - entry fees - expected exit fees/slippage/adverse selection`; a nominal win-rate cannot substitute for net EV. Record order-book depth, best executable offer, actual fill or non-fill, rounding at account precision, market liquidity and latency.
3. **No optimistic fills:** replay timestamped top-of-book/depth and queue/crossing conditions with delay; exclude unavailable stale quotes and use actual official settlement. IOC partial fills and unknown outcomes must be first-class.
4. **Selection bias:** fixed chronological training/validation/test periods, purged event-window overlap, walk-forward on untouched data; cluster confidence intervals by market date/regime, account for multiple-testing and changing liquidity.
5. **Comparator:** champion C52/53 versus predeclared C51/53 and C50 challengers versus a calibrated probability baseline, plus a no-trade comparator. Promote only independently reviewed prospective net EV, drawdown and execution reliability, never the largest in-sample hit rate.
6. **Capacity:** use executable contracts, order-book impact, fees, settlement risk and exchange-specific precision; $1.50 stake alone doesn't validate scalable strategy performance.
7. **Operational gates:** restored live signal producer; fresh market data; correct selected account; current exchange reconciliation; nonstale fee verification; kill, loss, position, stake and lease fences; durable independently reviewed exact SHA; separate owner ARM+START; independently reviewed protective reduction after entry operational evidence expires.

## Institutional 3-layer authority implementation requirements
Separate:
A. Durable revocable *code* approval bound to actual compiled artifact digest + exact deployed SHA and independent reviewers.
B. Ephemeral account/market operational readiness with fresh evidence and transactional checks.
C. Explicit authenticated owner ARM/START, with immediate per-account/global kill revocation.

Current code still has a 2-hour release lifetime and 20-minute residual-validity buffer, and existing protective exit path checks signed-release expiry. **The durable-approval redesign is not implemented simply because ADR #114 was merged.** Design additive shadow evaluator, write independent regression against active exit after entry-evidence expiry, include fee/quote freshness, actor role separation, controls, one-use fencing, crash recovery, and approve migration separately. Never make an expired entry cache strand an independently authorized reduce-only exit, and never disable the exit's own immutable approval/one-use safeguards.

## Rollout
Only one existing Railway trading service/replica. No live trading or forced orders during outage. Independently review merged backend diff and corresponding Railway deployment SHA; complete release for actual deployed version; repair existing owner stale sentinel through authenticated owner-approved audited workflow with zero exposure; verify genuine forward-test evaluations; reconcile authoritative exchange and journal; separately ARM and START. Prove fill/partial/unknown/restart cases before declaring live-ready.

**Result:** Static code review and GitHub CI do NOT establish real-money profitability or complete the live-money authorization process. Trading NO-GO until outstanding gates are verified.
