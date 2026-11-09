# Storage and retention review

Reviewed 2026-11-09 against main 29239e42fcdb1bf5b0223b0ae421b0cfea5705b5.
Public /api/healthz independently reported the same deployedGitSha; embedded
release revision/tree remained unavailable and dirty=true, so this is reported
runtime SHA, not full reproducible-build attestation.

## Confirmed findings

- Producer cadence is 5 seconds. Every successful cycle inserts a
  forward_test_evaluations row: nominally 17,280/day (518,400/30 days), before
  pauses, feed failures, or processing delay. No historic expiry was found.
- forward_test_btc_points already expires samples older than 120 seconds for
  the active engine. This is strategy restart state, not a historical archive.
- Shadow research already skips unchanged quiet PASS/WATCH classifications.
  First observations, market changes, classification changes, crossings,
  qualifying opportunities and non-quiet signals remain. Failed persistence
  does not advance capture state. Restart/eviction emits extra evidence safely.
- Book snapshots are event-based ENTRY/EXIT receipts, not every-tick dumps.
- STRATA_SHADOW_EVALUATION_WRITES_ENABLED=false can pause optional shadow
  recording and autonomous learning; it does NOT stop baseline writes or free
  existing storage. It is an operational change, not applied by this review.
- Two catalog-only production SQL reads timed out connecting. Largest tables,
  growth rate, database capacity and any live cron retention are UNVERIFIED.
  Supabase health advisor returned no lints; that does not establish capacity.

Sources: forwardTestWorker.ts, shadowEventCapture.ts, v13StrategyResearch.ts,
forwardTestBookCapture.ts, v13AutonomousShadowLearning.ts in api-server/src/lib.

## Protect without exception in initial rollout

Keep all live intents, orders, fills, positions, settlement/accounting records,
UNKNOWN reconciliation, reservations, consent/authorization records, immutable
execution traces, security audits, paper position outcomes and entry/exit book
receipts. Keep each referenced source evaluation plus its required context.
References also occur in micro_live_orders, micro_live_decisions,
live_proposed_orders, v13_strategy_shadow_evaluations, micro-live evaluation
source links and book receipt JSON; absence of a foreign key is NOT proof that
an evaluation is unused. Do not disable append-only protections.

## Safe reduced-write and retention path

1. Measure first using docs/operations/storage-inventory-readonly.sql when responsive.
   Catalog estimates are approximate, omit un-analyzed new growth, and are not
   exact allocated bytes. Compare counters only across the same stats-reset
   interval. No COUNT(*) or content scan is needed to rank initial candidates.
2. Keep existing event filtering for optional shadow research. If immediate
   relief is needed, approve a temporary pause of that optional lane rather
   than removing live safety evidence. This sacrifices prospective research
   coverage, which must remain explicit.
3. Separate the baseline live signal/provenance path from optional historical
   research before sampling baseline writes. Current replay explicitly consumes
   complete streams; deleting PASS/WATCH rows changes velocity/crossing history
   and can bias results. A reduced stream must NEVER be labeled complete.
4. Propose a bounded hot-history window (for example 30 days) for redundant,
   unreferenced research only. This duration is a proposal, not an approved
   retention policy. The learning job uses 30 days of completed paper outcomes,
   which are preserved; the separate historical replay accepts arbitrary dates.
5. Before expiry, archive complete old market windows with verified record
   counts/digests and a coverage manifest, then test restoration and replay.
   Approved storage destination and archive retention are required. If archival
   is unwanted, explicitly shorten replay support and reject out-of-coverage
   requests rather than silently returning partial results.
6. Produce a dry-run candidate manifest with all text/JSON reference exclusions,
   unresolved-market holds and safety holds. Independently review it. Only
   after specific deletion approval use small indexed batches with strict
   time/lock limits, pause on database stress, and log each approved batch.
   No TRUNCATE, CASCADE, VACUUM FULL, or global age-only cleanup.

No production data, settings, schedules, or trading gates were changed. There is
no executable deletion in this change. A new write sampler is intentionally
not enabled without the dependency and coverage contract above.

## Implemented optional analytics maintenance gate (not deployed)

Set STRATA_PAPER_ANALYTICS_PAUSED=true to refuse new paper status/history reads
before any cache or database query. Default/unset/false retains current behavior.
Both legacy and modern authenticated endpoints return HTTP 503 with an explicit
maintenance message and Cache-Control: no-store. No synthetic zero statistics
are returned. Shared read implementations also enforce the guard.

This switch does not stop the producer, reconciliation, live controls,
settlement-reference diagnostics, book receipts, or existing in-flight queries.
It does not free disk space. A Railway variable rollout may restart the service;
review deployment/restart safety before changing it. Set false/unset to reverse.
The existing shadow flag remains separate and already suppresses adaptive-shadow
ranking scans when false. Actual deployed shadow flag value is unverified:
Railway connector discovery returned no accessible projects.

Tests cover exact opt-in, zero DB reads while paused, explicit legacy/modern
503s, preserved authentication, functioning injected live-state/emergency-stop
handlers, and restoration after unpause. Added to test:db-resilience.

## Actual paper/live separation

A separate schema or extra connection pool inside the existing database does
not isolate storage/CPU/IO. A second pool may actually increase total connections.
A separate API process alone still shares the database bottleneck.

A full split needs a separate research database/resource, plus a minimal durable
live signal/provenance boundary. The current producer's paper evaluations feed
live entry decisions, and live intents have source-evaluation references. Do not
change DATABASE_URL or move/drop those tables directly. Stage a new immutable
signal envelope containing evaluation ID, parameter/policy identity, source
freshness, quote/evidence digests, crossing identity and sufficient decision
inputs. Preserve the exact records referenced by live outcomes in the live store.
Use an idempotent bounded outbox for optional research delivery with explicit
coverage gaps; research failure must not block protective live reconciliation.
Cross-database failure/retry tests and exact-SHA safety qualification are required
before switching consumers. Keep paper execution's crossing/admission semantics
unchanged; this is workload isolation, not a strategy rewrite.

Immediate physical headroom options are provider storage/compute capacity
expansion (price and restart implications must be checked) or a verified archive
and specifically approved purge. Neither has been performed. Query shedding is
the quickest reversible mitigation available in code, not proof of a disk fix.

Authentication remains ahead of maintenance checks. Modern Supabase authentication
may still read the user profile before the guard; only the optional analytics
queries are suppressed. This is intentional and does not bypass authorization.
