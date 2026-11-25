# Live decision history (candidate)
 
Additive SQL: `lib/db/drizzle/0050_strata_live_decision_history.sql`.
Apply only after native PG16/17 qualification and review of the actual database.
The append-only private table is not an execution capability. It is inaccessible
to browser roles, and the backend read route resolves account scope from the
authenticated AAL2 subject and current profile. All-account reads require ADMIN.
 
The producer uses a bounded asynchronous batch with a single in-flight writer.
It does not await analytics in the entry path or request extra market data.
Delivery failures produce `strata_live_analytics_delivery_gap` logs; there is
no claim of complete historical capture across restarts or unavailable storage.
The explicit flag `STRATA_LIVE_DECISION_ANALYTICS_ENABLED=true` enables recording
only in the qualified production deployment after migration. The read route
returns 503 rather than pretending empty history if storage is unavailable.
 
The endpoint `GET /api/strata/live-history` provides account-filtered, bounded
date-range history, stable cursor pagination, exact decimal money strings,
separate observation and ledger rows and a filtered summary. No paper PASS
backfill. Historical retained intents with missing fields remain incomplete.
Net P&L in summaries is recorded realized event P&L, not inferred quote profit.
 
Do not change production flags or deploy while any account is trading.
