# Autonomous V1.3 shadow learning — promotion remains owner-controlled

## Objective and authority

This is **autonomous RESEARCH**, not a self-modifying execution bot. The pinned live candidate is V1.3 C52/53, id `v13-champion-2-c52-confirm53`, canonical hash `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`.

The research lane may automatically train, compare and activate **new shadow-only versions** of tighter entry filters. It cannot change the champion parameters, the signed code release, balance accounting, fee authorizations, open orders, protective exits, account stake, live switches, broker permissions or cash. Its database table enforces `execution_authority = false`, and it cannot have a LIVE/APPROVED state.

### What self-improvement means today

- The existing paper worker collects Coinbase/Kalshi evaluation observations approximately every 5s when its explicit production paper flags and worker lease permit it.
- C51/53, C50 and C50/Confirm22 continue to collect prospective shadow opportunity evaluations, independently of the champion.
- Opt-in `STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED=true` adds a **once-per-UTC-day, non-blocking, fail-closed research candidate generation cycle** after a committed paper evaluation, using the existing authorized paper worker. Production + exact paper worker flags must already be true. It is disabled by default; enabling it is NOT permission to ARM/START, and no code merge activates it.
- Its training set consists only of completed, qualified champion paper position rows (within the last 30 days, max 1,200 recent rows), with actual recorded paper entry offer, entry spread, side/trigger, BTC separation, exit quote, contracts and paper P&L. Records without valid entry/exit evidence or missing spread are omitted; unfinished/open trades are NOT labeled winners or losses.
- Automatic discovery begins **only** after at least 7 elapsed calendar days, 60 completed qualified positions and five separate UTC observation dates. Chronologically partition by **whole UTC days** into early training (at least 35) and later holdout (at least 20) with no same-day contamination. All proposed settings are *stricter subsets* of champion entry limits; recross and momentum protective exit logic remains unchanged.
- Conservative **unverified quote-cost proxy** = original paper quote P&L less assumed general quadratic entry/exit fee (7% reference, rounded up to cents) and one observed entry-spread unit adverse each side (one leg only for a settled position). This is not approved effective historical fees, not actual executable depth or net realized P&L. The largest favorable original quote trade in each sample block is removed from BOTH champion and candidate scoring.
- A candidate is generated only if at least 70% of remaining champion entries would qualify in EACH half and it improves the modeled sum by at least $2 in BOTH training and holdout. That is **just a screening threshold**, not statistically significant proof of edge or a live recommendation. Scenarios rejected by all candidate variants yield `NO_ROBUST_IMPROVEMENT`; no new version is made. Repeated use of the same historical period does not create evidence.
- The deterministic proposal grid is bounded to Scout max prices 45–51¢, Confirm max prices 46–52¢, Confirm separation $20/$22/$24, fixed Scout $8–15 and fixed exits. Hash deduplication refuses existing champion/built-ins/previous versions. At most one new immutable shadow per UTC day, four concurrently active generated shadows and 20 generated records in total. If slots are full, research stops generating instead of expanding unboundedly or retiring evidence on its own.
- Autonomous versions are recorded with ID `v13-auto-shadow-YYYYMMDD`, exact parameter hash, creation/activation timestamp, machine creator identity and label **UNVERIFIED QUOTE COST**. Each is evaluated only **on future observed crossings**. Historical trades never get reclassified as newly prospective performance. Old learning candidates are not mutated. Any DB or model error is logged outside the champion cycle and cannot roll back, change or authorize a paper/live order.
- The authenticated, read-only `GET /api/strata/forward-test/adaptive-shadow-research` shows the pinned champion ID/hash, shadow rankings and prospective evidence coverage. It explicitly returns `executionAuthority=false`, `automaticPromotion=false`, and an unverified quote-data qualification. Ranking now includes active self-generated candidates and still demands **7 days AND 50 completed prospective matched candidate trades** for review eligibility. This eligibility alone does not permit promotion.

## Owner-controlled promotion protocol

1. Freeze research candidate code/config/version and its entire prospective observation/evidence manifest.
2. Verify after-fee, depth/queue/latency/IOC fill economics and effective Kalshi event fee overrides using **authenticated production** exchange data. Paper-only quote proxy is insufficient to promote.
3. Validate temporal walk-forward/out-of-sample across changing market regimes, downside risk, calibration, worst-loss distribution, largest-winner impact, traded capacity and settlement index basis.
4. Independent technical release review and operator selection, update immutable champion parameter hash through a separate reviewed code release, redo policy binding and owner's exact-SHA Step 12 consent.
5. Re-run V13 production safety, deployment, exchange reconciliation and protective-exit qualifications before a separately approved Step 13 START. Keep prior champion version and rollback available.

## Activation/deployment status

The current Railway connector exposes zero projects. The new research feature **cannot be confirmed active** until the existing backend is deployed at its exact new SHA and the above opt-in flag is configured server-side by an authenticated operator. Enabling this research-only flag never changes any Kalshi credential, fee source, cash state, risk switch or worker status. Do not create a replacement Railway project.

Additional planned refinements: incorporate exchange-time-synchronized predecision book depth, full/partial/zero IOC fills, authenticated effective fee evidence and BRTI settlement receipts into a versioned feature/label store; calibrate probabilistic models when sufficient independent verified data exists. Only evaluate deployment benefit on prospective after-fee metrics.
