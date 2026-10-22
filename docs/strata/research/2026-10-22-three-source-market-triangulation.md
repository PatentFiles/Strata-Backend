# Strata three-source, low-latency BTC market reference — 2026-10-22

## Architecture (read-only, never an order signal)

1. **Kalshi CF Benchmarks 1Hz BRTI** (`cfbenchmarks_value`): authoritative **reference for contract-defined final-minute averaged price**, but never a provider settlement receipt; its `last_60s_windowed_average_15min` must not be replaced by spot or `avg_60s_data`.
2. **Kalshi CF Benchmarks up to 5Hz BRTI** (`cfbenchmarks_value_5hz`): faster instantaneous index. Independent index/time/value validation; no settlement average or independent trading edge.
3. **Kalshi orderbook_delta WebSocket** for the currently tracked KXBTC15M paper market: authenticated GET-only WSS handshake, initial `orderbook_snapshot`, strictly consecutive **per-subscription seq**, equal or jumping market `clock` permitted, negative/regressed clock quarantined. Reconstruct whole-book YES/NO bid depth in fixed-point integers. Market-specific `clock` and ticker bound; any seq gap, unexpected quantity, stale sending timestamp, disconnect or ticker rollover makes book unavailable until fresh exchange snapshot. Derive YES asks from NO bids `1-price` and vice versa. No spoofed executable fill guarantee.
4. **Coinbase Exchange public ticker+heartbeat WSS**: independent low-latency BTC-USD trade reference including event provider timestamp, best bid/ask and sequence. Ticker updates need not be continuous or gapless (sequence can skip); invalid, stale, out-of-order, wrong-product and crossed quote observations are denied. No Coinbase key needed.
5. **Triangulation**: report aligned BRTI current index/verified Coinbase publisher times (≤1.2s skew), fresh observed depth, best bids/asks, and no-order state. This is **observational**; simultaneous fresh snapshots do not imply positive expected value, fill priority, microstructure edge or settlement certainty. Paper V1.3 stays on its existing 5s Coinbase REST inputs until separately approved prospective statistical evaluation.

## Default-off activation (RESEARCH ONLY)

Requires production deployment of approved exact backend SHA, restored authenticated access to the **existing** Railway project, and secure server runtime. No changes through browser/client code:

- `STRATA_CF_BRTI_SHADOW_ENABLED=true` for the 1Hz settlement-aligned observer.
- `STRATA_CF_BRTI_5HZ_SHADOW_ENABLED=true` only when the 1Hz observer is approved and Kalshi BRTI indexlist confirms entitlement.
- `STRATA_TRIANGULATED_MARKET_RESEARCH_ENABLED=true` to opt into **separate read-only** Kalshi book and public Coinbase ticker WS.
- `KALSHI_API_ENVIRONMENT=production` and `NODE_ENV=production` for research startup; restricted server-side `KALSHI_INDEX2_API_KEY_ID` and `KALSHI_INDEX2_PRIVATE_KEY` for GET-only authenticated Kalshi WSS handshake. Keep key material server-side. Prefer standalone least-privilege read key if Kalshi permissions allow it.
- Disabled under development staging; does NOT require or set global live execution, owner SHA, stake, account ARM, protective release, or any trading permission.

Authenticated user-only, no-cache `GET /api/strata/forward-test/market-triangulation` exposes source state, publisher timestamps, Kalshi book `seq/clock`, error/gap counts and explicit `tradingAuthority=false`. A missing observer, unentitled BRTI, stale Coinbase ticker, stale book, or unequal source clocks leads to `sourcesFreshAndAligned=false`; **not a reason to bypass stale prices**. The frontend Paper Research page shows the same read-only diagnostics.

## Hard quality limits

- BRTI source 3s freshness with strict upstream Kalshi 5Hz value/time equality; never infer benchmark entitlement from WebSocket transport success alone.
- Kalshi book: exchange `sending_ts_ms` at most 5s old, locally received at most 2.5s old, exact `seq` continuity and same market/market ID/SID. Any gap requests `get_snapshot` on the same subscription; no automatic missed deltas are applied.
- Coinbase source: at most 3s old, only BTC-USD ticker, bid ≤ ask and publisher timestamp within 1.2s of BRTI tick for spot-basis claims.
- **Actual Kalshi account fills, effective fees, settlement and owner authorizations are separate authorities**. This release is not allowed to place orders, mutate policy, change cash, or promote champion V1.3.
- The WS collector is currently in-process, so on Railway multiple replicas **may double subscribe**; use a single dedicated observer instance or leader fencing before horizontal scaling. Keep historical learning metrics separately by source time and venue. Measure p50/p95/p99 end-to-end latency and reconnection/gap rates *on the deployed server*, never infer "best speed" from feed labels.
- Additional work to reach institutional-grade measured parity: durable event-time snapshots at the actual predecision instant (not just API status), book-clock quarantine during exchange maintenance, signed IOC 0/partial/full outcomes with account/fee/cash reconciliation, CF BRTI settlement outcome and out-of-sample calibrated EV; risk-governed promotion only after statistically significant advantage against unchanged V1.3.

## Source contracts independently checked 2026-10-22

https://docs.kalshi.com/websockets/orderbook-updates
https://docs.kalshi.com/websockets/cfbenchmarks-value
https://docs.kalshi.com/websockets/cfbenchmarks-value-5hz
https://docs.cdp.coinbase.com/exchange/websocket-feed/overview
https://docs.cdp.coinbase.com/exchange/websocket-feed/channels

**Status**: Source PR merges/CI establish code-readiness only. Railway authenticated workspace returned zero accessible projects, so deployment, actual 1Hz/5Hz/WS entitlement, latency coverage, fee and exit qualifications remain UNVERIFIED.
