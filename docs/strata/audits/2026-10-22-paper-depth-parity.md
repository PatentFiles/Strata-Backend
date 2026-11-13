# Issue #134 — market-depth and realized net parity evidence (2026-10-22)

**Research only. No trading authorization and no extrapolation of paper P&L to live profit.**

## Implemented (PR #142 candidate)
- Public Kalshi REST `GET /markets/{ticker}/orderbook`, from canonical origin, no credentials or trading endpoints.
- Fail-closed fixed-point validation for both YES and NO bid price ladders (1/10000 USD ticks) and contract sizes (1/100).
- Opposite bids converted to side-specific asks at `1-price`. Strict price-limit, whole-contract capacity walks report modeled fill, unfilled residual, gross dollars, VWAP (rounded) and depth levels.
- After a *committed* paper entry or quote-close, request book evidence once, bound by market ticker and unique paper position ID + phase. Store event timestamp and local network start/receive timestamps; preserve the exact bid ladders, immutable status `CAPTURED|UNAVAILABLE`, and deterministic capacity at the paper limit. Never update historical positions or the C52/C53 champion.
- Additive `public.forward_test_book_snapshots` with RLS enabled, no policies, no browser roles; query bounded research coverage by engine ID. A missing migration is explicitly `SCHEMA_OR_DATABASE_UNAVAILABLE`, never inferred zero depth.
- Tests: opposite bid/ask complement, level ordering, fractional quantity rounding, price-limit crossing, partial/zero capacity, invalid input, isolated worker receipt and duplicate prevention.

## Critical provenance warning
REST **does not** give an exchange-generated snapshot timestamp, sequence, clock, or atomicity with a decision. These are **post-action** observations, collected after the paper trade commits. They can measure nearby displayed liquidity but CANNOT validate what was available at the decision instant, nor prove a fill. Market depth can disappear before IOC execution. Never label these `executable` or `actual fill`.

## What still must be built and proven to close #134
1. Independently reviewed authenticated Kalshi WebSocket `orderbook_snapshot` + `orderbook_delta` collector with monotonic per-subscription sequence checking, exchange clock, reconnect/reset/gap quarantine, and timestamp freshness fence. Bind the **predecision** reconstructed book to immutable signals, not a later REST call. Only accept ordered event-time observations, never last-write-wins on a gap or a different market.
2. Store account-specific, authenticated Kalshi order IDs, maker/taker fill receipts, exact effective fee models and actual cash debit/credit; deduplicate and reconcile zero/partial/full IOC and UNKNOWN recovery. Do not infer hidden liquidity/queue/latency from aggregate displayed size.
3. Compare producer Coinbase spot signal against the authenticated CF Benchmarks BRTI minute-average reference, matched market/close time, and official venue settlements. An index frame is not itself settlement proof.
4. Produce paired per-signal aggregates: quote gross; observed pretrade book conservative capacity (with fill probability and latency stress); authorized fee-model net; verified realized/settled live net; unmatched/cancelled/error rate; largest-winner contribution; out-of-sample drift, clustered variance and worst-case loss. Each numeric series requires provenance/coverage denominators.
5. Human risk review of a controlled $5 pilot only after issue #46 signed exit qualification, owner/SHA fees/cash and Railway exact deployment approval. Never auto-authorize orders from research or edit historic P&L.

**Go/no-go:** Code + CI is a development gate. No live calibration or exchange-verified net P&L exists until signed fills, fees, cash, and settlements are independently reconciled. Keep #134 open.
