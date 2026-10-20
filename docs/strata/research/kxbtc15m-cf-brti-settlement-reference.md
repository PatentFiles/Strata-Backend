# KXBTC15M settlement-index basis: implementation and safe release
Status: READ-ONLY SHADOW, DEFAULT OFF, NO ORDER AUTHORITY.

## Proven provider methodology
KXBTC15M uses CF Benchmarks Bitcoin Real-Time Index (BRTI). A Kalshi quarter-hour contract resolves against the CF index's final 60-second mean compared with the market's official strike, subject to the exact terms and any revisions. The authenticated cfbenchmarks_value WebSocket provides the BRTI live spot on every tick and a distinct last_60s_windowed_average_15min during the final minute. Do not substitute the generic trailing avg_60s_data or a 60-second Coinbase average.

Official references:
- https://docs.kalshi.com/websockets/cfbenchmarks-value
- https://docs.kalshi.com/cfbenchmarks/rest-passthrough
- https://help.kalshi.com/en/articles/13823838-crypto-markets

## Changes prepared on PR #117 and frontend PR #83
- Pure validated parser accepts only BRTI, monotonic fresh provider timestamps, bounded values and aligned quarter-hour windows.
- Independent sixty-distinct-seconds cross-check rejects incomplete, duplicate and out-of-window samples; preserves 12 decimal USD digits. Kalshi's quarter-minute accumulator is preferred to a reconstructed approximation.
- Server-side WebSocket monitor, off unless STRATA_CF_BRTI_SHADOW_ENABLED=true, has GET-only Kalshi authenticated handshake, indexlist entitlement proof, 30-second reconnect backoff and no signing capability for order POSTs. Requires Node >=22 for native WebSocket custom handshake headers.
- Server-only key material comes from KALSHI_INDEX2_API_KEY_ID and KALSHI_INDEX2_PRIVATE_KEY; never publish keys or expand trading privileges for data access. Prefer a separate read key if the venue supports it.
- Authenticated read-only GET /api/strata/forward-test/settlement-reference returns fresh BRTI current spot, final-minute partial average, same-market official Kalshi strike and Coinbase-BRTI basis where available. It never returns settlement certification, expected win probability or trading authorization.
- Frontend displays BRTI SPOT (NOT SETTLEMENT) throughout each window; it switches to FINAL-MINUTE ESTIMATE only when an authenticated matching-market final-minute sample exists. Unavailable or old data remains unverified.

## Activation and validation — separate from trading
1. Complete independent code/security review and CI for both repositories.
2. Confirm one existing Railway backend service, exact SHA, current Node version, clean reconciliation, and protective-exit safety before any deployment/restart.
3. Verify the Kalshi account's CF Benchmarks stream entitlement by authenticated indexlist containing BRTI. A successful WebSocket subscription alone does not prove index entitlement. Never imply the feed is live until confirmed.
4. After approved deployment, operator may opt in the independent research observer by setting STRATA_CF_BRTI_SHADOW_ENABLED=true and performing a controlled deployment. It must never auto-start the trading worker.
5. Validate BRTI provider time, sample counts, 60-second close-window alignment, market strike, data revisions, and final published settlements across real market windows. Keep Coinbase price as a separate signal rather than treating it as Kalshi's settlement reference.
6. Collect synchronized official BRTI, Coinbase BTC, executable Kalshi orderbook, fees, timing, fill/non-fill, and official settlement data. Evaluate net EV, Brier calibration, temporal holdout and confidence intervals before allowing any separately approved strategy change.

## Remaining unknowns
Actual CF feed entitlement; whether Railway offers Node >=22; successful real WebSocket frames on this deployment; sustained reference history; any change in profitable hit rate. CI cannot prove market-data entitlement or improve trading edge. The execution champion and all live order, risk, kill, release and protective-exit rules are unchanged by these shadow changes.
