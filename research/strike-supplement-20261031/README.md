# OFF/SHADOW-only strict strike supplement replay

Research artifact, not deployable integration. Constructor defaults OFF; ACTIVE is unsupported. No production imports, network, DB, approvals, credentials, order APIs or protective-exit integration. `validatePublished` models a same-process synchronous generation/provenance check, not a real signing callback. Caller authenticated subscription/account/host context is a trusted fixture contract, not production authentication.

## Evidence versus fixtures
Only the14:30 tickerKXBTC15M-26OCT311045-45, floor77322.12, provider timestamp00.565, receipt00.591, sequence410/generation1 and REST-ready10.920 are actual retained production facts. Positive-test REST scope/quotes are synthetic and labeled. Measured evidence WITHOUT scope rejects. No counterfactual executable quote/fill claimed.

Fixture policy `{admissionMaxAgeMs:5000,progressMaxAgeMs:5000,maxSilenceMs:2000,maxMetadataAgeMs:15000}` exercises distinct clocks; these numbers are NOT an approved/recommended live policy. Actual bounds require same-window REST identity/quote readiness and maximum accepted stream-silence measurements. Never assume fifteen-minute immutable strike. Proposed semantics: observed full-tuple baseline, bounded sender→receipt admission, separate same-generation sequential-envelope liveness lease, separate initial-tuple lifetime. Gap/reconnect/expiry/correction quarantines WS use for the window; late frames cannot revive it. No consumed-crossing reset. Current uninterpreted event/fee updates conservatively invalidate even when unrelated: restrictive research behavior, not a performance-ready event parser.

## Identity mapping
Official Market schema makes exchange_index optional and has no series_ticker. Existing twoSourceFeeEvidence requires series.ticker=KXBTC15M, series.exchange_index=2, event.series_ticker=KXBTC15M and exact market/event event_ticker match. Optional market/event index must not contradict2. `normalizedRestIdentity` models that join plus separately trusted host/account fixture context. Missing rawmarketindex is accepted; no unconditional fallback2 or ticker-derived venue. Its ok result is preliminary, NOT authority: configureIdentity must additionally validate ticker/window/status/type. Neither helper proves actual authentication or complete fee policy. Early joined scope availability at14:30:00.591 remains unmeasured.

## Production work deliberately absent
Existing-response evidence capture; immutable source provenance persistence/config-policy binding; actual producer/prepare/final-wire adapters; authenticated runtime manager; cross-process epoch authority; protected-exit integration. No entry-source admission gate may be added to independent protective/emergency exit route. This artifact does not test those production adapters.

Current feed has no future exact-market prewarm: discovery selects currentmarket; route cache retains only currentticker. Prefer ordinary currentwindow exactdetail join, with a bounded untrusted WS candidate admitted only after scope validation while source admission is still fresh. If too late, separately review one future exactdetail GET perwindow and futureidentity discovery/sharedcooldown budget; do not guess ticker suffix/timezone, reuse listprices or disguise added request as free.

## Tests / review
Run `node --test strike-supplement.test.mjs` (20tests). Independent review found and fixed silence-expiry resurrection, partial conflicting updates, sender regression, deactivation/window changes and contradictory REST identity. Final module and tests independently reviewed; all20 passed. This is research-only signoff, not rollout or live latency qualification.

Every envelope used for liveness must have a valid bounded sender age under separate progressMaxAgeMs; delayed/missing/future sender timestamps on unrelated markets cannot renew it. This bounds observed progress age but does not prove replay completeness or eliminate unobserved corrections.
