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

## 2026-10-22 market-data accuracy upgrade (PR candidate)

**Which feed is best?** Use *multiple noninterchangeable sources*. The settlement oracle is the official CF Benchmarks **BRTI** index and Kalshi's contract-specific **final-minute, 60-tick average**. BRTI is not just another Coinbase spot exchange price. For a faster spot *observation*, Kalshi additionally provides an authenticated `cfbenchmarks_value_5hz` channel publishing up to **5 updates per second** for `BRTI`; this channel explicitly **does not** include the 15-minute 60-second settlement accumulator. Kalshi's `cfbenchmarks_value` at ~1 Hz **does** include that accumulator. Both are entitlement-dependent. The matching Kalshi exchange **orderbook_snapshot/orderbook_delta** feed with per-subscription `seq`, market-specific `clock` and `sending_ts_ms` is the relevant market microstructure/executable depth source. Coinbase remains a separate 5-second sampled research/champion signal, not settlement authority. A real-time index is not an order-book fill guarantee or a forecasting edge.

- The official Kalshi public REST origin for the PAPER_ONLY market feed is now `external-api.kalshi.com` (the prior `api.elections.kalshi.com` remains supported); redirects are refused, and fallback extraction of BTC settlement strikes from ambiguous market titles is removed. An official machine-readable target is required, or paper entry fails closed.
- Read-only `cfBenchmarksFastReference` validates the BRTI 5Hz raw upstream `id`, `type`, publisher `time`, `value` against Kalshi's parsed `source_ts_ms`, `value_usd`, `received_at`. It refuses stale, future, malformed and contradictory frames, and only computes a **research basis** versus Coinbase when **both publisher timestamps** are available, fresh and aligned within 1.2 seconds.
- To opt in to the **read-only observer**, existing `STRATA_CF_BRTI_SHADOW_ENABLED=true` and optional `STRATA_CF_BRTI_5HZ_SHADOW_ENABLED=true` must be explicitly set in the already-reviewed production backend environment. Subscription IDs are separated: an optional 5Hz entitlement failure must not silently switch off the required 1Hz BRTI source. The status endpoint adds read-only fast-source diagnostics, message discontinuity count and provider timestamp. It never starts a trading worker or permits orders.
- **Corrected evidence labeling:** the existing PAPER_ONLY engine records Coinbase's observed price but not its actual provider timestamp. That makes its unqualified same-instant Coinbase-BRTI basis *unverifiable*. It is now shown as `null` with `UNVERIFIED_COINBASE_PROVIDER_TIMESTAMP`, never a fabricated cross-feed divergence. This is not a loss of real return data.
- Kalshi recommends `https://external-api.kalshi.com/trade-api/v2` for public REST and `wss://external-api-ws.kalshi.com/trade-api/ws/v2` for standard authenticated order-book/reference channels. The Kalshi CF Benchmarks REST passthrough `GET /cfbenchmarks/values?id=BRTI` (50 read tokens) may be used for controlled source diagnostics/backfill, not 5 Hz polling or signed settlement certification.

Source of truth: https://docs.kalshi.com/websockets/cfbenchmarks-value ,
https://docs.kalshi.com/websockets/cfbenchmarks-value-5hz ,
https://docs.kalshi.com/websockets/orderbook-updates ,
https://docs.kalshi.com/cfbenchmarks/rest-passthrough ,
https://docs.kalshi.com/getting_started/api_environments .

**Not yet established:** live entitlement, hosted WebSocket TLS/signing compatibility, data latency distribution, sequenced per-market book depth history, signed IOC fill-vs-book parity, effective rate overrides and actual CF Benchmarks settlement receipts. The 5 Hz shadow is not enabled by a code merge, cannot replace the C52/C53 signal, and does not clear Steps 12–13 or issues #46/#134. Compare orderbook snapshots with `seq` continuity and exchange `clock`; a skipped sequence requires fresh snapshot/reset, and book depth remains conditional until actual venue fills confirm.

---

## Activation and validation — separate from trading
1. Complete independent code/security review and CI for both repositories.
2. Confirm one existing Railway backend service, exact SHA, current Node version, clean reconciliation, and protective-exit safety before any deployment/restart.
3. Verify the Kalshi account's CF Benchmarks stream entitlement by authenticated indexlist containing BRTI. A successful WebSocket subscription alone does not prove index entitlement. Never imply the feed is live until confirmed.
4. After approved deployment, operator may opt in the independent research observer by setting STRATA_CF_BRTI_SHADOW_ENABLED=true and performing a controlled deployment. It must never auto-start the trading worker.
5. Validate BRTI provider time, sample counts, 60-second close-window alignment, market strike, data revisions, and final published settlements across real market windows. Keep Coinbase price as a separate signal rather than treating it as Kalshi's settlement reference.
6. Collect synchronized official BRTI, Coinbase BTC, executable Kalshi orderbook, fees, timing, fill/non-fill, and official settlement data. Evaluate net EV, Brier calibration, temporal holdout and confidence intervals before allowing any separately approved strategy change.

## Remaining unknowns
Actual CF feed entitlement; whether Railway offers Node >=22; successful real WebSocket frames on this deployment; sustained reference history; any change in profitable hit rate. CI cannot prove market-data entitlement or improve trading edge. The execution champion and all live order, risk, kill, release and protective-exit rules are unchanged by these shadow changes.
