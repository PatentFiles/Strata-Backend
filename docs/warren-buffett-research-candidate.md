# Warren Buffett V1 — independent live-selectable delayed-cross bot

This bot is **not** an edited C52/C53 or a proved profitable system. Brady's immutable
`v13-champion-2-c52-confirm53` algorithm, parameters, fee and policy hashes remain unchanged.

## Strategy

The Warren Buffett adapter uses the existing V1.3 crossing, direction and
price/fee order planner with a bounded **15-second pending-cross** state.
If the initial valid BTC crossing occurs too near the Kalshi market target,
a later *continuous, fresh, same-market, same-side* sample may qualify on the
original $8–$15 Scout or $20+ Confirm entry bands. An adverse recross,
target change, feed gap, stale provider timestamp, 15-second expiry,
new market, restart, or lost velocity invalidates the pending signal. No
previous observation is falsely labeled a fresh crossing. Quotes and book
must be newly observed and remain within the original 5-second final-wire
freshness limit. Scout/Confirm entry offers remain ≤52¢/≤53¢.

Shared protected V1.3 executor retains exact whole-contract IOC, fees,
position limits, cash conservation, risk reservations, stop/kill fences,
duplicate order prevention, UNKNOWN-recovery and authenticated reduce-only
exits. The clone carries an immutable bot ID/hash and separate sealed
crossing receipt; the original champion evaluator remains unmodified.

## Account owner flow

`GET /api/strata/me/bots/catalog` lists the saved strategy for the
authenticated AAL2 account; `POST /api/strata/me/bots/select`
requires explicit checkbox consent, one-use UUID, current backend release,
approved-policy hash and selection revision. The account must be stopped,
disarmed, flat, currently reconciled and free of uncertain operations.
A selection is recorded in private RLS-backed tables with its own
immutable audit history; it fences earlier ARM and demands a fresh owner
ARM followed by an independent deliberate START. Allocation policy
still controls stake and limits; it is not a strategy selector.
No frontend field grants order authority or silently updates another user.

Selection of the same bot on a later qualified SHA requires explicit
fresh owner consent, not implicit reactivation. The full exact-release
Warren flag `STRATA_WARREN_BUFFETT_LIVE_ENABLED=true` and
`STRATA_WARREN_BUFFETT_LIVE_SHA=<deployed forty-character SHA>` are
required for the option to be live-qualified. Otherwise selection fails
closed. New backend release requires reauthorization even for the same
selected bot; history remains immutable.

## Evidence, limitations and rollout

- Pure strategy, negative, source-reference, and catalog tests.
- Native PostgreSQL owner isolation, idempotency, selection history, RLS,
  wrong revision, live lease and release-rotation tests.
- Native execution suite: single Scout IOC on delayed cross, filled
  order, unchanged reduce-only protective exit and restart without replay,
  plus all original C52/C53 regression tests.
- Frontend AAL2 request guards and production build.
- CI must pass on the EXACT merged head. Release must pin existing platform
  approval SHAs and new Warren SHA before production activation.
- Deployment requires no fresh live orders, exposure or uncertain intents.
  Apply additive private-schema migration before deploying code.
- No claim of trained best parameters, positive expected value, robust
  fill probabilities or live out-of-sample profit exists yet. Compare future
  prospective after-fee, after-slippage results with the original champion,
  ideally in research mode before committing significant capital.

Rollback: stop/disarm the selected account, reconcile all Kalshi order/fill
and position history, disable the Warren flag and return to C52/C53 by
explicit owner selection/re-ARM. Never rewrite previous trades, alter
balances, retry an uncertain order or bypass an exit to switch bots.
