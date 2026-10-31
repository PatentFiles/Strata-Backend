# Owner-bound lifecycle shadow transport (offline qualification only)

This module is **unwired, shadow-only, and has no execution authority**. No environment variables, credential loader, database, execution modules, flags, or boot hooks are imported. Import/constructor do not connect. Tests use fake sockets/signatures or ephemeral localhost servers and ephemeral generated RSA keys. No Kalshi handshake has been attempted or verified.

## Files / running

- `lifecycle-shadow-transport.mjs`: explicit-start dependency-injected transport and RSA-PSS signer helper.
- `lifecycle-shadow-transport.test.mjs`: fake clock/socket/signature tests and a pure reducer bridge.
- `native-header.test.mjs`: Node v24.22.1 localhost custom-header forwarding and redirect-refusal tests.
- `lifecycle-strike.mjs`: canonical separately reviewed reducer, integrated alongside the transport.

Run `node --test *.test.mjs` from `research/lifecycle-shadow-20261031/` (132 passing tests: 38 offline transport/header, 58 reducer, and 36 typed-runtime transport parity). No packages added. All modules remain outside production imports/build entry points.

## Contract and bounds

`LifecycleShadowTransport` requires exact `{ownerId, accountId, credentialBinding}` (binding is a 64-character lowercase hex digest), a signer with matching immutable scope, injected socket factory, and synchronous `isAuthorized(scope)` revocation predicate. Only `wss://api.elections.kalshi.com/trade-api/ws/v2` is permitted; only one fixed `market_lifecycle_v2` subscribe command is sent per connection. The signer uses SHA256/RSA-PSS (salt32), `${timestamp}GET/trade-api/ws/v2`, and an already-loaded RSA private KeyObject of at least2048 bits. No private key or provider message is logged.

Observer methods are **synchronous**: `onSubscribed({scope,generation,sid,receivedAtMs})`, `onEnvelope({generation,sid,receivedAtMs,raw})`, `onInvalidated({generation,reason,receivedAtMs})`. A thrown error or Promise-returning observer stops the run. Do not perform asynchronous DB/queue work in observers. Every same-sid lifecycle message is forwarded before local ticker filtering; the reducer owns sequence and strike validation. Subscription ack supplies sid only, never a replay/sequence baseline, credential authorization proof, or account-index proof.

Maximum six connection attempts, exponential1s..30s backoff plus0..25% jitter, external provider cooldown respected, finite15min default/30min maximum session,10s handshake/ack timeout,1s authorization watchdog while signing/connected. Cooldown has no socket; authorization is checked again before signing. Explicit stop is immediate. Pending sign completions and stale socket events are generation-fenced. Clock regression or invalid time fails closed. Diagnostics are fixed reasons, no bodies/headers/IDs, at most12 events. Frame cap defaults16KiB, per-second frame count defaults1000 and caps2000; only strings accepted. Limits include ack frames.

**Native WebSocket limitation:** the byte cap rejects data after receipt; Node native API does not expose a configurable preallocation maxPayload here. This is NOT a proven wire-level memory/backpressure cap. Synchronous callbacks prevent adapter queue growth but cannot constrain arbitrary injected callback allocations or blocking. A production transport needing hard wire-level frame limits must independently qualify a bounded implementation before enabling. Errors are sanitized; HTTP429/Retry-After is not exposed by this native WebSocket API, so provider-specific cooldown must come from a trusted external bounded read-budget source. Missing information must not be called healthy.

## Future owner-loader integration contract (not implemented)

1. Resolve commissioned production account from verified records, not account display name/legacy/global INDEX2 variables.
2. Load the existing account-bound restricted credential through the reviewed owner loader; bind ownerId/accountId/key fingerprint exactly. Verify active credential, owner/account relation, subaccount/exchange-index mapping and existing permission. Current KXBTC15M scope uses independently verified index2, not a docs example.
3. Supply a revocation predicate tied to that same binding; no silent global fallback, different credential, or scope broadening. Revoke/cancel closes shadow transport and invalidates metadata.
4. Independently establish production subscription sequence baseline/resync semantics. **Do not infer nextSequence from ack or first frame merely to make tests pass.** Fixture `authenticated:true`, `scopeVerified:true`, and seeded sequence are test assertions, not proof of provider capability.
5. Bridge every frame to reducer `ingest` before market filtering. Reconnect/gap/silence invalidates trust until bounded verified resync. Do not synthesize heartbeat from connection-open or local timer. Do not renew executable quote timestamp from metadata; preserve five-second quote freshness.
6. Shadow results must never feed entry selection, production tables, quotes, orders, or approvals. Any later promotion requires independent review and controlled release process.

## Remaining real-production capability test

Under separately reviewed deployment/qualification authority, prove the *same existing owner-bound restricted credential* opens only the fixed lifecycle stream; capture sanitized ack sid and actual envelopes, verified account/index/window binding, exact documented sequence baseline/resync behavior, provider timestamps/receipt latency, strike publication around rollover, reconnect gap invalidation, revocation, cooldown and bounded memory behavior. Compare push vs existing authenticated REST reads and five-second executable quote freshness using shadow-only observations. Do not broaden credentials if access fails. A successful local header test or fake subscription ack does not establish Kalshi entitlement, sequence replay, successful production strike capture, real order placement, fill probability, or profitability.
