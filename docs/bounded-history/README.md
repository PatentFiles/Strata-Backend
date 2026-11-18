# Bounded history reads: isolated default-off experiment

`readOwnedKalshiFeeds` keeps legacy serial reads when its fourth argument is absent.
The server-only `{mode:"bounded_history_reads_v1", signal?}` option enables a process-local
snapshot lane capped at two active operations globally and per SHA256(key ID).
Balance remains first, using the existing quota/credential/transport path. Only after
balance scope and exact cash validation do six history groups enter the lane. Each
group holds its slot through serial pagination; all existing page caps, cursor,
merge/conflict, identity and completeness rules still apply. Observation time is
never renewed at completion. No supervisor activation or environment flag is added.

The first observed hard error latches failure, aborts admitted siblings and cancels
queued groups. Already admitted siblings may have sent before that error. There
is no retry. Every admitted operation must settle before the scan returns. An
abort-ignoring request retains its slot and keeps the failed scan pending indefinitely;
15 seconds requests cancellation, not fabricated completion or authority. No SQL,
order, ledger write or activation operation is introduced by the scheduler.

## Quota limitation and deployment blocker

This is a concurrency cap, **not** an account-wide request-rate budget. Other callers,
serial-mode scans and replicas are not counted. Current authenticated account limits
and endpoint costs were not established by this work; no live provider probe ran.
Keep this mode disabled until quota evidence and full-path review are completed.

Kalshi's official [rate-limit documentation](https://docs.kalshi.com/getting_started/rate_limits)
uses token buckets, with most calls costing ten tokens and separate balance limits.
It identifies `/account/endpoint_costs` as authoritative for non-default costs.
[Account API limits](https://docs.kalshi.com/api-reference/account/get-account-api-limits)
reports the authenticated tier and budgets. Those facts do not establish this
account's available headroom or concurrent usage. Existing local429 suppression
and balance reservation remain unchanged, even though the provider's own bucket
continues refilling after429.

## Verification scope

The unit suite uses synthetic transports, including actual RSA signing and the real
GET client. It checks every history group's first/later failure, pagination bounds,
external cancellation, abort-ignoring drainage, queued cancellation, concurrent
credential aliases/accounts, original clocks, and cooldown preservation. These are
not venue latency, quota, fill, or production authorization proofs.
