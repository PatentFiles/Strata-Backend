# Audit remediation candidate — 25 November 2026

This change builds on merged PR #375 (`e7e4f9f4f1e94f786d597c6f97a7269e0762cc88`). It preserves the standalone paper boundary, independent live source, immutable C52/C53 parameters, source ages, duplicate prevention, financial records, owner consent and protective order checks. It does not authorize or start trading.

## Implemented boundaries

- **F01/F02/F03:** retain the existing lifecycle-compatible market validation, history indexes and PR #375 fee-multiplier normalization. These are inherited repairs, not new fixes claimed by this candidate.
- **F04:** screen and streamed export accept the same authenticated `recordType` filter. Trades/performance use owner-scoped ledger records; the frontend keeps one mounted owner/account/date selection across supported tabs. Legacy global records remain separately labelled and privileged.
- **F05:** bounded nonblocking delivery retries the same immutable row identities, verifies exact persisted payloads after uncertain commits, counts overflow/exhausted retries, and correlates rejection context without refreshing source evidence. It remains best-effort across process crashes, not exactly-once or guaranteed complete telemetry.
- **F06:** backend and frontend embed a normalized source-content digest, available Git/provider revision and explicit provenance. Frontend publication emits asset digests and has a verification script. These identities are not signed attestations and grant no execution authority.
- **F07:** the new migration defines a non-login API service group with a fixed application-object inventory, no ownership, CREATE ROLE/DB, replication, RLS bypass or financial-history DELETE/TRUNCATE permission. Identity/role registries are read-only. A separate login must inherit only that group. The trusted API necessarily has cross-tenant application access; this is not a claim of per-customer database authentication. Existing application ownership checks remain mandatory. The peer's separate paper-role manifest remains authoritative for paper.
- **F08:** remote database connections verify certificate trust and hostname; unsupported insecure URL overrides fail closed. Local disposable databases remain supported. Supabase's official CA must be configured before deploying this code against the observed pooler.
- **F09:** an always-emitted backend release gate requires all applicable static/native jobs, while narrative-only documentation skips expensive tests without leaving a required check pending. Repository protection must require that gate; workflow code alone is not enforcement.
- **R03/R07:** shutdown closes new work, waits for workers/HTTP and bounded telemetry before closing the pool. Existing exposure is not declared flat or forcibly released. History/export concurrency is bounded so reads cannot occupy the whole financial pool.

## Native qualification

Use the existing canonical disposable PostgreSQL runner and the frontend's real HTTP + native PostgreSQL browser fixture. External provider transport is isolated. The frontend fixture creates two ordinary customers and runs application code through a distinct restricted login; its separate bootstrap connection is used only for synthetic identity/fixture setup. Negative checks cover role escalation, DDL, financial truncation/mutation, role-registry writes and raw Vault-table reads.

Hosted Supabase's managed Auth schema is not re-owned, modified or granted to the runtime. `private.strata_runtime_auth_user_v1` exposes only ID, email, confirmation and ban state through an intentional owner-rights view. A read-only trigger refuses every actual identity mutation; minimal column grants admit the existing row locks. `STRATA_RESTRICTED_RUNTIME_AUTH=true` explicitly selects this bridge in code-owned SQL without changing predicates, parameters or lock clauses. Three existing invoker-rights fee guards use the same bridge; their original definition digests prevent overwriting a concurrently changed guard. No new security-definer function, browser grant, password/hash exposure or reserved-role membership is introduced.

The synthetic Vault `create_secret` fixture mirrors the production function's observed security-definer boundary; no production Vault function is changed. Native tests do not exercise Supabase's actual encryption implementation. Local Linux/Docker execution is required for Unix-socket-only groups; do not remove those checks or weaken their destination guards to run them on Windows.

## Release ordering

1. Re-read repository heads, peer PRs, Railway source and staged changes. Do not overwrite another agent's pending release or merge unrelated work.
2. Qualify exact source, compatible frontend backend pin, native PostgreSQL/browser checks and release gates. Record actual results in the PR; this document is not a test-pass assertion.
3. Inspect current worker/exposure/intent state. Do not deploy through active exposure or silently STOP/KILL/clear account holds. Do not change owner consent or strategy settings.
4. Apply only the reviewed role migration, under bounded lock/statement deadlines. Verify the production inventory against the explicit allowlist first. Provision independently random API and paper login secrets through a secure administrative path; never commit or print them.
5. Validate each proposed login with read-only queries, TLS identity verification, role/membership/privilege assertions and the actual database destination. Paper must have no live, private, Auth or Vault access. Do not configure an unqualified login.
6. Configure the official CA and qualified runtime URL before starting the new backend. Preserve existing values not part of this release. Configure the separate paper service using only its restricted URL and approved paper flags; do not copy API credentials or live signing variables into it.
7. Deploy the exact qualified backend, verify health/build identity and independent paper/runtime status, then publish and verify the compatible frontend's content/asset identities. Platform release SHA qualification is distinct from owner financial consent. Do not rotate consent records by SQL.
8. The owner deliberately reviews any genuinely changed exact-release authorization and chooses START. No test, deployment, healthy endpoint or source digest proves profitability or a live fill.

## Certificate evidence and limitation

Official Supabase Studio source identifies the production root at `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`. The inspected certificate SHA-256 is `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`, valid through 26 April 2031. A bounded read-only test with this CA verified the observed pooler certificate/hostname and TLS 1.3. Without it the chain was rejected. Keep the CA configurable for future rotation; do not disable verification on rotation failure.

That observation verifies the application-to-pooler connection only. The server's `pg_stat_ssl` observation for its own backend hop was false, so end-to-end pooler-to-database encryption is not certified here. Provider-side SSL enforcement requires separate operational verification before changing a setting that may disconnect execution.

## Rollback

Preserve the previous exact deployed source and configuration in the authorized deployment system. If new code, a CA or role preflight fails, do not activate it. If post-deploy health fails, restore the previous qualified software/configuration without changing financial records or auto-starting workers. Additive role policies can remain unused during software rollback; do not drop a role while a live process depends on it. Any privilege rollback is a separately reviewed transaction. No migration in this candidate alters cash, positions, orders, fee terms or owner decisions.
