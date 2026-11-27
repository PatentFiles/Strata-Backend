# Strata live-history scale, bot provenance and evidence coverage

This staged change is an **analytics-only** release. It must not change the V13/C52/C53 or Warren Buffett entry logic, release gates, order submissions, existing monetary records, or worker lifecycle.

## Historical bot identity

The existing `strategy_version` and champion parameter hash are not reliable bot selectors: both were present on some Warren observations. Never backfill an old observation with the account's *current* bot. New live observations record the bot selected in the worker-bound source and its fixed parameter hash in the immutable, allowlisted `facts` object.

History/export projections report `bot_id`, `bot_name`, and `bot_source` as read-only fields. Preferred source is the original observation or immutable ledger-intent source. Legacy Warren-specific reason codes or timestamped owner selection history can be used only as **inference**, explicitly labeled. Missing or conflicting evidence remains unattributed. Financial ledger results must never be duplicated by any inferred evaluation.

## Export design and hard limits

`/api/strata/live-history/export-batch` remains protected with AAL2 and owner-account-scoped keyset cursors, fixed cutoff, 1,000 scanned records per request and idempotent read-only pagination. New desktop Chrome/Edge folder mode writes up to one million logical CSV records per file. It closes each part, verifies its byte length, then saves a manifest/continuation checkpoint. Reopen the same folder with Resume CSV folder to continue at the last committed cursor; partial uncommitted data are discarded, and the API authenticates every subsequent batch. The existing single-file CSV/JSON exports remain available.

**Not guaranteed:** a single atomic database snapshot across all export batches; exact file reconstruction after arbitrary external modification of a part with the same byte size; infinite storage, auth lifetime, disk space, network availability or a practical 100-million-row browser session. CSV column/row capacity in importing programs is independent of how many records the exporter can create. For hundreds of millions of records use server-side immutable object storage and an asynchronous, resumable export job.

## Crucial capture limitation

This system's current `BoundedAnalyticsQueue` is process-memory only (capacity 256; maximum three attempts by default). It may drop observations on overflow, exhausted retries, process crashes or an extended database outage. Recording coverage explicitly remains `complete:false`. Neither this code change nor CSV folder mode changes that fact. Therefore do not claim every signal was saved or that missing observations imply no activity.

A separate **future** qualified implementation needs a crash-durable telemetry outbox, idempotent acknowledgments, accounting-independent ingestion workers, durable object-store archival by time/account/bot, retention/backup rules, capture-gap counters and alerts, owner isolation and a tested replay/recovery process. Avoid loading every row into the trading worker; keep order latency and account reconciliation authoritative. Deploy archival changes independently with rollback, load tests, and verified restoration.

## Research comparison

Measure separately by recorded bot, exact version/parameter fingerprint, release, account, date, market regime and stake: evaluation count, qualified signals, protective passes and errors, confirmed submitted order count, fills/partial fills, slippage vs observed market and latency, direct transaction fees and all-in net realized P&L, drawdown, exposure, and capture completeness. A PASS is not a winning trade. Do not interpret a high hit rate or frequent entries as positive expectancy. Test with distinct nonoverlapping live periods and out-of-sample holdouts, taking regime changes and fee/risk limits into account. Preserve original risk controls and never promise profits.

## Release sequencing

While an owner's live worker is running, do not merge/deploy backend changes automatically. Test both branches on disposable PostgreSQL and local frontend, qualify GitHub PR gates, and coordinate rollout to a stopped worker. Verify database read permissions, frontend version manifest, exact Railway SHA/feature pins, and the absence of any new P&L/account mutations. No production migration is required for the read-only projection.
