# Warren Buffett v1 — research candidate, not a live release

Name supplied by the product owner. Not an endorsement, a representation of Warren Buffett's methods, a trained model, or a profit claim.

## Implemented
- Separate pure stateful classifier. Original lib/v13-strategy files and C52/C53 parameter hash are unchanged.
- A genuine observed cross opens a 15-second maximum confirmation window. Later fresh observations may reach the unchanged Scout $8–15 or Confirm $20+ band. Expiry, recross, market identity change, data gaps, source staleness and repeated provider time invalidate custody.
- The remembered cross is not falsely stamped as a new crossing. Each priced candidate retains original crossing time and a separately fresh current observation.
- Original 52/53-cent ceilings, 30-second velocity calculation and exit classifier retained. No fee, risk, sizing, market feed, or exit-floor relaxation.
- At most one emitted research signal per market per engine lifetime. Replay/cross-session live deduplication is NOT supplied by this research module.
- Authenticated read-only /api/strata/me/bots/catalog reports actual approved owner strategy. Missing policy has no invented default. Warren Buffett always reports RESEARCH_ONLY, NOT_LIVE_QUALIFIED and executionAuthority=NONE.
- Frontend companion draft distinguishes bot identity from allocation/sizing. Experimental selection is deliberately disabled; no strategy POST, approval, localStorage selection, ARM or START is introduced.

## Qualification observed
28 backend candidate/catalog tests plus full workspace TypeScript check passed locally. Boundary coverage includes both directions, immediate versus delayed crossing, price ceilings, gap, expiry, restart/rollover, missing/late/wrong-market quotes, clock rollback, candidate forgery, repeated emission and unchanged exits. These are software tests, not performance training or live fills.

## Intentionally outstanding before LIVE strategy selection
1. Account-scoped immutable strategy revisions and owner consent bound to policy/fee/release grants. A display dropdown is not authority.
2. Worker source custody, PREPARE reclassification, final wire checks, protective-exit bindings, history provenance and restart tests for the new strategy ID. Do not label a delayed confirmation as a fresh C52/C53 crossing to get past the current gates.
3. STOP/flat/no UNKNOWN/no pending transfer requirement, versioned selection transaction, stale-tab rejection, and new ARM consent. No hot switching and no implicit START.
4. Native database and integrated browser/isolated-exchange full cycles for both strategies, no C52/C53 behavior change, then exact-head protected qualification and approved stopped-state deployment.
5. Prospective quote/depth/latency/fees and realized outcomes. The 15-second window is an initial test hypothesis, not an optimized or statistically validated setting. Existing history lacks quotes for many rejected observations, so it cannot prove hypothetical fills or profits.

Recovery release #406 remains separate. Do not deploy this draft over a running worker.
