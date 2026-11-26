# Orders-off market-data proof, staging only

This one-shot runner accepts one public-channel authenticated WebSocket
handshake and one exact KXBTC15M ticker. It does not load an order client,
account database, secret from environment, or production configuration.
It uses the locked ws package: fixed TLS endpoint, ordinary certificate
validation, no redirects or compression, bounded queues and one send.
The only bundled executable remains inert and exits without networking
until a separately reviewed integration supplies an approved signer.
A scope marker returned by a signer is a software contract, not venue ACL
evidence. Do not copy a production trading key or put secrets into this package.

The runner requires a snapshot plus the next contiguous delta, ages both
at receipt, and reports venue send time, actual delta event time and local
receive time distinctly. Entry asks are derived from the opposite side's bids.
Exit bids are the literal bids for the same side, on the same sequence.
Liquidity is displayed depth, not executed or guaranteed size. A snapshot's
send time is not the age of every resting order. This output is not a held
exit, a fill, owner approval, or fee/rounding evidence.

Local review (Node 24, OpenSSL for the loopback fixture):
    npm ci --ignore-scripts --no-audit --no-fund
    npm test
    node runtime.mjs
The last command must print READ_ONLY_SIGNER_UNAVAILABLE and ordersEnabled:false.

Hosted review, after approved signer custody is available:
1. Review an exact dedicated runner revision and container image digest. The
   Dockerfile is prepared; its build and digest have not been verified here.
   Use a dedicated private one-shot service with no domains, production
   credentials, account database, shared variables or live control access.
2. Review the provider entry point that calls run() with a dedicated
   exchange-verified read-only signing capability; test that missing or
   unapproved credentials make no connection. This integration is not bundled.
3. Run the exact build against a fresh ticker and retain its deployment/build
   identifier, feed sequence, venue and receipt timestamps, and same-sequence
   depth. Do not substitute an anonymous REST response or an old snapshot.
4. Replay the captured depth through the fixed stake ladder in the exact
   paired orders-off build, with independently approved fee/rounding evidence.
   Review before any production rollout; keep Brit's work separate.

Protocol: https://docs.kalshi.com/websockets/orderbook-updates and
https://docs.kalshi.com/websockets/websocket-connection.
