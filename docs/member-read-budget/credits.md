# Hybrid variant notice

This checkout implements the fresh-binding alternative described in [hybrid.md](hybrid.md). The quota mathematics below remain applicable; the original batch-time credential observation tradeoff below describes the comparison prototype, NOT this hybrid's per-page binding behavior. Every first page in this tree performs a fresh current binding query.

# Isolated 500ms bounded initial-history credits

This prototype is not deployed and does not modify the frozen per-request baseline. The shared Read bucket is uniformly reduced to750 tokens, refill300/s. Every charged supported GET and Read-cost mutation receives a process-local opaque one-use dispatch ticket. A monotonic clock captured BEFORE its successful debit query bounds actual dispatch to500ms after that point, including DB response latency, signing, other awaits and scheduling. Ticket validation/consumption occurs synchronously at fetch invocation after signing. No refund is issued for stale, canceled, failed, or unused tickets.

For the bounded owned snapshot only, after independently validated balance, atomically debit60 tokens for the six fixed history first-page paths. The scan-local ALS context binds fingerprint, production host, exact pair/query strings and invocation lifetime. Each first page consumes its own credit once. Modified query/host/credential, reused credit, closed invocation or expired ticket refuses without fallback. Later pages use ordinary fresh per-request debit. Balance retains its separate existing quota and a distinct binding-only ticket, not charged Read credit. No ticket is trade authorization, and existing per-read control checks and final transaction/wire guards remain.

A failed debit grants nothing. One local bounded admission wait uses the full-cost deficit upper bound at300/s plus10ms, capped250ms, then one recheck. A successful recheck starts only the quota ticket clock immediately before that query. The original snapshot/source observation time NEVER resets. A cold60-token batch therefore waits about210ms, rather than racing six group reservations for initial credit. Other users of the budget may still cause refusal.

## Bound and assumptions

For a send interval of lengthT seconds, each send's debit occurred in the preceding extended interval of at mostT+0.5 seconds. Thus charged sends ≤750+300(T+0.5)=900+300T, provided the shared refill clock progresses at no more than the assumed real-time rate and all charged sends obey the500ms deadline. Database clock forward steps can violate this assumption; production rollout requires explicit clock discipline/acceptance or separate fail-closed clock-anomaly protection. This is a local spending bound, NOT measured provider remaining tokens; external clients still consume capacity.

Old900-cap workers and any worker that lacks ticket dispatch checks must be excluded before rollout. All replicas must share the same database bucket. Existing tokens must be clamped to750, never reinitialized to750. Schema stays unapplied until independently reviewed deployment.

## Observation timing change

Initial-history quota identity/revocation observation occurs once at batch admission and may precede an individual first-page dispatch by at most500ms. That is a deliberate change from per-request quota-identity observation, not claimed equivalent freshness. Required application authorization/STOP/lease/read checks and source expiration are unchanged. The parent must accept this timing tradeoff before any production enablement.
