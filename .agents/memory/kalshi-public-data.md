---
name: Kalshi public market data
description: Browser CORS behavior and the safe read-only access pattern for Kalshi market data.
---

Kalshi’s public market-data REST endpoint does not provide browser CORS headers in this environment, so read-only REST requests must go through the app’s server-side proxy. Coinbase’s public BTC-USD WebSocket can be consumed directly in the browser.

**Why:** Direct browser requests failed with a CORS error even though the endpoint was unauthenticated and returned valid data when called server-side.

**How to apply:** Keep the Kalshi proxy read-only and unauthenticated; do not add credentials, order routes, or execution behavior to make market data work.