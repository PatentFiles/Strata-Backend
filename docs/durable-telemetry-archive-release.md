# Strata Durable Telemetry and Immutable Archive — Staged Release

Status: implemented locally and tested with a disposable PostgreSQL database and a mocked S3 Object Lock service. NOT deployed. Production archive is OFF.

## Architecture

The existing journal remains the first durable persistence point. A PostgreSQL AFTER INSERT trigger inserts an idempotent outbox pointer inside the same commit as the observation. On database rollback, both disappear. No order, position, strategy, risk, fees, or balance records are written by the archive service.

A separate archive worker with the dedicated NOLOGIN/least-privilege PostgreSQL role strata_telemetry_archiver and no Kalshi credential uses scoped leases. It reads only committed journal rows, canonicalizes and gzips a fixed set of event records, uploads a versioned object using S3 If-None-Match and COMPLIANCE Object Lock retention, verifies SHA-256 and metadata via HEAD, restores bytes with GET, validates the exact owner and event identities, and finally acknowledges only the original leased batch under the current fencing token.

A lost upload response is safe to retry: the object key and SHA are stable across reclaims, and no overwrite is permitted. Failed verification leaves rows queued and flags a retry. Capture health uses a separate one-connection heartbeat and reports overflow, retries, missing journal pointers, queue backlog, and UNKNOWN monitoring coverage when no heartbeat is available.

Research metrics group only recorded bot identity and distinguish verified closed-trade net P&L after fees, realized closed-trade drawdown, fill slippage and qualified-but-not-submitted signals. They do not equate a PASS with a win or compute theoretical profits for missing fills.

## Real limitations

1. Queue durability begins AFTER the existing journal INSERT. The existing in-memory bounded analytics buffer can lose events before the INSERT on crashes or prolonged outages; this change does NOT guarantee every incoming observation is captured. That requires a separate crash-durable ingestion lane without slowing the trading hot path.
2. All S3 storage tests are mocked. An actual AWS Object Lock bucket and restricted IAM credentials are not yet connected. Therefore this release is NOT a tested production cloud backup until a real bucket passes put/version/retention/restore verification.
3. Do not claim zero latency. Archive work runs separately; eligibility and signed market-data freshness remain unchanged.
4. An archive deployment must never start trading, submit exchange orders, mutate ledger balances, or clear leases.

## Production prerequisites (DO NOT AUTOSKIP)

- Finish all local and GitHub safety checks at exact PR head and audit RLS, trigger lock impact, storage costs, and retention/legal deletion requirements.
- Provision a NEW private S3 bucket with versioning and Object Lock COMPLIANCE mode enabled at creation, encryption, restrictive IAM, owner-prefix isolation, and at least 365 days retention.
- Provision a dedicated PostgreSQL role credential for the archive worker, with no access to account mutations, vault secrets, or exchange POST APIs.
- Apply reviewed migration 20261127230000_durable_live_telemetry_archive.sql during a safe maintenance window after verifying no customer has live exposure.
- Deploy a separate Railway service starting dist/telemetryArchiveWorkerMain.mjs, not the trading API.
- The archiver requires NODE_ENV=production, STRATA_TELEMETRY_ARCHIVER_SERVICE=ARCHIVER_ONLY, STRATA_ARCHIVE_DATABASE_URL, STRATA_TELEMETRY_S3_BUCKET, STRATA_TELEMETRY_S3_REGION, STRATA_TELEMETRY_RETENTION_DAYS=365, and restricted AWS signing credentials. Keep STRATA_TELEMETRY_ARCHIVE_ENABLED unset until qualified.
- After an actual storage read/write/restore succeeds, enable archiver explicitly. Enable the API's optional STRATA_TELEMETRY_HEARTBEAT_ENABLED only after it is separately qualified. Backfill from existing journal is bounded and requires STRATA_ARCHIVE_BACKFILL_APPROVED=true.
- Test a random archived batch restore, compare hash, scope, version and rows, and verify S3 retention prevents deletion/overwrites. Alert on backlog >300 seconds, stale leases, capture UNKNOWN, missing rows and repeated retries.

## Tests and rollback

Native disposable PostgreSQL suite: 7/7, covering atomic insert/rollback, cross-owner boundaries, stable object identity, lost acknowledgment, corruption refusal, lease reclaim and health-gaps.
Mocked S3: 4/4, covering compliance preflight, immutable put + version/readback, tamper rejection and read-only bot metrics.
TypeScript: passed. Production backend build: passed (archive worker entry point is independently compiled).
No production SQL, S3 or trading worker changes made in this staging worktree.

Rollback: disable the standalone archiver, leave committed journal and immutable archive objects intact, preserve queue/manifest state for future replay. Never truncate monetary or telemetry evidence merely to unblock a strategy switch.
