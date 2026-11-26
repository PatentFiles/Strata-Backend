# Market lifecycle compatibility and bounded history export

## Scope
The live market fee validator accepts current Kalshi market responses without the
legacy `expiration_time` field. `latest_expiration_time` stays required and valid;
provided optional timestamps must remain valid and no earlier than close. Known
fee changes remain excluded through the maximum supplied lifecycle timestamp.
Account scope, fees, freshness, orders, risk and crossing consumption are unchanged.
Reference: https://docs.kalshi.com/api-reference/market/get-market

A qualified crossing that was consumed previously is NOT reset or replayed by this
release. Future valid fresh opportunities must independently pass every entry gate.
A successful metadata read is not a trade or a guarantee of fills/profit.

## Read-only export
`GET /api/strata/live-history/export-batch` uses the existing authenticated owner
boundary. All-account scope rechecks the actor's ADMIN database role every batch.
At most 1,000 rows/identities are processed per read-only transaction, with four-
second statement and 500ms lock deadlines. At most two export requests run per
API process, one per owner. No request queue or permanent DB snapshot is held.

There is no aggregate row limit or 90-day export limit. An export uses fixed date
filters, a recording watermark for append-only decisions, and keyset cursors bound
to the actor/filters. Decisions come first (newest first), then ledger records
(newest first). Ledger values can advance between batches; this is not an atomic
account snapshot. Filtered empty ledger batches still advance their cursor.
CSV consumers must retain account/record identities and must not count decision
and ledger evidence as duplicate trades. Original details and nulls are preserved.

Before large production exports, inspect and apply the online indexes in
`live-history-export-indexes.sql` one statement at a time outside a transaction.
The decision journal's owner/account/time indexes already come from migration 0050.
Validate index definitions and validity; never infer success from IF NOT EXISTS.
Rollback is application rollback plus retention of these additive indexes; no
financial rows, approvals or historical observations should be deleted.

## Deployment boundary
No SQL applies on startup. No ARM, START, KILL, consent, strategy or stake change is
part of this implementation. Deploy a qualified backend in a controlled stopped,
flat state; exact-build account authorization remains the owner's explicit action.
The new frontend export requires this endpoint. Missing backend support must show
an error, not silently fall back to a capped or partial historical export.